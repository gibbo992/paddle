"""Learning which knobs are hurting.

Attribution reads the feature snapshot recorded on every closed trade and
asks, per feature: did trades on the high side of this feature do better or
worse than trades on the low side? The answer becomes a directional hint in
[-1, 1] that biases the next round of policy mutations, so the search is
guided by outcomes instead of being a blind random walk.

The maths is deliberately simple -- a median split and a pooled-deviation
effect size. With the sample sizes a copy-trading bot actually accumulates
(tens to hundreds of trades), anything fancier would be fitting noise.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import Mapping, Sequence

from ..models import ClosedTrade, CloseReason

# feature name -> policy parameter it should push on.
# Both threshold kinds take the same sign: if high values of the feature earn
# more, push the parameter up (admit more of that / allow more of it).
FEATURE_TO_PARAM: dict[str, str] = {
    "reputation": "min_reputation",
    "confidence": "min_confidence",
    "track_record": "min_track_record",
    "signal_age_minutes": "max_signal_age_minutes",
    "stop_loss_pct": "stop_loss_pct",
    "take_profit_pct": "take_profit_pct",
    "risk_per_trade_pct": "risk_per_trade_pct",
    "max_hold_hours": "max_hold_hours",
}

MIN_SAMPLES = 12


@dataclass
class Attribution:
    hints: dict[str, float] = field(default_factory=dict)
    effects: dict[str, float] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    sample_size: int = 0

    def describe(self) -> str:
        if not self.hints:
            return f"no attribution yet (n={self.sample_size}, need {MIN_SAMPLES})"
        ranked = sorted(self.hints.items(), key=lambda kv: -abs(kv[1]))
        parts = [f"{name}{'+' if hint > 0 else ''}{hint:.2f}" for name, hint in ranked]
        return f"n={self.sample_size}: " + ", ".join(parts)


def _effect_size(values: Sequence[float], pnls: Sequence[float]) -> float | None:
    """Median-split effect size of `values` on `pnls`, clipped to [-1, 1]."""
    if len(values) < MIN_SAMPLES:
        return None
    midpoint = statistics.median(values)
    high = [p for v, p in zip(values, pnls) if v > midpoint]
    low = [p for v, p in zip(values, pnls) if v <= midpoint]
    if len(high) < 3 or len(low) < 3:
        return None  # feature is constant or near-constant: nothing to learn

    spread = statistics.pstdev(list(pnls)) or 1.0
    effect = (statistics.fmean(high) - statistics.fmean(low)) / spread
    return max(-1.0, min(1.0, effect))


def attribute(trades: Sequence[ClosedTrade]) -> Attribution:
    """Turn a pile of closed trades into directional hints for mutation."""
    result = Attribution(sample_size=len(trades))
    if len(trades) < MIN_SAMPLES:
        return result

    pnls = [t.pnl_pct for t in trades]

    for feature, param in FEATURE_TO_PARAM.items():
        values = [t.features.get(feature) for t in trades]
        if any(v is None for v in values):
            continue
        effect = _effect_size([float(v) for v in values], pnls)  # type: ignore[arg-type]
        if effect is None:
            continue
        result.effects[feature] = round(effect, 4)
        result.hints[param] = round(effect, 4)

    _exit_heuristics(trades, result)
    return result


def _exit_heuristics(trades: Sequence[ClosedTrade], result: Attribution) -> None:
    """Exit-reason signals that a median split cannot see."""
    total = len(trades)
    by_reason: dict[CloseReason, list[ClosedTrade]] = {}
    for trade in trades:
        by_reason.setdefault(trade.reason, []).append(trade)

    stopped = by_reason.get(CloseReason.STOP_LOSS, [])
    took_profit = by_reason.get(CloseReason.TAKE_PROFIT, [])
    timed_out = by_reason.get(CloseReason.MAX_HOLD, [])

    # Getting stopped out far more often than reaching target usually means
    # the stop is inside the noise, not that the calls were wrong.
    if total >= MIN_SAMPLES and len(stopped) > 0.5 * total and len(stopped) > 2 * len(took_profit):
        result.hints["stop_loss_pct"] = _blend(result.hints.get("stop_loss_pct"), 0.5)
        result.notes.append(
            f"stopped out on {len(stopped)}/{total} trades vs {len(took_profit)} targets "
            "-- widening the stop"
        )

    # Positions expiring flat means we are holding dead trades too long.
    if timed_out and len(timed_out) > 0.35 * total:
        mean_pnl = statistics.fmean(t.pnl_pct for t in timed_out)
        if mean_pnl <= 0:
            result.hints["max_hold_hours"] = _blend(
                result.hints.get("max_hold_hours"), -0.5
            )
            result.notes.append(
                f"{len(timed_out)}/{total} trades expired at max hold averaging "
                f"{mean_pnl:.2f}% -- shortening the hold"
            )


def _blend(existing: float | None, heuristic: float) -> float:
    if existing is None:
        return heuristic
    return round(max(-1.0, min(1.0, (existing + heuristic) / 2.0)), 4)


def lessons_from(trades: Sequence[ClosedTrade], limit: int = 10) -> list[str]:
    """Human-readable post-mortems, fed back into the signal-parsing prompt.

    This is the qualitative half of the loop: the numeric half retunes the
    policy, while these sentences retune how the extractor reads posts.
    """
    losers = sorted((t for t in trades if not t.is_win), key=lambda t: t.net_pnl)[:limit]
    lessons: list[str] = []
    for trade in losers:
        features = trade.features
        bits = [
            f"Copying {trade.agent_id} on {trade.symbol} ({trade.side.value}) lost "
            f"{abs(trade.pnl_pct):.1f}% and closed via {trade.reason.value}."
        ]
        if (conf := features.get("confidence")) is not None:
            bits.append(f"Extractor confidence was {conf:.2f}.")
        if (age := features.get("signal_age_minutes")) is not None and age > 60:
            bits.append(f"The post was already {age:.0f} minutes old when copied.")
        if not features.get("has_stop"):
            bits.append("The post named no stop.")
        lessons.append(" ".join(bits))
    return lessons


def summarise_by_agent(trades: Sequence[ClosedTrade]) -> Mapping[str, float]:
    """Mean net PnL% per agent -- used for reporting, not for sizing."""
    grouped: dict[str, list[float]] = {}
    for trade in trades:
        grouped.setdefault(trade.agent_id, []).append(trade.pnl_pct)
    return {agent: round(statistics.fmean(v), 4) for agent, v in grouped.items()}
