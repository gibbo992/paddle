"""Hard risk gates.

Every order passes through here, in every book, regardless of which policy
proposed it. These limits come from `config.risk` and are never mutated by
the self-improvement loop -- that separation is the whole point: training can
change what the bot trades, never how much it is allowed to lose.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Mapping

from ..config import RiskLimits, TradingConfig
from ..models import Side, TradeSignal, utcnow
from ..store import Store
from .ledger import Ledger


@dataclass(frozen=True)
class RiskDecision:
    allowed: bool
    reason: str
    quantity: float = 0.0

    @staticmethod
    def block(reason: str) -> "RiskDecision":
        return RiskDecision(allowed=False, reason=reason)

    @staticmethod
    def allow(quantity: float, reason: str = "ok") -> "RiskDecision":
        return RiskDecision(allowed=True, reason=reason, quantity=quantity)


class RiskManager:
    def __init__(
        self, limits: RiskLimits, trading: TradingConfig, store: Store | None = None
    ) -> None:
        self.limits = limits
        self.trading = trading
        self.store = store

    # ------------------------------------------------------------ pre-trade

    def check_open(
        self,
        ledger: Ledger,
        signal: TradeSignal,
        desired_notional: float,
        marks: Mapping[str, float],
    ) -> RiskDecision:
        """Approve, shrink, or reject a proposed entry."""
        symbol = signal.symbol.upper()

        if self.trading.blocked_symbols and symbol in {
            s.upper() for s in self.trading.blocked_symbols
        }:
            return RiskDecision.block(f"{symbol} is on the blocklist")
        if self.trading.allowed_symbols and symbol not in {
            s.upper() for s in self.trading.allowed_symbols
        }:
            return RiskDecision.block(f"{symbol} is not on the allowlist")

        mark = marks.get(symbol)
        if not mark or mark <= 0:
            return RiskDecision.block(f"no independent price for {symbol}")

        equity = ledger.equity(marks)
        if equity <= 0:
            return RiskDecision.block("book has no equity")

        if self.kill_switch(ledger, marks).allowed is False:
            return self.kill_switch(ledger, marks)

        positions = ledger.positions()
        if len(positions) >= self.limits.max_concurrent_positions:
            return RiskDecision.block(
                f"at position cap ({self.limits.max_concurrent_positions})"
            )
        if any(p.symbol == symbol for p in positions):
            return RiskDecision.block(f"already holding {symbol}")

        # Clamp against every notional ceiling, then take the tightest.
        caps = {
            "max_position_pct": equity * self.limits.max_position_pct / 100.0,
            "per_asset_cap_pct": max(
                0.0,
                equity * self.limits.per_asset_cap_pct / 100.0
                - ledger.exposure_to(symbol, marks),
            ),
            "max_gross_exposure_pct": max(
                0.0,
                equity * self.limits.max_gross_exposure_pct / 100.0
                - ledger.gross_exposure(marks),
            ),
            "cash": max(0.0, ledger.cash),
        }
        binding = min(caps, key=lambda k: caps[k])
        notional = min(desired_notional, *caps.values())

        if notional < self.limits.min_trade_notional:
            return RiskDecision.block(
                f"sized down to {notional:.2f}, below min_trade_notional "
                f"({self.limits.min_trade_notional:.2f}); binding limit: {binding}"
            )

        quantity = notional / mark
        reason = "ok" if notional >= desired_notional else f"sized down by {binding}"
        return RiskDecision.allow(quantity, reason)

    def clamp_stop(self, entry: float, side: Side, stop: float | None) -> float:
        """Force every position to carry a stop inside the configured band."""
        min_stop = entry * self.limits.min_stop_loss_pct / 100.0
        max_stop = entry * self.limits.max_stop_loss_pct / 100.0

        if stop is None or stop <= 0:
            distance = max_stop
        else:
            distance = abs(entry - stop)
        distance = min(max(distance, min_stop), max_stop)
        return entry - distance if side is Side.BUY else entry + distance

    def clamp_hold_hours(self, hours: float | None) -> float:
        if hours is None or hours <= 0:
            return self.limits.max_hold_hours
        return min(hours, self.limits.max_hold_hours)

    # ------------------------------------------------------------ portfolio

    def kill_switch(self, ledger: Ledger, marks: Mapping[str, float]) -> RiskDecision:
        """Block all new risk once drawdown or the daily loss limit is hit."""
        drawdown = ledger.drawdown_pct(marks)
        if drawdown >= self.limits.max_drawdown_pct:
            return RiskDecision.block(
                f"kill switch: drawdown {drawdown:.2f}% >= "
                f"{self.limits.max_drawdown_pct:.2f}%"
            )

        if self.store is not None:
            since = utcnow() - timedelta(days=1)
            realized = self.store.realized_pnl_since(ledger.book, since)
            equity = ledger.equity(marks)
            if equity > 0:
                loss_pct = -realized / equity * 100.0
                if loss_pct >= self.limits.daily_loss_limit_pct:
                    return RiskDecision.block(
                        f"daily loss limit: {loss_pct:.2f}% >= "
                        f"{self.limits.daily_loss_limit_pct:.2f}%"
                    )
        return RiskDecision.allow(0.0, "within limits")
