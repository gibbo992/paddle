"""Finding candidate trader agents on Moltbook.

Discovery deliberately does *not* rank agents by anything Moltbook reports --
not karma, not leaderboard position, and certainly not self-reported returns.
Those are all cheap to fake and heavily survivorship-biased. Discovery's only
job is to widen the funnel; `scoring.reputation` decides who is any good, from
forward-tested outcomes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable, Sequence

from ..models import AgentProfile, utcnow
from ..store import Store
from .client import MoltbookClient, MoltbookError, RawPost

log = logging.getLogger(__name__)

# Moltbook's search is semantic rather than keyword-based, so these are
# written as descriptions of the *kind of post* we want, not as keywords.
DEFAULT_QUERIES: tuple[str, ...] = (
    "an agent describing a trade they just entered, with entry price and stop loss",
    "an agent announcing they closed a position and took profit or got stopped out",
    "agent sharing their current portfolio positions and performance",
    "going long or short a specific ticker right now",
)


@dataclass
class DiscoveryResult:
    posts: list[RawPost]
    new_agents: int
    skipped_seen: int


class Discovery:
    def __init__(self, client: MoltbookClient, store: Store) -> None:
        self.client = client
        self.store = store

    def sweep(
        self,
        submolts: Sequence[str] | None = None,
        queries: Sequence[str] = DEFAULT_QUERIES,
        limit_per_source: int = 50,
        use_search: bool = True,
    ) -> DiscoveryResult:
        """Collect unseen posts from submolts and searches, register authors."""
        collected: dict[str, RawPost] = {}

        for post in self.client.iter_posts(submolts, limit_per_submolt=limit_per_source):
            collected.setdefault(post.post_id, post)

        if use_search:
            for query in queries:
                try:
                    # Search caps at 50 server-side.
                    for post in self.client.search_posts(query, limit=min(limit_per_source, 50)):
                        collected.setdefault(post.post_id, post)
                except MoltbookError as exc:
                    log.warning("search %r failed: %s", query, exc)

        fresh: list[RawPost] = []
        skipped = 0
        for post in collected.values():
            if self.store.is_post_seen(post.post_id):
                skipped += 1
                continue
            fresh.append(post)

        new_agents = self._register_agents(fresh)
        return DiscoveryResult(posts=fresh, new_agents=new_agents, skipped_seen=skipped)

    def _register_agents(self, posts: Iterable[RawPost]) -> int:
        now = utcnow()
        new = 0
        for post in posts:
            existing = self.store.get_agent(post.agent_id)
            if existing is None:
                new += 1
                profile = AgentProfile(
                    agent_id=post.agent_id,
                    handle=post.agent_handle,
                    first_seen=post.created_at,
                    last_seen=now,
                    submolts=(post.submolt,) if post.submolt else (),
                    claimed_karma=post.score,
                )
            else:
                submolts = tuple(
                    sorted(set(existing.submolts) | ({post.submolt} if post.submolt else set()))
                )
                profile = AgentProfile(
                    agent_id=existing.agent_id,
                    handle=post.agent_handle or existing.handle,
                    first_seen=existing.first_seen,
                    last_seen=now,
                    submolts=submolts,
                    claimed_karma=max(existing.claimed_karma, post.score),
                    claimed_pnl_pct=existing.claimed_pnl_pct,
                )
            self.store.upsert_agent(profile)
        return new

    def fetch_profile_karma(self, handle: str) -> int | None:
        """Look up an agent's karma. Recorded for reference only.

        Moltbook exposes no leaderboard endpoint, and karma would be the wrong
        input anyway: it measures posting popularity, not trading skill, and a
        confident wrong call farms upvotes just as well as a right one.
        """
        try:
            payload = self.client.request("profile", params={"name": handle})
        except MoltbookError as exc:
            log.warning("profile lookup for %s failed: %s", handle, exc)
            return None
        agent = payload.get("agent") if isinstance(payload, dict) else None
        if isinstance(agent, dict) and "karma" in agent:
            try:
                return int(agent["karma"])
            except (TypeError, ValueError):
                return None
        return None
