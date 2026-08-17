"""Brokers.

`PaperBroker` is the workhorse: it prices every fill off an independent feed
and charges fees and adverse slippage, so shadow books stay comparable to a
real one. Live trading is a seam, not an implementation -- see `LiveBroker`.
"""

from __future__ import annotations

from typing import Protocol

from ..models import Fill, Side, utcnow
from ..marketdata import PriceFeed


class LiveBrokerNotConfigured(RuntimeError):
    """Raised when live mode is requested without a real broker adapter."""


class Broker(Protocol):
    def quote(self, symbol: str) -> float: ...

    def execute(self, symbol: str, side: Side, quantity: float) -> Fill: ...


class PaperBroker:
    """Simulated fills at feed price plus adverse slippage and fees."""

    name = "paper"

    def __init__(
        self, feed: PriceFeed, fee_bps: float = 10.0, slippage_bps: float = 5.0
    ) -> None:
        self.feed = feed
        self.fee_bps = fee_bps
        self.slippage_bps = slippage_bps

    def quote(self, symbol: str) -> float:
        return self.feed.price(symbol)

    def fill_price(self, symbol: str, side: Side) -> float:
        mid = self.feed.price(symbol)
        drift = self.slippage_bps / 10_000.0
        # Slippage always works against us, whichever way we are going.
        return mid * (1 + drift) if side is Side.BUY else mid * (1 - drift)

    def fee_for(self, notional: float) -> float:
        return abs(notional) * self.fee_bps / 10_000.0

    def execute(self, symbol: str, side: Side, quantity: float) -> Fill:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        price = self.fill_price(symbol, side)
        return Fill(
            symbol=symbol.upper(),
            side=side,
            quantity=quantity,
            price=price,
            fee=self.fee_for(quantity * price),
            filled_at=utcnow(),
        )


class LiveBroker:
    """Placeholder for a real venue adapter.

    Deliberately unimplemented. Wiring this to an exchange needs decisions
    this bot cannot make on the operator's behalf -- which venue, which
    account, spot or margin, custody and withdrawal policy -- and getting any
    of them wrong moves real money. Subclass this, implement `quote` and
    `execute` against your venue's SDK, and pass the instance to the engine.
    """

    name = "live"

    def __init__(self, venue: str = "") -> None:
        self.venue = venue

    def quote(self, symbol: str) -> float:
        raise LiveBrokerNotConfigured(
            "no live broker adapter is installed; implement LiveBroker.quote()"
        )

    def execute(self, symbol: str, side: Side, quantity: float) -> Fill:
        raise LiveBrokerNotConfigured(
            "no live broker adapter is installed; implement LiveBroker.execute(). "
            "TradeBot ships paper execution only."
        )
