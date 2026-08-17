"""The safety interlock: training must never widen risk.

These are the most important tests in the suite. The self-improvement loop is
free to mutate the policy however it likes; what must hold, unconditionally,
is that a mutated policy is still inside the operator's configured limits.
"""

from __future__ import annotations

import random

import pytest

from tradebot.config import RiskLimits
from tradebot.improve.policy import BOUNDS, Policy
from tradebot.models import AgentScore, Side, utcnow
from tests.conftest import make_signal


def _score(reputation=0.8, n=20) -> AgentScore:
    return AgentScore(
        agent_id="agent-1",
        reputation=reputation,
        sample_size=n,
        win_rate=0.6,
        profit_factor=1.8,
        avg_pnl_pct=2.0,
        max_drawdown_pct=5.0,
        expectancy=10.0,
        updated_at=utcnow(),
    )


def test_seed_policy_is_within_limits(limits):
    policy = Policy.seed(limits)
    assert policy.risk_per_trade_pct <= limits.max_position_pct
    assert policy.max_positions <= limits.max_concurrent_positions
    assert policy.max_hold_hours <= limits.max_hold_hours


def test_mutation_never_escapes_risk_limits(limits):
    """1000 mutations, deliberately huge scale: none may exceed the limits."""
    rng = random.Random(1234)
    policy = Policy.seed(limits)

    for _ in range(1000):
        # Mutate from the *previous* child so drift compounds, and use a wild
        # scale to push hard against the clamp.
        policy = policy.mutate(rng, limits, scale=3.0)

        assert policy.risk_per_trade_pct <= limits.max_position_pct + 1e-9
        assert policy.max_positions <= limits.max_concurrent_positions
        assert policy.max_hold_hours <= limits.max_hold_hours + 1e-9
        assert limits.min_stop_loss_pct - 1e-9 <= policy.stop_loss_pct
        assert policy.stop_loss_pct <= limits.max_stop_loss_pct + 1e-9
        # A target below the stop would be a structurally losing trade.
        assert policy.take_profit_pct > policy.stop_loss_pct


def test_mutation_stays_inside_declared_bounds(limits):
    rng = random.Random(99)
    policy = Policy.seed(limits)
    for _ in range(300):
        policy = policy.mutate(rng, limits, scale=2.0)
        for name, (low, high) in BOUNDS.items():
            value = float(getattr(policy, name))
            assert low - 1e-9 <= value <= high + 1e-9, f"{name}={value} escaped {low}..{high}"


def test_clamp_tightens_a_reckless_policy():
    """A policy handed absurd values is pulled back, not accepted."""
    limits = RiskLimits(max_position_pct=2.0, max_concurrent_positions=2, max_hold_hours=24.0)
    reckless = Policy(
        policy_id="p-reckless",
        risk_per_trade_pct=99.0,
        stop_loss_pct=90.0,
        take_profit_pct=1.0,
        max_hold_hours=5000.0,
        max_positions=99,
    )
    safe = reckless.clamp(limits)

    assert safe.risk_per_trade_pct == 2.0
    assert safe.max_positions == 2
    assert safe.max_hold_hours == 24.0
    assert safe.stop_loss_pct <= limits.max_stop_loss_pct
    assert safe.take_profit_pct > safe.stop_loss_pct


def test_mutation_records_lineage(limits):
    rng = random.Random(7)
    parent = Policy.seed(limits)
    child = parent.mutate(rng, limits)
    assert child.parent_id == parent.policy_id
    assert child.generation == parent.generation + 1
    assert child.policy_id != parent.policy_id


# ---------------------------------------------------------------- decisions


def test_policy_rejects_unscored_agent(limits):
    policy = Policy.seed(limits)
    decision = policy.evaluate(make_signal(), None, 10_000.0)
    assert not decision.accepted
    assert "no score" in decision.reason


def test_policy_rejects_thin_track_record(limits):
    policy = Policy.seed(limits).clamp(limits)
    decision = policy.evaluate(make_signal(), _score(n=1), 10_000.0)
    assert not decision.accepted
    assert "track record" in decision.reason


def test_policy_rejects_low_reputation(limits):
    policy = Policy.seed(limits)
    decision = policy.evaluate(make_signal(), _score(reputation=0.1, n=50), 10_000.0)
    assert not decision.accepted
    assert "reputation" in decision.reason


def test_policy_rejects_stale_signal(limits):
    policy = Policy.seed(limits)
    signal = make_signal(age_minutes=policy.max_signal_age_minutes + 60)
    decision = policy.evaluate(signal, _score(), 10_000.0)
    assert not decision.accepted
    assert "old" in decision.reason


def test_policy_rejects_low_confidence(limits):
    policy = Policy.seed(limits)
    decision = policy.evaluate(make_signal(confidence=0.1), _score(), 10_000.0)
    assert not decision.accepted
    assert "confidence" in decision.reason


def test_policy_accepts_a_good_signal_and_sizes_it(limits):
    policy = Policy.seed(limits)
    decision = policy.evaluate(make_signal(), _score(), 10_000.0)
    assert decision.accepted
    assert 0 < decision.quantity <= 10_000.0 * limits.max_position_pct / 100.0
    assert decision.features["reputation"] == pytest.approx(0.8)


def test_sizing_scales_with_conviction(limits):
    policy = Policy.seed(limits)
    strong = policy.size_notional(make_signal(confidence=0.95), _score(0.9), 10_000.0)
    weak = policy.size_notional(make_signal(confidence=0.55), _score(0.55), 10_000.0)
    assert strong > weak


def test_stop_and_target_bracket_the_entry(limits):
    policy = Policy.seed(limits)
    assert policy.stop_for(100.0, Side.BUY.sign) < 100.0
    assert policy.target_for(100.0, Side.BUY.sign) > 100.0
    # Mirrored for a short.
    assert policy.stop_for(100.0, Side.SELL.sign) > 100.0
    assert policy.target_for(100.0, Side.SELL.sign) < 100.0


def test_params_round_trip(limits):
    policy = Policy.seed(limits)
    assert Policy.from_params(policy.to_params()) == policy
