"""Champion / challenger promotion, attribution, and the promotion interlock."""

from __future__ import annotations

import random

import pytest

from tradebot.improve.attribution import attribute, lessons_from
from tradebot.improve.loop import (
    STATUS_CHALLENGER,
    STATUS_CHAMPION,
    STATUS_RETIRED,
    SelfImprovementLoop,
    bootstrap_win_probability,
)
from tradebot.improve.policy import Policy
from tradebot.models import MAIN_BOOK, CloseReason, policy_book
from tests.conftest import make_trade


# ------------------------------------------------------------- bootstrapping


def test_bootstrap_detects_a_clear_winner():
    rng = random.Random(1)
    p = bootstrap_win_probability([5.0] * 30, [-5.0] * 30, 500, rng)
    assert p > 0.95


def test_bootstrap_detects_a_clear_loser():
    rng = random.Random(1)
    p = bootstrap_win_probability([-5.0] * 30, [5.0] * 30, 500, rng)
    assert p < 0.05


def test_bootstrap_is_uncertain_on_identical_samples():
    rng = random.Random(1)
    sample = [1.0, -1.0, 2.0, -2.0, 0.5] * 6
    p = bootstrap_win_probability(sample, list(sample), 500, rng)
    assert 0.2 < p < 0.8


def test_bootstrap_without_a_champion_asks_if_profitable():
    rng = random.Random(1)
    assert bootstrap_win_probability([3.0] * 25, [], 500, rng) > 0.9
    assert bootstrap_win_probability([-3.0] * 25, [], 500, rng) < 0.1


def test_bootstrap_of_nothing_is_zero():
    assert bootstrap_win_probability([], [1.0], 100, random.Random(1)) == 0.0


# ---------------------------------------------------------------- population


def test_champion_is_seeded_once(store, config):
    loop = SelfImprovementLoop(store, config)
    first = loop.champion()
    assert loop.champion().policy_id == first.policy_id
    assert len(store.policies_by_status(STATUS_CHAMPION)) == 1


def test_challengers_are_spawned_to_fill_the_pool(store, config):
    loop = SelfImprovementLoop(store, config)
    champion, challengers = loop.ensure_population()
    assert len(challengers) == config.improvement.challengers
    for challenger in challengers:
        assert challenger.parent_id == champion.policy_id
        assert store.get_book(policy_book(challenger.policy_id)) is not None


def test_challengers_are_distinct(store, config):
    loop = SelfImprovementLoop(store, config)
    _, challengers = loop.ensure_population()
    ids = {c.policy_id for c in challengers}
    assert len(ids) == len(challengers)


def test_every_challenger_respects_risk_limits(store, config):
    """The interlock again, this time through the loop that creates them."""
    loop = SelfImprovementLoop(store, config)
    for _ in range(10):
        for challenger in loop.ensure_population()[1]:
            assert challenger.risk_per_trade_pct <= config.risk.max_position_pct
            assert challenger.max_positions <= config.risk.max_concurrent_positions
            assert challenger.max_hold_hours <= config.risk.max_hold_hours
            assert challenger.stop_loss_pct <= config.risk.max_stop_loss_pct
            store.set_policy_status(challenger.policy_id, STATUS_RETIRED)


# ----------------------------------------------------------------- promotion


def _seed_population(store, config):
    loop = SelfImprovementLoop(store, config)
    champion, challengers = loop.ensure_population()
    return loop, champion, challengers


def test_clearly_better_challenger_is_promoted(store, config):
    loop, champion, challengers = _seed_population(store, config)
    winner = challengers[0]

    for _ in range(20):
        store.save_trade(make_trade(pnl=-100.0, book=MAIN_BOOK))
        store.save_trade(make_trade(pnl=200.0, book=policy_book(winner.policy_id)))

    results = loop.evaluate()
    promoted = [r for r in results if r.decision == "promote"]
    assert len(promoted) == 1
    assert promoted[0].policy_id == winner.policy_id
    assert loop.champion().policy_id == winner.policy_id
    assert store.get_policy(champion.policy_id)["status"] == STATUS_RETIRED


def test_clearly_worse_challenger_is_retired(store, config):
    loop, _, challengers = _seed_population(store, config)
    loser = challengers[0]

    for _ in range(20):
        store.save_trade(make_trade(pnl=200.0, book=MAIN_BOOK))
        store.save_trade(make_trade(pnl=-200.0, book=policy_book(loser.policy_id)))

    results = loop.evaluate()
    verdict = next(r for r in results if r.policy_id == loser.policy_id)
    assert verdict.decision == "rejected"
    assert store.get_policy(loser.policy_id)["status"] == STATUS_RETIRED


def test_inconclusive_challenger_keeps_trading(store, config):
    """A challenger that is neither better nor worse must not be killed."""
    loop, _, challengers = _seed_population(store, config)
    tied = challengers[0]

    pattern = [3.0, -2.0, 1.5, -1.0, 2.0, -2.5]
    for i in range(len(pattern) * 4):
        value = pattern[i % len(pattern)]
        store.save_trade(make_trade(pnl=value * 10, book=MAIN_BOOK))
        store.save_trade(make_trade(pnl=value * 10, book=policy_book(tied.policy_id)))

    results = loop.evaluate()
    verdict = next(r for r in results if r.policy_id == tied.policy_id)
    assert verdict.decision == "inconclusive"
    assert store.get_policy(tied.policy_id)["status"] == STATUS_CHALLENGER


def test_challenger_below_min_trades_is_left_pending(store, config):
    loop, _, challengers = _seed_population(store, config)
    store.save_trade(make_trade(pnl=500.0, book=policy_book(challengers[0].policy_id)))
    results = loop.evaluate()
    assert next(r for r in results if r.policy_id == challengers[0].policy_id).decision == "pending"


def test_better_returns_do_not_buy_a_worse_drawdown(store, config):
    """Higher mean PnL is not enough if the path there is uglier."""
    loop, _, challengers = _seed_population(store, config)
    candidate = challengers[0]

    for i in range(20):
        store.save_trade(make_trade(pnl=10.0, book=MAIN_BOOK, closed_offset_hours=40 - i))
    # Same-ish mean, but via a deep hole first.
    store.save_trade(
        make_trade(pnl=-4_000.0, book=policy_book(candidate.policy_id), closed_offset_hours=50)
    )
    for i in range(20):
        store.save_trade(
            make_trade(pnl=400.0, book=policy_book(candidate.policy_id), closed_offset_hours=40 - i)
        )

    verdict = next(r for r in loop.evaluate() if r.policy_id == candidate.policy_id)
    if verdict.decision == "rejected":
        assert "drawdown" in verdict.detail or "win probability" in verdict.detail
    assert verdict.decision != "promote" or verdict.drawdown_delta <= (
        config.improvement.max_drawdown_regression_pct
    )


def test_promoted_policy_is_still_inside_risk_limits(store, config):
    loop, _, challengers = _seed_population(store, config)
    winner = challengers[0]
    for _ in range(20):
        store.save_trade(make_trade(pnl=-100.0, book=MAIN_BOOK))
        store.save_trade(make_trade(pnl=300.0, book=policy_book(winner.policy_id)))
    loop.evaluate()

    champion = loop.champion()
    assert champion.risk_per_trade_pct <= config.risk.max_position_pct
    assert champion.max_positions <= config.risk.max_concurrent_positions
    assert champion.max_hold_hours <= config.risk.max_hold_hours


def test_promotion_clears_the_old_generation(store, config):
    loop, _, challengers = _seed_population(store, config)
    winner = challengers[0]
    for _ in range(20):
        store.save_trade(make_trade(pnl=-100.0, book=MAIN_BOOK))
        store.save_trade(make_trade(pnl=300.0, book=policy_book(winner.policy_id)))
    loop.evaluate()
    # Siblings bred from the old champion are retired, not left running.
    assert all(p.policy_id == winner.policy_id for p in loop.challengers()) or not loop.challengers()


def test_evaluations_are_recorded_for_audit(store, config):
    loop, _, challengers = _seed_population(store, config)
    for _ in range(20):
        store.save_trade(make_trade(pnl=100.0, book=MAIN_BOOK))
        store.save_trade(make_trade(pnl=-100.0, book=policy_book(challengers[0].policy_id)))
    loop.evaluate()
    assert len(store.recent_evaluations()) >= 1


# --------------------------------------------------------------- attribution


def test_attribution_needs_a_minimum_sample():
    result = attribute([make_trade(pnl=10.0, features={"confidence": 0.9}) for _ in range(3)])
    assert result.hints == {}


def test_attribution_finds_the_helpful_feature():
    """High-confidence trades win, low-confidence lose -> raise the threshold."""
    trades = []
    for i in range(30):
        high = i % 2 == 0
        trades.append(
            make_trade(
                pnl=100.0 if high else -100.0,
                features={"confidence": 0.9 if high else 0.3},
            )
        )
    result = attribute(trades)
    assert result.hints["min_confidence"] > 0.3


def test_attribution_lowers_a_max_when_high_values_hurt():
    """Stale signals lose -> shorten the freshness window."""
    trades = []
    for i in range(30):
        stale = i % 2 == 0
        trades.append(
            make_trade(
                pnl=-100.0 if stale else 100.0,
                features={"signal_age_minutes": 600.0 if stale else 5.0},
            )
        )
    result = attribute(trades)
    assert result.hints["max_signal_age_minutes"] < -0.3


def test_attribution_ignores_a_constant_feature():
    trades = [make_trade(pnl=10.0 * (-1) ** i, features={"confidence": 0.7}) for i in range(30)]
    assert "min_confidence" not in attribute(trades).hints


def test_frequent_stop_outs_suggest_a_wider_stop():
    trades = [
        make_trade(pnl=-50.0, reason=CloseReason.STOP_LOSS, features={"confidence": 0.6})
        for _ in range(20)
    ]
    trades += [make_trade(pnl=100.0, reason=CloseReason.TAKE_PROFIT, features={"confidence": 0.6})]
    result = attribute(trades)
    assert result.hints.get("stop_loss_pct", 0) > 0
    assert any("stopped out" in note for note in result.notes)


def test_hints_feed_mutation_in_the_right_direction(config):
    """A positive hint should, on average, raise the parameter."""
    rng = random.Random(4)
    base = Policy.seed(config.risk)
    raised = [
        base.mutate(rng, config.risk, scale=0.3, hints={"min_confidence": 1.0}).min_confidence
        for _ in range(60)
    ]
    assert sum(raised) / len(raised) > base.min_confidence


def test_lessons_describe_losing_trades():
    trades = [
        make_trade(
            pnl=-200.0,
            agent_id="sloppy",
            reason=CloseReason.STOP_LOSS,
            features={"confidence": 0.6, "signal_age_minutes": 300.0, "has_stop": 0.0},
        )
    ]
    lessons = lessons_from(trades)
    assert len(lessons) == 1
    assert "sloppy" in lessons[0]
    assert "stop_loss" in lessons[0]
    assert "named no stop" in lessons[0]


def test_lessons_ignore_winners():
    assert lessons_from([make_trade(pnl=500.0) for _ in range(5)]) == []


def test_refresh_lessons_persists_them(store, config):
    loop = SelfImprovementLoop(store, config)
    store.save_trade(make_trade(pnl=-300.0, book=MAIN_BOOK, reason=CloseReason.STOP_LOSS))
    written = loop.refresh_lessons()
    assert written
    assert store.top_lessons(10)
