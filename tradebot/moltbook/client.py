"""Moltbook HTTP client.

Written defensively on purpose. Moltbook's API is young and its exact route
and envelope shapes are not pinned down here, so:

  * every endpoint path lives in config, not in this file;
  * `verify()` probes the live API and reports which configured routes answer,
    so the operator finds out from the server rather than from a silent
    zero-results run;
  * post fields are read through an alias table, so a `body` vs `content` vs
    `text` difference degrades to "field missing" rather than a crash.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterator, Sequence

import httpx

from ..config import MoltbookConfig
from ..models import utcnow

log = logging.getLogger(__name__)


class MoltbookError(RuntimeError):
    pass


class MoltbookAuthError(MoltbookError):
    pass


@dataclass(frozen=True)
class RawPost:
    """A Moltbook post normalised to the handful of fields we need."""

    post_id: str
    agent_id: str
    agent_handle: str
    submolt: str
    title: str
    body: str
    created_at: datetime
    score: int = 0
    url: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def text(self) -> str:
        return f"{self.title}\n\n{self.body}".strip()


# Field-name aliases, most-preferred first. Moltbook deployments and mirrors
# disagree on these; trying several beats hardcoding one guess.
_ALIASES: dict[str, Sequence[str]] = {
    "post_id": ("id", "post_id", "uuid", "slug"),
    "agent_id": ("agent_id", "author_id", "user_id", "authorId"),
    "agent_handle": ("agent", "author", "username", "handle", "author_name", "agent_name"),
    "submolt": ("submolt", "community", "sub", "submolt_name", "channel"),
    "title": ("title", "subject", "headline"),
    "body": ("body", "content", "text", "selftext", "description"),
    "created_at": ("created_at", "created", "timestamp", "posted_at", "createdAt", "time"),
    "score": ("score", "upvotes", "votes", "karma", "points"),
    "url": ("url", "permalink", "link"),
}


def _dig(data: Any, dotted: str) -> Any:
    """Follow a dotted path (`data.posts`), tolerating missing links."""
    cur = data
    if not dotted:
        return cur
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def _first(raw: dict[str, Any], names: Sequence[str]) -> Any:
    for name in names:
        if name in raw and raw[name] not in (None, ""):
            return raw[name]
    return None


def _parse_ts(value: Any) -> datetime:
    if isinstance(value, (int, float)):
        # Heuristic: values past ~1e11 are milliseconds.
        seconds = value / 1000.0 if value > 1e11 else float(value)
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    if isinstance(value, str):
        text = value.strip().replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(text)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return utcnow()


def coerce_post(raw: dict[str, Any], default_submolt: str = "") -> RawPost | None:
    """Map an arbitrary post payload onto `RawPost`, or None if unusable."""
    if not isinstance(raw, dict):
        return None
    # Some APIs wrap each item, e.g. {"kind": "post", "data": {...}}.
    if "data" in raw and isinstance(raw["data"], dict) and "id" not in raw:
        raw = raw["data"]

    post_id = _first(raw, _ALIASES["post_id"])
    if post_id is None:
        return None

    author = _first(raw, _ALIASES["agent_handle"])
    if isinstance(author, dict):
        # Nested author object: {"author": {"id": ..., "username": ...}}
        agent_id = str(_first(author, ("id", "agent_id", "uuid")) or "")
        handle = str(_first(author, ("username", "handle", "name")) or agent_id)
        # Moltbook's post payloads carry `author: {name: ...}` with no id, so
        # the name is the stable identity we have to track the agent by.
        agent_id = agent_id or handle
    else:
        handle = str(author or "")
        agent_id = str(_first(raw, _ALIASES["agent_id"]) or handle)

    if not agent_id and not handle:
        return None

    submolt = _first(raw, _ALIASES["submolt"]) or default_submolt
    if isinstance(submolt, dict):
        submolt = _first(submolt, ("name", "slug", "id")) or default_submolt

    return RawPost(
        post_id=str(post_id),
        agent_id=agent_id or handle,
        agent_handle=handle or agent_id,
        submolt=str(submolt),
        title=str(_first(raw, _ALIASES["title"]) or ""),
        body=str(_first(raw, _ALIASES["body"]) or ""),
        created_at=_parse_ts(_first(raw, _ALIASES["created_at"])),
        score=int(_first(raw, _ALIASES["score"]) or 0),
        url=str(_first(raw, _ALIASES["url"]) or ""),
        extra={k: v for k, v in raw.items() if k not in {"body", "content", "text"}},
    )


class RateLimiter:
    """Simple sliding-window limiter; Moltbook throttles aggressively."""

    def __init__(self, per_minute: int) -> None:
        self.per_minute = max(1, per_minute)
        self._hits: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                while self._hits and now - self._hits[0] > 60.0:
                    self._hits.popleft()
                if len(self._hits) < self.per_minute:
                    self._hits.append(now)
                    return
                wait = 60.0 - (now - self._hits[0]) + 0.01
            time.sleep(max(0.0, wait))


class MoltbookClient:
    def __init__(
        self,
        config: MoltbookConfig,
        client: httpx.Client | None = None,
        sleep: Any = time.sleep,
    ) -> None:
        self.config = config
        self.limiter = RateLimiter(config.requests_per_minute)
        self._sleep = sleep
        self._owns_client = client is None
        self._client = client or httpx.Client(
            base_url=config.base_url.rstrip("/"),
            timeout=config.timeout_seconds,
            follow_redirects=True,
        )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "MoltbookClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ------------------------------------------------------------------ HTTP

    def _auth_host_allowed(self) -> bool:
        """Only ever attach the API key to Moltbook itself.

        Moltbook's own guidance is blunt about this and it is right: the key
        is the agent's identity, and anything that persuades the bot to send
        it elsewhere is an impersonation attack. Since `base_url` is
        operator-editable config, this is checked at request time rather than
        assumed.
        """
        host = (httpx.URL(self.config.base_url).host or "").lower()
        return host == "www.moltbook.com" or host.endswith(".moltbook.com")

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "User-Agent": self.config.user_agent,
        }
        if key := self.config.api_key():
            if self._auth_host_allowed():
                headers["Authorization"] = f"Bearer {key}"
            else:
                log.error(
                    "refusing to send the Moltbook API key to %s -- it is only "
                    "ever sent to www.moltbook.com. Fix moltbook.base_url.",
                    self.config.base_url,
                )
        return headers

    def _path(self, name: str, **fmt: Any) -> str:
        template = self.config.endpoints.get(name)
        if not template:
            raise MoltbookError(
                f"no endpoint configured for '{name}'; add moltbook.endpoints.{name} to config.yaml"
            )
        try:
            return template.format(**fmt)
        except KeyError as exc:
            raise MoltbookError(f"endpoint '{name}' needs parameter {exc}") from exc

    def request(
        self, name: str, params: dict[str, Any] | None = None, **fmt: Any
    ) -> Any:
        """GET a configured endpoint, with rate limiting and retries."""
        path = self._path(name, **fmt)
        last_error: Exception | None = None

        for attempt in range(self.config.max_retries + 1):
            self.limiter.acquire()
            try:
                response = self._client.get(
                    path, params=params or {}, headers=self._headers()
                )
            except httpx.HTTPError as exc:
                last_error = exc
                self._backoff(attempt)
                continue

            if response.status_code in (401, 403):
                raise MoltbookAuthError(
                    f"Moltbook rejected credentials ({response.status_code}) for {path}. "
                    f"Check ${self.config.api_key_env}."
                )
            if response.status_code == 429:
                retry_after = float(response.headers.get("retry-after", 0) or 0)
                self._sleep(retry_after or self._backoff_delay(attempt))
                last_error = MoltbookError("rate limited")
                continue
            if response.status_code >= 500:
                last_error = MoltbookError(f"server error {response.status_code}")
                self._backoff(attempt)
                continue
            if response.status_code >= 400:
                raise MoltbookError(
                    f"{response.status_code} from {path}: {response.text[:200]}"
                )

            try:
                return response.json()
            except ValueError as exc:
                raise MoltbookError(f"non-JSON response from {path}") from exc

        raise MoltbookError(f"giving up on {path} after retries: {last_error}")

    def post(self, name: str, body: dict[str, Any], **fmt: Any) -> Any:
        """POST to a configured endpoint. Used by registration."""
        path = self._path(name, **fmt)
        self.limiter.acquire()
        try:
            response = self._client.post(path, json=body, headers=self._headers())
        except httpx.HTTPError as exc:
            raise MoltbookError(f"POST {path} failed: {exc}") from exc

        if response.status_code in (401, 403):
            raise MoltbookAuthError(f"{response.status_code} from {path}: {response.text[:200]}")
        if response.status_code >= 400:
            raise MoltbookError(f"{response.status_code} from {path}: {response.text[:300]}")
        try:
            return response.json()
        except ValueError as exc:
            raise MoltbookError(f"non-JSON response from {path}") from exc

    def register(self, name: str, bio: str = "", **extra: Any) -> dict[str, Any]:
        """Register this bot as a Moltbook agent.

        Moltbook's documented flow returns an API key plus a claim URL and
        verification code that a *human* completes in a browser -- the account
        is not usable until that step is done by hand, which is the intended
        design and not something to work around.
        """
        body: dict[str, Any] = {"name": name, "description": bio, **extra}
        payload = self.post("register", body)
        # Documented shape is {"agent": {api_key, claim_url, verification_code}};
        # the generic wrapper is {"success", "data"}. Accept either.
        record: Any = payload
        for key in ("agent", "data"):
            if isinstance(record, dict) and isinstance(record.get(key), dict):
                record = record[key]
                break
        if not isinstance(record, dict):
            raise MoltbookError(f"unexpected registration response: {payload!r}")
        return {
            "api_key": _first(record, ("api_key", "apiKey", "token", "key")),
            "claim_url": _first(record, ("claim_url", "claimUrl", "url", "claim")),
            "verification_code": _first(
                record, ("verification_code", "verificationCode", "code")
            ),
            "agent_id": _first(record, ("agent_id", "agentId", "id")),
            "raw": record,
        }

    def _backoff_delay(self, attempt: int) -> float:
        return min(30.0, (2**attempt)) + random.uniform(0, 0.5)

    def _backoff(self, attempt: int) -> None:
        self._sleep(self._backoff_delay(attempt))

    # ------------------------------------------------------------- retrieval

    def _extract_items(self, payload: Any) -> list[dict[str, Any]]:
        """Find the list of records in a response envelope."""
        configured = self.config.response_paths.get("items", "")
        for path in (
            configured,
            "posts",          # GET /posts, GET /feed
            "results",        # GET /search
            "data.posts",
            "data.results",
            "data.items",
            "items",
            "submolts",
            "data",
            "",
        ):
            found = _dig(payload, path)
            if isinstance(found, list):
                return [x for x in found if isinstance(x, dict)]
        return []

    def fetch_submolt_posts(
        self,
        submolt: str,
        limit: int = 50,
        cursor: str | None = None,
        sort: str = "new",
    ) -> tuple[list[RawPost], str | None]:
        """Newest-first by default: a stale trade call is worthless."""
        params: dict[str, Any] = {"limit": limit, "sort": sort}
        if cursor:
            params["cursor"] = cursor
        payload = self.request("submolt_posts", params=params, submolt=submolt)
        items = self._extract_items(payload)
        posts = [p for p in (coerce_post(i, submolt) for i in items) if p]
        next_cursor = _dig(payload, self.config.response_paths.get("next_cursor", ""))
        return posts, (str(next_cursor) if next_cursor else None)

    def fetch_feed(self, limit: int = 50, sort: str = "new") -> list[RawPost]:
        payload = self.request("feed", params={"limit": limit, "sort": sort})
        return [p for p in (coerce_post(i) for i in self._extract_items(payload)) if p]

    def fetch_posts(
        self, limit: int = 50, sort: str = "new", submolt: str | None = None
    ) -> list[RawPost]:
        params: dict[str, Any] = {"limit": limit, "sort": sort}
        if submolt:
            params["submolt"] = submolt
        payload = self.request("posts", params=params)
        return [p for p in (coerce_post(i, submolt or "") for i in self._extract_items(payload)) if p]

    def search_posts(
        self, query: str, limit: int = 20, kind: str = "all"
    ) -> list[RawPost]:
        """Moltbook search is semantic, so natural-language queries work best.

        `kind="all"` includes comments, which carry plenty of trade talk --
        an agent's follow-up comment is often where the exit gets announced.
        """
        payload = self.request(
            "search", params={"q": query, "limit": min(limit, 50), "type": kind}
        )
        return [p for p in (coerce_post(i) for i in self._extract_items(payload)) if p]

    def iter_posts(
        self, submolts: Sequence[str] | None = None, limit_per_submolt: int = 50
    ) -> Iterator[RawPost]:
        """Yield posts across the configured submolts, skipping dead routes.

        A submolt that errors is logged and skipped rather than aborting the
        whole sweep -- one renamed community shouldn't stop the bot.
        """
        for submolt in submolts or self.config.submolts:
            try:
                posts, _ = self.fetch_submolt_posts(submolt, limit=limit_per_submolt)
            except MoltbookAuthError:
                raise
            except MoltbookError as exc:
                log.warning("skipping submolt %s: %s", submolt, exc)
                continue
            yield from posts

    # ---------------------------------------------------------- verification

    def verify(self) -> dict[str, str]:
        """Probe every configured endpoint and report what the server says.

        Returns a name -> status string map. This exists because the endpoint
        paths are best-effort defaults: run `tradebot verify-api` once against
        the live API and correct config.yaml from the output.
        """
        probes: dict[str, dict[str, Any]] = {
            "me": {},
            "status": {},
            "home": {},
            "posts": {"params": {"limit": 1, "sort": "new"}},
            "feed": {"params": {"limit": 1, "sort": "new"}},
            "submolts": {},
            "search": {"params": {"q": "trading", "limit": 1, "type": "posts"}},
        }
        for submolt in self.config.submolts[:1]:
            probes["submolt_posts"] = {
                "params": {"limit": 1, "sort": "new"},
                "fmt": {"submolt": submolt},
            }

        results: dict[str, str] = {}
        for name in self.config.endpoints:
            spec = probes.get(name)
            if spec is None:
                results[name] = "skipped (needs a concrete id to probe)"
                continue
            try:
                payload = self.request(
                    name, params=spec.get("params"), **spec.get("fmt", {})
                )
            except MoltbookAuthError as exc:
                results[name] = f"AUTH FAILED: {exc}"
            except MoltbookError as exc:
                results[name] = f"FAILED: {exc}"
            else:
                count = len(self._extract_items(payload))
                keys = sorted(payload)[:6] if isinstance(payload, dict) else []
                results[name] = f"ok ({count} items; top-level keys: {keys})"
        return results
