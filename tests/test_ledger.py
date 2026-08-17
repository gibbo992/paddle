"""Book accounting, long and short."""

from __future__ import annotations

import pytest

from tradebot.execution.broker import PaperBroker
from tradebot.execution.ledger import InsufficientCash, Ledger
from tradebot.models import CloseReason, Side


def _open(ledger, **kw):
    defaults = dict(
        symbol="BTC", side=Side.BUY, quantity=10.0, price=100.0, fee=1.0,
        signal_id="s1", agent_id="a1", policy_id="p1",
    )
    return ledger.open_position(**{**defaults, **kw})


def test_opening_deducts_notional_and_fee(store):
    ledger = Ledger(store, "main", 10_000.0)
    _open(ledger)
    assert ledger.cash == pytest.approx(10_000.0 - 1_000.0 - 1.0)
    assert len(ledger.positions()) == 1


def test_cannot_open_beyond_cash(store):
    ledger = Ledger(store, "main", 100.0)
    with pytest.raises(InsufficientCash):
        _open(ledger, quantity=10.0, price=100.0)


def test_long_profit_accounting(store):
    ledger = Ledger(store, "main", 10_000.0)
    position = _open(ledger)
    trade = ledger.close_position(position, 110.0, fee=1.0, reason=CloseReason.TAKE_PROFIT)

    assert trade.pnl == pytest.approx(100.0)       # 10 units * $10
    assert trade.fees == pytest.approx(2.0)        # entry + exit
    assert trade.net_pnl == pytest.approx(98.0)
    assert trade.is_win
    assert ledger.cash == pytest.approx(10_000.0 + 98.0)
    assert ledger.positions() == []


def test_long_loss_accounting(store):
    ledger = Ledger(store, "main", 10_000.0)
    position = _open(ledger)
    trade = ledger.close_position(position, 90.0, fee=1.0, reason=CloseReason.STOP_LOSS)
    assert trade.pnl == pytest.approx(-100.0)
    assert not trade.is_win
    assert ledger.cash == pytest.approx(10_000.0 - 102.0)


def test_short_profits_when_price_falls(store):
    ledger = Ledger(store, "main", 10_000.0)
    position = _open(ledger, side=Side.SELL)
    trade = ledger.close_position(position, 90.0, fee=1.0, reason=CloseReason.TAKE_PROFIT)
    assert trade.pnl == pytest.approx(100.0)
    assert ledger.cash == pytest.approx(10_000.0 + 98.0)


def test_short_loses_when_price_rises(store):
    ledger = Ledger(store, "main", 10_000.0)
    position = _open(ledger, side=Side.SELL)
    trade = ledger.close_position(position, 110.0, fee=1.0, reason=CloseReason.STOP_LOSS)
    assert trade.pnl == pytest.approx(-100.0)


def test_equity_tracks_unrealised_pnl(store):
    ledger = Ledger(store, "main", 10_000.0)
    _open(ledger)
    assert ledger.equity({"BTC": 100.0}) == pytest.approx(9_999.0)   # just the fee
    assert ledger.equity({"BTC": 120.0}) == pytest.approx(10_199.0)  # +200 unrealised


def test_short_equity_moves_the_other_way(store):
    ledger = Ledger(store, "main", 10_000.0)
    _open(ledger, side=Side.SELL)
    assert ledger.equity({"BTC": 80.0}) == pytest.approx(10_199.0)
    assert ledger.equity({"BTC": 120.0}) == pytest.approx(9_799.0)


def test_drawdown_measured_from_peak(store):
    ledger = Ledger(store, "main", 10_000.0)
    ledger.mark_to_market({})
    assert ledger.drawdown_pct({}) == pytest.approx(0.0)

    store.set_cash("main", 9_000.0)
    assert ledger.drawdown_pct({}) == pytest.approx(10.0)

    # A new high resets the reference point.
    store.set_cash("main", 12_000.0)
    ledger.mark_to_market({})
    store.set_cash("main", 11_400.0)
    assert ledger.drawdown_pct({}) == pytest.approx(5.0)


def test_books_are_isolated(store):
    a = Ledger(store, "main", 10_000.0)
    b = Ledger(store, "policy:p-2", 10_000.0)
    _open(a)
    assert len(a.positions()) == 1
    assert b.positions() == []
    assert b.cash == pytest.approx(10_000.0)


def test_summary_reports_win_rate_and_profit_factor(store):
    ledger = Ledger(store, "main", 10_000.0)
    p1 = _open(ledger, signal_id="s1")
    ledger.close_position(p1, 110.0, 0.0, CloseReason.TAKE_PROFIT)
    p2 = _open(ledger, signal_id="s2")
    ledger.close_position(p2, 95.0, 0.0, CloseReason.STOP_LOSS)

    summary = ledger.summary({"BTC": 100.0})
    assert summary["closed_trades"] == 2
    assert summary["win_rate"] == pytest.approx(0.5)
    assert summary["profit_factor"] == pytest.approx(99.0 / 51.0, rel=1e-3)


# ------------------------------------------------------------------ broker


def test_paper_broker_slippage_is_always_adverse(feed):
    broker = PaperBroker(feed, fee_bps=10.0, slippage_bps=50.0)
    buy = broker.execute("BTC", Side.BUY, 1.0)
    sell = broker.execute("BTC", Side.SELL, 1.0)
    assert buy.price > 100.0    # pay up to buy
    assert sell.price < 100.0   # sell into the bid
    assert buy.fee == pytest.approx(buy.price * 10.0 / 10_000.0)


def test_paper_broker_rejects_nonpositive_quantity(feed):
    with pytest.raises(ValueError):
        PaperBroker(feed).execute("BTC", Side.BUY, 0.0)


def test_live_broker_refuses_without_an_adapter():
    from tradebot.execution.broker import LiveBroker, LiveBrokerNotConfigured

    with pytest.raises(LiveBrokerNotConfigured):
        LiveBroker("binance").execute("BTC", Side.BUY, 1.0)
