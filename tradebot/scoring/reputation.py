"""Reputation scoring.

The one rule this module exists to enforce: **an agent's reputation is
computed only from trades this bot shadow-executed on its own marks.** Never
from claimed PnL, karma, leaderboard rank, follower count, or how confident
the post sounded. On a network where every user is an AI agent, all of those
are free to manufacture, and the population you can see is the one that
survived -- the blown-up accounts stopped posting.

So: when TradeBot first sees an agent, it opens a shadow book for them and
follows every call they make with fake money. Only after the calls have
closed on independent prices does that agent's record mean anything, and even
then it is shrunk toward a sceptical prior until the sample is large.
"""

from __future__ import annotations

import math
from typing import Sequence

from ..config import ReputationConfig
from ..models import AgentScore, ClosedTrade, agent_book, utcnow
from ..store import Store

# Unproven agents sit here: below the 0.5 "trusted" line, so a brand new
# agent is never followed with real size until they have a track record.
NEUTRAL_PRIOR = 0.35


def max_drawdown_pct(trades: Sequence[ClosedTrade], starting_equity: float) -> float:
    """Peak-to-trough drawdown of the equity curve these trades imply."""
    if starting_equity <= 0:
        return 0.0
    equity = starting_equity
    peak = starting_equity
    worst = 0.0
    for trade in sorted(trades, key=lambda t: t.closed_at):
        equity += trade.net_pnl
        peak = max(peak, equity)
        if peak > 0:
            worst = max(worst, (peak - equity) / peak * 100.0)
    return worst


def _logistic(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


class ReputationScorer:
    def __init__(self, config: ReputationConfig) -> None:
        self.config = config

    def _weights(self, trades: Sequence[ClosedTrade]) -> list[float]:
        """Exponential recency decay -- last quarter beats last year."""
        now = utcnow()
        half_life = max(0.1, self.config.half_life_days)
        weights = []
        for trade in trades:
            age_days = max(0.0, (now - trade.closed_at).total_seconds() / 86400.0)
            weights.append(0.5 ** (age_days / half_life))
        return weights

    def score_trades(
        self, agent_id: str, trades: Sequence[ClosedTrade], starting_equity: float
    ) -> AgentScore:
        now = utcnow()
        if not trades:
            return AgentScore(
                agent_id=agent_id,
                reputation=NEUTRAL_PRIOR,
                sample_size=0,
                win_rate=0.0,
                profit_factor=0.0,
                avg_pnl_pct=0.0,
                max_drawdown_pct=0.0,
                expectancy=0.0,
                updated_at=now,
            )

        weights = self._weights(trades)
        total_weight = sum(weights) or 1e-9

        weighted_wins = sum(w for w, t in zip(weights, trades) if t.is_win)
        win_rate = weighted_wins / total_weight

        gross_win = sum(w * t.net_pnl for w, t in zip(weights, trades) if t.is_win)
        gross_loss = abs(
            sum(w * t.net_pnl for w, t in zip(weights, trades) if not t.is_win)
        )
        profit_factor = gross_win / gross_loss if gross_loss > 1e-9 else (
            float(gross_win > 0) * 10.0
        )

        avg_pnl_pct = sum(w * t.pnl_pct for w, t in zip(weights, trades)) / total_weight
        expectancy = sum(w * t.net_pnl for w, t in zip(weights, trades)) / total_weight
        drawdown = max_drawdown_pct(trades, starting_equity)

        # Raw quality: half from how often they are right, half from how much
        # they make when they are. Then penalised for the depth of the hole
        # they dig on the way -- a 60% win rate is worthless at a 40% drawdown.
        win_component = win_rate
        magnitude_component = _logistic(avg_pnl_pct / 2.0)
        drawdown_factor = max(0.2, 1.0 - drawdown / 50.0)
        raw = (0.4 * win_component + 0.6 * magnitude_component) * drawdown_factor

        # Shrink toward the sceptical prior until the sample is meaningful.
        n = len(trades)
        confidence = n / (n + self.config.prior_strength)
        reputation = NEUTRAL_PRIOR + (raw - NEUTRAL_PRIOR) * confidence

        return AgentScore(
            agent_id=agent_id,
            reputation=round(min(1.0, max(0.0, reputation)), 4),
            sample_size=n,
            win_rate=round(win_rate, 4),
            profit_factor=round(min(profit_factor, 999.0), 4),
            avg_pnl_pct=round(avg_pnl_pct, 4),
            max_drawdown_pct=round(drawdown, 4),
            expectancy=round(expectancy, 4),
            updated_at=now,
        )

    def rescore_all(self, store: Store, starting_equity: float) -> list[AgentScore]:
        """Recompute every tracked agent's score from their shadow book."""
        scores: list[AgentScore] = []
        for agent in store.list_agents():
            trades = store.closed_trades(agent_book(agent.agent_id))
            score = self.score_trades(agent.agent_id, trades, starting_equity)
            store.save_agent_score(score)
            scores.append(score)
        return sorted(scores, key=lambda s: s.reputation, reverse=True)

    def is_eligible(self, score: AgentScore | None, min_track_record: int) -> bool:
        """Has this agent earned the right to be copied with real size?"""
        if score is None:
            return False
        required = max(min_track_record, self.config.min_track_record)
        return score.sample_size >= required and score.reputation >= 0.5
