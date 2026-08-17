"""Reputation must come from outcomes, not from what agents say about themselves."""

from __future__ import annotations

from datetime import timedelta

import pytest

from tradebot.config import ReputationConfig
from tradebot.models import AgentProfile, agent_book, utcnow
from tradebot.scoring.reputation import NEUTRAL_PRIOR, ReputationScorer, max_drawdown_pct
from tests.conftest import make_trade


@pytest.fixture
def scorer():
    return ReputationScorer(ReputationConfig(prior_strength=10.0, min_track_record=3))


def test_no_history_means_neutral_and_untrusted(scorer):
    score = scorer.score_trades("a1", [], 10_000.0)
    assert score.reputation == NEUTRAL_PRIOR
    assert score.sample_size == 0
    assert not score.is_trusted


def test_unproven_agent_sits_below_the_trust_line(scorer):
    """The prior is deliberately sceptical: prove it before we size up."""
    assert NEUTRAL_PRIOR < 0.5


def test_claimed_pnl_never_moves_the_score(store, scorer):
    """The whole design rests on this: self-reported numbers are inert."""
    now = utcnow()
    for claim in (None, 9_999.0, -9_999.0):
        store.upsert_agent(
            AgentProfile(
                agent_id="liar",
                handle="liar",
                first_seen=now,
                last_seen=now,
                claimed_pnl_pct=claim,
                claimed_karma=1_000_000,
            )
        )
        trades = [make_trade(pnl=-50.0, agent_id="liar") for _ in range(10)]
        score = scorer.score_trades("liar", trades, 10_000.0)
        assert score.reputation < 0.5, "a losing agent must not be rescued by claims"


def test_profitable_agent_outranks_unprofitable(scorer):
    winner = [make_trade(pnl=120.0) for _ in range(20)]
    loser = [make_trade(pnl=-120.0) for _ in range(20)]
    assert scorer.score_trades("w", winner, 10_000.0).reputation > scorer.score_trades(
        "l", loser, 10_000.0
    ).reputation


def test_small_samples_are_shrunk_toward_the_prior(scorer):
    """Three lucky wins must not produce a high-conviction score."""
    few = scorer.score_trades("a", [make_trade(pnl=300.0) for _ in range(3)], 10_000.0)
    many = scorer.score_trades("b", [make_trade(pnl=300.0) for _ in range(80)], 10_000.0)
    assert few.reputation < many.reputation
    assert abs(few.reputation - NEUTRAL_PRIOR) < abs(many.reputation - NEUTRAL_PRIOR)


def test_drawdown_penalises_an_otherwise_good_record(scorer):
    steady = [make_trade(pnl=50.0, closed_offset_hours=i) for i in range(20)]
    # Same trades, but front-loaded with a deep hole.
    lumpy = [make_trade(pnl=-900.0, closed_offset_hours=30)] + [
        make_trade(pnl=100.0, closed_offset_hours=i) for i in range(20)
    ]
    assert scorer.score_trades("s", steady, 10_000.0).reputation > scorer.score_trades(
        "l", lumpy, 10_000.0
    ).reputation


def test_recent_results_outweigh_stale_ones():
    scorer = ReputationScorer(ReputationConfig(half_life_days=7.0, prior_strength=1.0))
    recently_good = [make_trade(pnl=200.0, closed_offset_hours=1) for _ in range(10)] + [
        make_trade(pnl=-200.0, closed_offset_hours=24 * 120) for _ in range(10)
    ]
    recently_bad = [make_trade(pnl=-200.0, closed_offset_hours=1) for _ in range(10)] + [
        make_trade(pnl=200.0, closed_offset_hours=24 * 120) for _ in range(10)
    ]
    assert scorer.score_trades("g", recently_good, 10_000.0).reputation > scorer.score_trades(
        "b", recently_bad, 10_000.0
    ).reputation


def test_eligibility_requires_both_sample_and_quality(scorer):
    good_small = scorer.score_trades("a", [make_trade(pnl=200.0) for _ in range(2)], 10_000.0)
    assert not scorer.is_eligible(good_small, min_track_record=0), "sample too small"

    losing_large = scorer.score_trades("b", [make_trade(pnl=-200.0) for _ in range(50)], 10_000.0)
    assert not scorer.is_eligible(losing_large, min_track_record=0), "reputation too low"

    assert not scorer.is_eligible(None, min_track_record=0)


def test_eligibility_floor_cannot_be_lowered_by_a_policy(scorer):
    """A policy asking for min_track_record=0 still gets the config floor."""
    score = scorer.score_trades("a", [make_trade(pnl=300.0) for _ in range(2)], 10_000.0)
    assert score.sample_size == 2
    assert not scorer.is_eligible(score, min_track_record=0)


def test_rescore_all_reads_each_agent_shadow_book(store, scorer):
    now = utcnow()
    store.upsert_agent(AgentProfile("good", "good", now, now))
    store.upsert_agent(AgentProfile("bad", "bad", now, now))
    for _ in range(15):
        store.save_trade(make_trade(pnl=100.0, book=agent_book("good"), agent_id="good"))
        store.save_trade(make_trade(pnl=-100.0, book=agent_book("bad"), agent_id="bad"))

    ranked = scorer.rescore_all(store, 10_000.0)
    assert [s.agent_id for s in ranked] == ["good", "bad"]
    assert store.get_agent_score("good").reputation > 0.5


def test_max_drawdown_of_a_monotonic_curve_is_zero():
    trades = [make_trade(pnl=10.0, closed_offset_hours=-i) for i in range(5)]
    assert max_drawdown_pct(trades, 10_000.0) == pytest.approx(0.0)


def test_max_drawdown_measures_peak_to_trough():
    trades = [
        make_trade(pnl=1_000.0, closed_offset_hours=-1),
        make_trade(pnl=-2_000.0, closed_offset_hours=-2),
    ]
    # peak 11k, trough 9k -> ~18.2%
    assert max_drawdown_pct(trades, 10_000.0) == pytest.approx(2_000 / 11_000 * 100, rel=1e-3)
