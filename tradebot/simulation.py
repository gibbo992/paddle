"""A synthetic Moltbook and market, for offline testing and demos.

This exists so the pipeline can be exercised end to end -- discovery,
extraction, forward testing, reputation, risk, and the improvement loop --
without touching the live network or risking anything.

It is also the only honest way to check the claim the whole design rests on:
that scoring agents on forward-tested outcomes separates skilled agents from
lucky ones. The simulation seeds agents with known skill levels, so you can
verify the reputation ranking recovers them.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Iterator, Sequence

from .marketdata import PriceUnavailable
from .models import utcnow
from .moltbook.client import RawPost

SYMBOLS = ("BTC", "ETH", "SOL", "AAPL", "NVDA", "TSLA")

_LONG_TEMPLATES = (
    "Going long ${sym} here. Entry {entry:.2f}, stop {stop:.2f}, target {target:.2f}.",
    "Bought ${sym} at {entry:.2f}. Stop loss {stop:.2f}, take profit {target:.2f}.",
    "Accumulating ${sym} around {entry:.2f}. SL {stop:.2f} TP {target:.2f}.",
)
_SHORT_TEMPLATES = (
    "Shorting ${sym} from {entry:.2f}. Stop {stop:.2f}, target {target:.2f}.",
    "Bearish ${sym}, entered short at {entry:.2f}. SL {stop:.2f} TP {target:.2f}.",
)
_NOISE_TEMPLATES = (
    "Anyone else watching the macro data this week?",
    "Reminder that position sizing beats being right.",
    "My backtest of a 20/50 crossover looked great until fees.",
    "What are people using for orderbook data these days?",
)


class SimulatedMarket:
    """Pre-generated geometric random walks, so the future is knowable.

    Agents peek at the next move with a probability set by their skill, which
    is how the simulation creates genuinely-skilled and genuinely-useless
    agents rather than just noisy ones.
    """

    def __init__(
        self,
        symbols: Sequence[str] = SYMBOLS,
        steps: int = 400,
        seed: int = 11,
        volatility: float = 0.03,
        step_hours: float = 6.0,
    ) -> None:
        self.rng = random.Random(seed)
        self.symbols = list(symbols)
        self.index = 0
        self.step_hours = step_hours
        # Virtual time. Each advance() moves the clock as well as the price,
        # so holding periods and time-based exits behave as they would live.
        self.start = utcnow()
        self.paths: dict[str, list[float]] = {}
        for symbol in self.symbols:
            price = self.rng.uniform(20.0, 400.0)
            path = [price]
            for _ in range(steps):
                price *= 1.0 + self.rng.gauss(0.0005, volatility)
                path.append(max(0.01, price))
            self.paths[symbol] = path

    def advance(self, steps: int = 1) -> None:
        self.index = min(self.index + steps, len(next(iter(self.paths.values()))) - 1)

    def now(self) -> datetime:
        return self.start + timedelta(hours=self.step_hours * self.index)

    def price(self, symbol: str) -> float:
        try:
            return self.paths[symbol.upper()][self.index]
        except KeyError:
            raise PriceUnavailable(f"unknown symbol {symbol}") from None

    def prices(self, symbols: list[str]) -> dict[str, float]:
        out = {}
        for symbol in symbols:
            try:
                out[symbol.upper()] = self.price(symbol)
            except PriceUnavailable:
                continue
        return out

    def future_return(self, symbol: str, horizon: int = 3) -> float:
        path = self.paths[symbol.upper()]
        here = path[self.index]
        there = path[min(self.index + horizon, len(path) - 1)]
        return (there - here) / here


@dataclass
class SimulatedAgent:
    agent_id: str
    skill: float  # 0.0 = coin flip, 1.0 = near-perfect
    post_rate: float = 0.5
    noise_rate: float = 0.3
    submolt: str = "algotrading"

    @property
    def handle(self) -> str:
        return self.agent_id

    def accuracy(self) -> float:
        return 0.5 + 0.45 * self.skill


@dataclass
class SimulatedMoltbook:
    """Stands in for `MoltbookClient` -- same surface Discovery uses."""

    market: SimulatedMarket
    agents: list[SimulatedAgent]
    seed: int = 5
    _rng: random.Random = field(init=False)
    _counter: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        self._rng = random.Random(self.seed)

    def close(self) -> None:  # parity with MoltbookClient
        return None

    def _make_post(self, agent: SimulatedAgent) -> RawPost:
        self._counter += 1
        symbol = self._rng.choice(self.market.symbols)
        price = self.market.price(symbol)

        if self._rng.random() < agent.noise_rate:
            body = self._rng.choice(_NOISE_TEMPLATES)
        else:
            move = self.market.future_return(symbol)
            correct = self._rng.random() < agent.accuracy()
            going_up = (move > 0) if correct else (move <= 0)
            if going_up:
                body = self._rng.choice(_LONG_TEMPLATES).format(
                    sym=symbol, entry=price, stop=price * 0.92, target=price * 1.15
                )
            else:
                body = self._rng.choice(_SHORT_TEMPLATES).format(
                    sym=symbol, entry=price, stop=price * 1.08, target=price * 0.85
                )

        return RawPost(
            post_id=f"sim-{self._counter}",
            agent_id=agent.agent_id,
            agent_handle=agent.handle,
            submolt=agent.submolt,
            title="",
            body=body,
            created_at=self.market.now() - timedelta(minutes=self._rng.randint(1, 20)),
            score=self._rng.randint(0, 500),
        )

    def iter_posts(
        self, submolts: Sequence[str] | None = None, limit_per_submolt: int = 50
    ) -> Iterator[RawPost]:
        for agent in self.agents:
            if self._rng.random() < agent.post_rate:
                yield self._make_post(agent)

    def search_posts(self, query: str, limit: int = 50) -> list[RawPost]:
        return []  # submolt sweep already covers the simulated population

    def fetch_leaderboard(self, limit: int = 50) -> list[dict]:
        return []


def default_agents() -> list[SimulatedAgent]:
    """A believable population: a couple of sharps, a crowd of noise."""
    return [
        SimulatedAgent("alpha_quant", skill=0.85, post_rate=0.7),
        SimulatedAgent("steady_edge", skill=0.60, post_rate=0.6),
        SimulatedAgent("coinflip_carl", skill=0.05, post_rate=0.8),
        SimulatedAgent("hype_maxi", skill=0.0, post_rate=0.9, noise_rate=0.15),
        SimulatedAgent("mean_reverter", skill=0.35, post_rate=0.5),
        SimulatedAgent("lucky_larry", skill=0.15, post_rate=0.4),
    ]
