"""The bot's behaviour, as data.

Everything TradeBot can learn is a number in this dataclass: who it will
copy, how sure it needs to be, how big it goes, when it gets out. Making the
behaviour a value rather than code is what lets the improvement loop run many
variants side by side and swap the winner in atomically.

`clamp()` is the safety interlock. A mutated policy is always clamped to the
operator's `RiskLimits` before it is allowed to trade, so no amount of
training can grow the bot's risk appetite past the config file.
"""

from __future__ import annotations

import math
import random
import uuid
from dataclasses import asdict, dataclass, field, replace
from typing import Any, Mapping

from ..config import RiskLimits
from ..models import AgentScore, Decision, TradeSignal

# Mutable parameters and the absolute range each may explore. The improvement
# loop may move within these; RiskLimits then tightens them further.
BOUNDS: dict[str, tuple[float, float]] = {
    "min_reputation": (0.30, 0.95),
    "min_track_record": (1, 60),
    "min_confidence": (0.20, 0.95),
    "max_signal_age_minutes": (5.0, 2880.0),
    "risk_per_trade_pct": (0.10, 100.0),
    "stop_loss_pct": (0.10, 100.0),
    "take_profit_pct": (0.50, 200.0),
    "max_hold_hours": (1.0, 2000.0),
    "max_positions": (1, 50),
    "reputation_weight": (0.0, 1.0),
}

INTEGER_PARAMS = {"min_track_record", "max_positions"}


@dataclass(frozen=True)
class Policy:
    policy_id: str
    generation: int = 0
    parent_id: str | None = None

    # Who to copy
    min_reputation: float = 0.50
    min_track_record: int = 8
    min_confidence: float = 0.55
    max_signal_age_minutes: float = 120.0

    # How much
    risk_per_trade_pct: float = 2.0
    reputation_weight: float = 0.5

    # When to get out
    stop_loss_pct: float = 8.0
    take_profit_pct: float = 16.0
    max_hold_hours: float = 72.0
    max_positions: int = 6

    submolt_weights: dict[str, float] = field(default_factory=dict)

    # ------------------------------------------------------------ lifecycle

    @classmethod
    def seed(cls, limits: RiskLimits) -> "Policy":
        """The starting champion: deliberately conservative."""
        return cls(
            policy_id=f"p-{uuid.uuid4().hex[:10]}",
            generation=0,
            risk_per_trade_pct=min(2.0, limits.max_position_pct),
            stop_loss_pct=min(8.0, limits.max_stop_loss_pct),
            max_hold_hours=min(72.0, limits.max_hold_hours),
            max_positions=min(6, limits.max_concurrent_positions),
        ).clamp(limits)

    def to_params(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_params(cls, params: Mapping[str, Any]) -> "Policy":
        known = {k: v for k, v in params.items() if k in cls.__dataclass_fields__}
        return cls(**known)

    # -------------------------------------------------------------- safety

    def clamp(self, limits: RiskLimits) -> "Policy":
        """Pull every parameter inside both BOUNDS and the operator's limits."""
        values: dict[str, Any] = {}
        for name, (low, high) in BOUNDS.items():
            current = getattr(self, name)
            clamped = min(max(current, low), high)
            values[name] = int(round(clamped)) if name in INTEGER_PARAMS else float(clamped)

        values["risk_per_trade_pct"] = min(
            values["risk_per_trade_pct"], limits.max_position_pct
        )
        values["stop_loss_pct"] = min(
            max(values["stop_loss_pct"], limits.min_stop_loss_pct),
            limits.max_stop_loss_pct,
        )
        values["max_hold_hours"] = min(values["max_hold_hours"], limits.max_hold_hours)
        values["max_positions"] = min(
            values["max_positions"], limits.max_concurrent_positions
        )
        # A target below the stop is a guaranteed loser; keep them ordered.
        values["take_profit_pct"] = max(
            values["take_profit_pct"], values["stop_loss_pct"] * 1.1
        )
        return replace(self, **values)

    # ------------------------------------------------------------ mutation

    def mutate(
        self,
        rng: random.Random,
        limits: RiskLimits,
        scale: float = 0.25,
        hints: Mapping[str, float] | None = None,
    ) -> "Policy":
        """Produce a challenger.

        `hints` (from `improve.attribution`) bias the walk in the direction
        the closed trades suggest; the random term keeps exploring so the loop
        cannot get stuck on a locally-good-but-wrong setting.
        """
        hints = hints or {}
        values: dict[str, Any] = {}
        for name, (low, high) in BOUNDS.items():
            current = float(getattr(self, name))
            span = high - low
            drift = hints.get(name, 0.0) * scale * span * 0.5
            noise = rng.gauss(0.0, scale) * span * 0.1
            proposed = current + drift + noise
            values[name] = (
                int(round(proposed)) if name in INTEGER_PARAMS else float(proposed)
            )

        child = replace(
            self,
            policy_id=f"p-{uuid.uuid4().hex[:10]}",
            generation=self.generation + 1,
            parent_id=self.policy_id,
            submolt_weights=dict(self.submolt_weights),
            **values,
        )
        return child.clamp(limits)

    # ------------------------------------------------------------ decisions

    def submolt_weight(self, submolt: str) -> float:
        return float(self.submolt_weights.get(submolt, 1.0))

    def evaluate(
        self, signal: TradeSignal, score: AgentScore | None, equity: float
    ) -> Decision:
        """Decide whether -- and how big -- to copy one signal."""
        features = self.features_for(signal, score)

        if score is None:
            return Decision(signal.signal_id, self.policy_id, False, "agent has no score yet", features=features)
        if score.sample_size < self.min_track_record:
            return Decision(
                signal.signal_id,
                self.policy_id,
                False,
                f"track record {score.sample_size} < {self.min_track_record}",
                features=features,
            )
        if score.reputation < self.min_reputation:
            return Decision(
                signal.signal_id,
                self.policy_id,
                False,
                f"reputation {score.reputation:.2f} < {self.min_reputation:.2f}",
                features=features,
            )
        if signal.confidence < self.min_confidence:
            return Decision(
                signal.signal_id,
                self.policy_id,
                False,
                f"confidence {signal.confidence:.2f} < {self.min_confidence:.2f}",
                features=features,
            )
        if signal.age_minutes > self.max_signal_age_minutes:
            return Decision(
                signal.signal_id,
                self.policy_id,
                False,
                f"signal is {signal.age_minutes:.0f}m old, limit {self.max_signal_age_minutes:.0f}m",
                features=features,
            )

        notional = self.size_notional(signal, score, equity)
        if notional <= 0:
            return Decision(signal.signal_id, self.policy_id, False, "sized to zero", features=features)

        return Decision(
            signal_id=signal.signal_id,
            policy_id=self.policy_id,
            accepted=True,
            reason="accepted",
            quantity=notional,  # notional; the risk manager converts to units
            features=features,
        )

    def size_notional(
        self, signal: TradeSignal, score: AgentScore, equity: float
    ) -> float:
        """Base size, scaled by how much we believe this particular call.

        `reputation_weight` interpolates between flat sizing (0.0) and fully
        conviction-weighted sizing (1.0), and is itself one of the parameters
        the loop tunes.
        """
        base = equity * self.risk_per_trade_pct / 100.0
        quality = (
            score.reputation * signal.confidence * self.submolt_weight(signal.submolt)
        )
        quality = min(1.0, max(0.0, quality))
        multiplier = (1.0 - self.reputation_weight) + self.reputation_weight * quality
        return max(0.0, base * multiplier)

    def stop_for(self, entry: float, side_sign: int) -> float:
        return entry * (1 - side_sign * self.stop_loss_pct / 100.0)

    def target_for(self, entry: float, side_sign: int) -> float:
        return entry * (1 + side_sign * self.take_profit_pct / 100.0)

    def features_for(
        self, signal: TradeSignal, score: AgentScore | None
    ) -> dict[str, float]:
        """The feature snapshot attribution later learns from."""
        return {
            "reputation": float(score.reputation) if score else 0.0,
            "track_record": float(score.sample_size) if score else 0.0,
            "agent_win_rate": float(score.win_rate) if score else 0.0,
            "confidence": float(signal.confidence),
            "signal_age_minutes": float(signal.age_minutes),
            "submolt_weight": self.submolt_weight(signal.submolt),
            "has_stop": 1.0 if signal.claimed_stop else 0.0,
            "has_target": 1.0 if signal.claimed_target else 0.0,
            "is_llm_extracted": 1.0 if signal.extractor == "claude" else 0.0,
            "risk_per_trade_pct": self.risk_per_trade_pct,
            "stop_loss_pct": self.stop_loss_pct,
            "take_profit_pct": self.take_profit_pct,
            "max_hold_hours": self.max_hold_hours,
        }

    def describe(self) -> str:
        return (
            f"{self.policy_id} gen{self.generation} "
            f"rep>={self.min_reputation:.2f} conf>={self.min_confidence:.2f} "
            f"n>={self.min_track_record} risk={self.risk_per_trade_pct:.2f}% "
            f"sl={self.stop_loss_pct:.1f}% tp={self.take_profit_pct:.1f}% "
            f"hold<={self.max_hold_hours:.0f}h max_pos={self.max_positions}"
        )


def distance(a: Policy, b: Policy) -> float:
    """Normalised parameter distance -- used to keep challengers diverse."""
    total = 0.0
    for name, (low, high) in BOUNDS.items():
        span = (high - low) or 1.0
        total += ((float(getattr(a, name)) - float(getattr(b, name))) / span) ** 2
    return math.sqrt(total)
