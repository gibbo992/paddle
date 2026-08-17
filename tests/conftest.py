from __future__ import annotations

import uuid
from datetime import timedelta

import pytest

from tradebot.config import (
    Config,
    ImprovementConfig,
    LLMConfig,
    MarketDataConfig,
    ReputationConfig,
    RiskLimits,
    TradingConfig,
)
from tradebot.marketdata import StaticPriceFeed
from tradebot.models import (
    Action,
    ClosedTrade,
    CloseReason,
    Side,
    TradeSignal,
    utcnow,
)
from tradebot.store import Store


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "test.db")
    yield s
    s.close()


@pytest.fixture
def limits():
    return RiskLimits(
        max_position_pct=5.0,
        max_gross_exposure_pct=60.0,
        max_concurrent_positions=3,
        per_asset_cap_pct=15.0,
        daily_loss_limit_pct=4.0,
        max_drawdown_pct=20.0,
        min_stop_loss_pct=1.0,
        max_stop_loss_pct=25.0,
        max_hold_hours=168.0,
        min_trade_notional=10.0,
    )


@pytest.fixture
def config(limits, tmp_path):
    return Config(
        trading=TradingConfig(starting_cash=10_000.0, fee_bps=10.0, slippage_bps=5.0),
        risk=limits,
        improvement=ImprovementConfig(enabled=True, challengers=2, min_eval_trades=5, seed=3),
        reputation=ReputationConfig(prior_strength=10.0, min_track_record=3),
        llm=LLMConfig(enabled=False),
        market_data=MarketDataConfig(provider="static"),
        database_path=str(tmp_path / "engine.db"),
    ).validate()


@pytest.fixture
def feed():
    return StaticPriceFeed({"BTC": 100.0, "ETH": 50.0, "AAPL": 200.0})


def make_signal(
    *,
    agent_id: str = "agent-1",
    symbol: str = "BTC",
    side: Side = Side.BUY,
    action: Action = Action.OPEN,
    confidence: float = 0.8,
    age_minutes: float = 5.0,
    post_id: str | None = None,
    **kwargs,
) -> TradeSignal:
    now = utcnow()
    post_id = post_id or uuid.uuid4().hex[:8]
    return TradeSignal(
        signal_id=TradeSignal.fingerprint(post_id, symbol, side, action),
        agent_id=agent_id,
        post_id=post_id,
        submolt="algotrading",
        symbol=symbol,
        side=side,
        action=action,
        confidence=confidence,
        observed_at=now,
        posted_at=now - timedelta(minutes=age_minutes),
        raw_text="test signal",
        **kwargs,
    )


def make_trade(
    *,
    pnl: float,
    book: str = "main",
    agent_id: str = "agent-1",
    symbol: str = "BTC",
    quantity: float = 1.0,
    entry_price: float = 100.0,
    fees: float = 0.0,
    closed_offset_hours: float = 0.0,
    reason: CloseReason = CloseReason.TAKE_PROFIT,
    features: dict | None = None,
) -> ClosedTrade:
    now = utcnow()
    return ClosedTrade(
        trade_id=uuid.uuid4().hex,
        book=book,
        symbol=symbol,
        side=Side.BUY,
        quantity=quantity,
        entry_price=entry_price,
        exit_price=entry_price + pnl / quantity,
        opened_at=now - timedelta(hours=closed_offset_hours + 1),
        closed_at=now - timedelta(hours=closed_offset_hours),
        pnl=pnl,
        fees=fees,
        reason=reason,
        signal_id=uuid.uuid4().hex[:12],
        agent_id=agent_id,
        policy_id="p-test",
        features=features or {},
    )
