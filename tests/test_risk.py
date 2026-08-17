"""Hard risk gates."""

from __future__ import annotations

import pytest

from tradebot.config import TradingConfig
from tradebot.execution.ledger import Ledger
from tradebot.execution.risk import RiskManager
from tradebot.models import CloseReason, Side
from tests.conftest import make_signal


@pytest.fixture
def ledger(store):
    return Ledger(store, "main", 10_000.0)


@pytest.fixture
def risk(limits, store):
    return RiskManager(limits, TradingConfig(starting_cash=10_000.0), store)


MARKS = {"BTC": 100.0, "ETH": 50.0, "AAPL": 200.0}


def test_position_size_capped_by_max_position_pct(risk, ledger, limits):
    decision = risk.check_open(ledger, make_signal(), desired_notional=9_999.0, marks=MARKS)
    assert decision.allowed
    notional = decision.quantity * MARKS["BTC"]
    assert notional <= 10_000.0 * limits.max_position_pct / 100.0 + 1e-6
    assert "sized down" in decision.reason


def test_blocks_when_no_independent_price(risk, ledger):
    decision = risk.check_open(ledger, make_signal(symbol="DOGE"), 100.0, MARKS)
    assert not decision.allowed
    assert "no independent price" in decision.reason


def test_blocks_duplicate_symbol(risk, ledger):
    ledger.open_position(
        symbol="BTC", side=Side.BUY, quantity=1.0, price=100.0, fee=0.1,
        signal_id="s1", agent_id="a1", policy_id="p1",
    )
    decision = risk.check_open(ledger, make_signal(symbol="BTC"), 100.0, MARKS)
    assert not decision.allowed
    assert "already holding" in decision.reason


def test_blocks_at_concurrent_position_cap(risk, ledger, limits):
    for i, symbol in enumerate(["BTC", "ETH", "AAPL"][: limits.max_concurrent_positions]):
        ledger.open_position(
            symbol=symbol, side=Side.BUY, quantity=1.0, price=MARKS[symbol], fee=0.1,
            signal_id=f"s{i}", agent_id="a1", policy_id="p1",
        )
    decision = risk.check_open(ledger, make_signal(symbol="NVDA"), 100.0, {**MARKS, "NVDA": 10.0})
    assert not decision.allowed
    assert "position cap" in decision.reason


def test_blocklist_and_allowlist(limits, store, ledger):
    blocked = RiskManager(limits, TradingConfig(blocked_symbols=("BTC",)), store)
    assert not blocked.check_open(ledger, make_signal(symbol="BTC"), 100.0, MARKS).allowed

    allowed_only = RiskManager(limits, TradingConfig(allowed_symbols=("ETH",)), store)
    assert not allowed_only.check_open(ledger, make_signal(symbol="BTC"), 100.0, MARKS).allowed
    assert allowed_only.check_open(ledger, make_signal(symbol="ETH"), 100.0, MARKS).allowed


def test_blocks_trades_below_min_notional(risk, ledger, limits):
    decision = risk.check_open(ledger, make_signal(), desired_notional=1.0, marks=MARKS)
    assert not decision.allowed
    assert "min_trade_notional" in decision.reason


def test_gross_exposure_cap_shrinks_later_trades(limits, store):
    ledger = Ledger(store, "main", 10_000.0)
    risk = RiskManager(limits, TradingConfig(), store)
    # Fill most of the gross exposure budget by hand.
    ledger.open_position(
        symbol="ETH", side=Side.BUY, quantity=110.0, price=50.0, fee=1.0,
        signal_id="s1", agent_id="a1", policy_id="p1",
    )
    decision = risk.check_open(ledger, make_signal(symbol="BTC"), 5_000.0, MARKS)
    if decision.allowed:
        used = ledger.gross_exposure(MARKS) + decision.quantity * MARKS["BTC"]
        cap = ledger.equity(MARKS) * limits.max_gross_exposure_pct / 100.0
        assert used <= cap + 1e-6


def test_kill_switch_trips_on_drawdown(limits, store):
    ledger = Ledger(store, "main", 10_000.0)
    risk = RiskManager(limits, TradingConfig(), store)
    assert risk.kill_switch(ledger, MARKS).allowed

    # Burn equity below the drawdown threshold.
    store.set_cash("main", 10_000.0 * (1 - limits.max_drawdown_pct / 100.0) - 100.0)
    decision = risk.kill_switch(ledger, MARKS)
    assert not decision.allowed
    assert "kill switch" in decision.reason


def test_kill_switch_blocks_new_entries(limits, store):
    ledger = Ledger(store, "main", 10_000.0)
    risk = RiskManager(limits, TradingConfig(), store)
    store.set_cash("main", 100.0)  # equity collapsed
    assert not risk.check_open(ledger, make_signal(), 50.0, MARKS).allowed


def test_daily_loss_limit_blocks_new_risk(limits, store):
    from tests.conftest import make_trade

    ledger = Ledger(store, "main", 10_000.0)
    risk = RiskManager(limits, TradingConfig(), store)
    store.save_trade(make_trade(pnl=-600.0, book="main", closed_offset_hours=1))
    decision = risk.kill_switch(ledger, MARKS)
    assert not decision.allowed
    assert "daily loss limit" in decision.reason


def test_stop_is_always_applied_even_when_the_post_names_none(risk):
    stop = risk.clamp_stop(100.0, Side.BUY, None)
    assert stop < 100.0
    assert stop == pytest.approx(100.0 * (1 - risk.limits.max_stop_loss_pct / 100.0))


def test_stop_clamped_into_band(risk, limits):
    # A 0.01% stop is too tight; widened to the floor.
    tight = risk.clamp_stop(100.0, Side.BUY, 99.99)
    assert tight <= 100.0 * (1 - limits.min_stop_loss_pct / 100.0) + 1e-9
    # A 90% stop is too wide; pulled to the ceiling.
    wide = risk.clamp_stop(100.0, Side.BUY, 10.0)
    assert wide >= 100.0 * (1 - limits.max_stop_loss_pct / 100.0) - 1e-9


def test_short_stop_sits_above_entry(risk):
    assert risk.clamp_stop(100.0, Side.SELL, None) > 100.0


def test_hold_hours_clamped(risk, limits):
    assert risk.clamp_hold_hours(None) == limits.max_hold_hours
    assert risk.clamp_hold_hours(9_999.0) == limits.max_hold_hours
    assert risk.clamp_hold_hours(4.0) == 4.0
