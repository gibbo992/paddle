"""End-to-end cycles against the simulated Moltbook."""

from __future__ import annotations

import dataclasses

import pytest

from tradebot.config import ImprovementConfig, Mode, TradingConfig
from tradebot.engine import Engine
from tradebot.execution.broker import LiveBrokerNotConfigured, PaperBroker
from tradebot.models import MAIN_BOOK, agent_book
from tradebot.signals import HybridExtractor, RuleExtractor
from tradebot.simulation import (
    SimulatedAgent,
    SimulatedMarket,
    SimulatedMoltbook,
    default_agents,
)
from tradebot.store import Store


def build_engine(config, store, cycles=60, seed=3, agents=None):
    market = SimulatedMarket(seed=seed, steps=cycles + 20)
    agents = agents or default_agents()
    engine = Engine(
        config,
        store,
        client=SimulatedMoltbook(market, agents, seed=seed),
        feed=market,
        extractor=HybridExtractor(RuleExtractor(market.now), None),
        clock=market.now,
    )
    return engine, market


def run(engine, market, cycles):
    reports = []
    for _ in range(cycles):
        reports.append(engine.run_cycle())
        market.advance()
    return reports


def test_cycle_runs_without_errors(config, store):
    engine, market = build_engine(config, store, cycles=20)
    reports = run(engine, market, 20)
    assert all(not r.errors for r in reports), [r.errors for r in reports if r.errors]
    assert sum(r.signals_new for r in reports) > 0


def test_posts_are_only_processed_once(config, store):
    engine, market = build_engine(config, store, cycles=15)
    run(engine, market, 15)
    post_ids = [row[0] for row in store.conn.execute("SELECT post_id FROM seen_posts")]
    assert len(post_ids) == len(set(post_ids))


def test_signals_are_persisted(config, store):
    engine, market = build_engine(config, store, cycles=20)
    run(engine, market, 20)
    assert store.recent_signals(500)


def test_every_agent_gets_a_shadow_book(config, store):
    engine, market = build_engine(config, store, cycles=20)
    run(engine, market, 20)
    for agent in store.list_agents():
        assert store.get_book(agent_book(agent.agent_id)) is not None


def test_main_book_only_copies_agents_past_the_eligibility_floor(config, store):
    """The core safety property of the copy logic, checked end to end."""
    engine, market = build_engine(config, store, cycles=80)
    run(engine, market, 80)

    floor = config.reputation.min_track_record
    main_trades = store.closed_trades(MAIN_BOOK)
    open_main = store.open_positions(MAIN_BOOK)

    for record in list(main_trades) + list(open_main):
        shadow = store.closed_trades(agent_book(record.agent_id))
        assert len(shadow) >= floor, (
            f"copied {record.agent_id} into the main book with only "
            f"{len(shadow)} forward-tested trades (floor {floor})"
        )


def test_reputation_separates_skilled_from_unskilled(config, store):
    """The claim the whole design rests on, tested against known skill."""
    agents = [
        SimulatedAgent("sharp", skill=0.9, post_rate=0.9, noise_rate=0.1),
        SimulatedAgent("useless", skill=0.0, post_rate=0.9, noise_rate=0.1),
    ]
    engine, market = build_engine(config, store, cycles=200, seed=5, agents=agents)
    run(engine, market, 200)

    sharp = store.get_agent_score("sharp")
    useless = store.get_agent_score("useless")
    assert sharp and useless
    assert sharp.sample_size > 10 and useless.sample_size > 10
    assert sharp.reputation > useless.reputation


def test_positions_are_closed_by_stops_targets_or_time(config, store):
    engine, market = build_engine(config, store, cycles=120)
    run(engine, market, 120)
    trades = store.closed_trades()
    assert trades
    reasons = {t.reason.value for t in trades}
    assert reasons & {"stop_loss", "take_profit", "max_hold"}


def test_no_position_outlives_the_hold_limit(config, store):
    engine, market = build_engine(config, store, cycles=100)
    run(engine, market, 100)
    now = market.now()
    for position in store.open_positions():
        age_hours = (now - position.opened_at).total_seconds() / 3600.0
        assert age_hours <= config.risk.max_hold_hours + 1e-6


def test_no_book_exceeds_the_position_cap(config, store):
    engine, market = build_engine(config, store, cycles=100)
    run(engine, market, 100)
    for book in store.list_books(active_only=False):
        if book.startswith("agent:"):
            continue  # the tracker book deliberately follows everything
        count = len(store.open_positions(book))
        assert count <= config.risk.max_concurrent_positions


def test_improvement_loop_maintains_a_challenger_pool(config, store):
    engine, market = build_engine(config, store, cycles=30)
    run(engine, market, 30)
    assert len(engine.improve.challengers()) <= config.improvement.challengers
    assert engine.improve.champion() is not None


def test_status_reports_without_crashing(config, store):
    engine, market = build_engine(config, store, cycles=10)
    run(engine, market, 10)
    status = engine.status()
    assert status["mode"] == "paper"
    assert "champion" in status


# --------------------------------------------------------------- live gating


def test_live_mode_without_confirmation_falls_back_to_paper(config, store):
    live_unconfirmed = dataclasses.replace(
        config,
        trading=dataclasses.replace(
            config.trading, mode=Mode.LIVE, live_trading_confirmed=False
        ),
    )
    engine, _ = build_engine(live_unconfirmed, store, cycles=1)
    assert isinstance(engine.broker, PaperBroker)


def test_confirmed_live_without_an_adapter_refuses_to_start(config, store):
    confirmed = dataclasses.replace(
        config,
        trading=dataclasses.replace(
            config.trading,
            mode=Mode.LIVE,
            live_trading_confirmed=True,
            broker="paper",
        ),
    )
    with pytest.raises(LiveBrokerNotConfigured):
        build_engine(confirmed, store, cycles=1)


def test_improvement_can_be_switched_off(config, store):
    disabled = dataclasses.replace(
        config, improvement=ImprovementConfig(enabled=False, challengers=0)
    )
    engine, market = build_engine(disabled, store, cycles=10)
    run(engine, market, 10)
    assert engine.improve.challengers() == []
