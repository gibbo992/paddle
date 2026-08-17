"""Book-level accounting.

Every parallel portfolio -- the main book, one per tracked Moltbook agent, one
per challenger policy -- is a `Ledger` over the same tables. Sharing the code
is what makes "how would this agent have done?" and "how would this policy
have done?" answerable with the same accounting the real book uses.

Margin model: a short reserves the same cash as an equivalent long. It is
simplistic, but it is conservative, symmetric, and never lets a shadow book
report profit the main book could not have financed.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Mapping

from ..models import (
    ClosedTrade,
    CloseReason,
    Position,
    Side,
    utcnow,
)
from ..store import Store


class InsufficientCash(RuntimeError):
    pass


class Ledger:
    def __init__(self, store: Store, book: str, starting_cash: float) -> None:
        self.store = store
        self.book = book
        self.starting_cash = starting_cash
        store.ensure_book(book, starting_cash)

    # ------------------------------------------------------------- accessors

    @property
    def cash(self) -> float:
        row = self.store.get_book(self.book)
        return float(row["cash"]) if row else 0.0

    @property
    def peak_equity(self) -> float:
        row = self.store.get_book(self.book)
        return float(row["peak_equity"]) if row else self.starting_cash

    def positions(self) -> list[Position]:
        return self.store.open_positions(self.book)

    def position_for(self, symbol: str) -> Position | None:
        symbol = symbol.upper()
        return next((p for p in self.positions() if p.symbol == symbol), None)

    def symbols(self) -> list[str]:
        return sorted({p.symbol for p in self.positions()})

    def equity(self, marks: Mapping[str, float]) -> float:
        total = self.cash
        for pos in self.positions():
            mark = marks.get(pos.symbol, pos.entry_price)
            total += pos.notional + pos.unrealized_pnl(mark)
        return total

    def gross_exposure(self, marks: Mapping[str, float]) -> float:
        return sum(
            abs(pos.quantity) * marks.get(pos.symbol, pos.entry_price)
            for pos in self.positions()
        )

    def exposure_to(self, symbol: str, marks: Mapping[str, float]) -> float:
        symbol = symbol.upper()
        return sum(
            abs(pos.quantity) * marks.get(pos.symbol, pos.entry_price)
            for pos in self.positions()
            if pos.symbol == symbol
        )

    def drawdown_pct(self, marks: Mapping[str, float]) -> float:
        peak = self.peak_equity
        if peak <= 0:
            return 0.0
        equity = self.equity(marks)
        return max(0.0, (peak - equity) / peak * 100.0)

    def mark_to_market(self, marks: Mapping[str, float]) -> float:
        """Recompute equity and ratchet the peak used for drawdown."""
        equity = self.equity(marks)
        self.store.update_peak_equity(self.book, equity)
        return equity

    # -------------------------------------------------------------- mutation

    def open_position(
        self,
        *,
        symbol: str,
        side: Side,
        quantity: float,
        price: float,
        fee: float,
        signal_id: str,
        agent_id: str,
        policy_id: str,
        stop_price: float | None = None,
        target_price: float | None = None,
        max_hold_hours: float | None = None,
        features: dict[str, float] | None = None,
        opened_at: datetime | None = None,
    ) -> Position:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        if price <= 0:
            raise ValueError("price must be positive")

        cost = quantity * price + fee
        cash = self.cash
        if cost > cash + 1e-9:
            raise InsufficientCash(
                f"{self.book}: need {cost:.2f} but only {cash:.2f} available"
            )

        position = Position(
            position_id=uuid.uuid4().hex,
            book=self.book,
            symbol=symbol.upper(),
            side=side,
            quantity=quantity,
            entry_price=price,
            opened_at=opened_at or utcnow(),
            signal_id=signal_id,
            agent_id=agent_id,
            policy_id=policy_id,
            stop_price=stop_price,
            target_price=target_price,
            max_hold_hours=max_hold_hours,
            fees_paid=fee,
            features=features or {},
        )
        self.store.save_position(position)
        self.store.set_cash(self.book, cash - cost)
        return position

    def close_position(
        self,
        position: Position,
        exit_price: float,
        fee: float,
        reason: CloseReason,
        closed_at: datetime | None = None,
    ) -> ClosedTrade:
        if exit_price <= 0:
            raise ValueError("exit_price must be positive")

        pnl = position.unrealized_pnl(exit_price)
        proceeds = position.notional + pnl - fee
        self.store.set_cash(self.book, self.cash + proceeds)
        self.store.delete_position(position.position_id)

        trade = ClosedTrade(
            trade_id=position.position_id,
            book=self.book,
            symbol=position.symbol,
            side=position.side,
            quantity=position.quantity,
            entry_price=position.entry_price,
            exit_price=exit_price,
            opened_at=position.opened_at,
            closed_at=closed_at or utcnow(),
            pnl=pnl,
            fees=position.fees_paid + fee,
            reason=reason,
            signal_id=position.signal_id,
            agent_id=position.agent_id,
            policy_id=position.policy_id,
            features=position.features,
        )
        self.store.save_trade(trade)
        return trade

    # --------------------------------------------------------------- reports

    def closed_trades(self, since: datetime | None = None) -> list[ClosedTrade]:
        return self.store.closed_trades(self.book, since=since)

    def summary(self, marks: Mapping[str, float]) -> dict[str, float]:
        trades = self.closed_trades()
        wins = [t for t in trades if t.is_win]
        gross_win = sum(t.net_pnl for t in wins)
        gross_loss = abs(sum(t.net_pnl for t in trades if not t.is_win))
        equity = self.equity(marks)
        return {
            "cash": self.cash,
            "equity": equity,
            "starting_cash": self.starting_cash,
            "return_pct": (equity - self.starting_cash) / self.starting_cash * 100.0
            if self.starting_cash
            else 0.0,
            "open_positions": float(len(self.positions())),
            "closed_trades": float(len(trades)),
            "win_rate": (len(wins) / len(trades)) if trades else 0.0,
            "profit_factor": (gross_win / gross_loss) if gross_loss > 0 else float(bool(gross_win)),
            "realized_pnl": sum(t.net_pnl for t in trades),
            "drawdown_pct": self.drawdown_pct(marks),
        }
