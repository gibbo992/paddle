"""Price feeds.

A copy-trading bot is only as honest as its marks: without an independent
price it would have to take the poster's word for the entry, which is exactly
the thing this bot refuses to do. `PriceFeed` is therefore a required
dependency of execution, not an optional one.

`HttpPriceFeed` is generic on purpose -- point it at whatever quote API you
have via config rather than baking one vendor in.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Protocol

import httpx

from .config import MarketDataConfig

log = logging.getLogger(__name__)


class PriceUnavailable(RuntimeError):
    pass


class PriceFeed(Protocol):
    def price(self, symbol: str) -> float:
        """Latest price, or raise PriceUnavailable."""

    def prices(self, symbols: list[str]) -> dict[str, float]:
        """Best-effort bulk fetch; missing symbols are simply absent."""


class StaticPriceFeed:
    """Fixed prices. Used by tests and by `backtest`."""

    def __init__(self, prices: dict[str, float] | None = None) -> None:
        self._prices = {k.upper(): float(v) for k, v in (prices or {}).items()}

    def set(self, symbol: str, value: float) -> None:
        self._prices[symbol.upper()] = float(value)

    def price(self, symbol: str) -> float:
        try:
            return self._prices[symbol.upper()]
        except KeyError:
            raise PriceUnavailable(f"no static price for {symbol}") from None

    def prices(self, symbols: list[str]) -> dict[str, float]:
        out: dict[str, float] = {}
        for symbol in symbols:
            try:
                out[symbol.upper()] = self.price(symbol)
            except PriceUnavailable:
                continue
        return out


class HttpPriceFeed:
    """Generic JSON quote feed with a short TTL cache."""

    def __init__(
        self,
        config: MarketDataConfig,
        client: httpx.Client | None = None,
        clock: Any = time.monotonic,
    ) -> None:
        if not config.base_url:
            raise ValueError("market_data.base_url is required for the http provider")
        self.config = config
        self._clock = clock
        self._cache: dict[str, tuple[float, float]] = {}
        self._owns_client = client is None
        self._client = client or httpx.Client(
            base_url=config.base_url.rstrip("/"), timeout=15.0
        )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def price(self, symbol: str) -> float:
        symbol = symbol.upper()
        now = self._clock()
        if hit := self._cache.get(symbol):
            value, stamped = hit
            if now - stamped < self.config.cache_seconds:
                return value

        import os

        headers = {"Accept": "application/json"}
        if key := os.environ.get(self.config.api_key_env):
            headers["Authorization"] = f"Bearer {key}"

        try:
            response = self._client.get(
                "", params={self.config.symbol_param: symbol}, headers=headers
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise PriceUnavailable(f"price fetch failed for {symbol}: {exc}") from exc

        value = _dig_number(payload, self.config.price_path)
        if value is None or value <= 0:
            raise PriceUnavailable(
                f"no positive number at '{self.config.price_path}' for {symbol}"
            )
        self._cache[symbol] = (value, now)
        return value

    def prices(self, symbols: list[str]) -> dict[str, float]:
        out: dict[str, float] = {}
        for symbol in symbols:
            try:
                out[symbol.upper()] = self.price(symbol)
            except PriceUnavailable as exc:
                log.warning("%s", exc)
        return out


def _dig_number(payload: Any, dotted: str) -> float | None:
    cur = payload
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return None
    try:
        return float(cur)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def build_feed(config: MarketDataConfig) -> PriceFeed:
    if config.provider == "static":
        return StaticPriceFeed(config.static_prices)
    if config.provider == "http":
        return HttpPriceFeed(config)
    raise ValueError(f"unknown market_data.provider: {config.provider!r}")
