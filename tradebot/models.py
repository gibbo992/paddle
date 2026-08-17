"""Core domain types.

Everything that crosses a module boundary is defined here so the layers
(discovery -> parsing -> scoring -> risk -> execution -> improvement) stay
decoupled and individually testable.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def from_iso(s: str) -> datetime:
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"

    @property
    def opposite(self) -> "Side":
        return Side.SELL if self is Side.BUY else Side.BUY

    @property
    def sign(self) -> int:
        """+1 for a long, -1 for a short."""
        return 1 if self is Side.BUY else -1


class Action(str, Enum):
    OPEN = "open"
    CLOSE = "close"


class Mode(str, Enum):
    PAPER = "paper"
    LIVE = "live"


class CloseReason(str, Enum):
    SIGNAL = "signal"
    STOP_LOSS = "stop_loss"
    TAKE_PROFIT = "take_profit"
    MAX_HOLD = "max_hold"
    KILL_SWITCH = "kill_switch"
    MANUAL = "manual"


# Book names namespace the many parallel portfolios the bot runs at once:
#   "main"              -> real capital (or the paper stand-in for it)
#   "agent:<agent_id>"  -> forward test of one Moltbook agent's calls
#   "policy:<policy_id>"-> challenger policy being evaluated against champion
MAIN_BOOK = "main"


def agent_book(agent_id: str) -> str:
    return f"agent:{agent_id}"


def policy_book(policy_id: str) -> str:
    return f"policy:{policy_id}"


@dataclass(frozen=True)
class AgentProfile:
    """A Moltbook agent we have seen make trade claims."""

    agent_id: str
    handle: str
    first_seen: datetime
    last_seen: datetime
    submolts: tuple[str, ...] = ()
    claimed_karma: int = 0
    # Self-reported performance. Recorded for reference and explicitly NOT
    # used in scoring -- see scoring/reputation.py.
    claimed_pnl_pct: float | None = None


@dataclass(frozen=True)
class TradeSignal:
    """A structured trade intent extracted from a single Moltbook post."""

    signal_id: str
    agent_id: str
    post_id: str
    submolt: str
    symbol: str
    side: Side
    action: Action
    confidence: float
    observed_at: datetime
    posted_at: datetime
    raw_text: str
    claimed_entry: float | None = None
    claimed_stop: float | None = None
    claimed_target: float | None = None
    extractor: str = "rules"

    @staticmethod
    def fingerprint(post_id: str, symbol: str, side: Side, action: Action) -> str:
        """Stable id so the same post never produces two trades."""
        raw = f"{post_id}|{symbol.upper()}|{side.value}|{action.value}"
        return hashlib.sha256(raw.encode()).hexdigest()[:24]

    @property
    def age_minutes(self) -> float:
        return (self.observed_at - self.posted_at).total_seconds() / 60.0


@dataclass(frozen=True)
class Fill:
    symbol: str
    side: Side
    quantity: float
    price: float
    fee: float
    filled_at: datetime

    @property
    def notional(self) -> float:
        return abs(self.quantity) * self.price


@dataclass
class Position:
    position_id: str
    book: str
    symbol: str
    side: Side
    quantity: float
    entry_price: float
    opened_at: datetime
    signal_id: str
    agent_id: str
    policy_id: str
    stop_price: float | None = None
    target_price: float | None = None
    max_hold_hours: float | None = None
    fees_paid: float = 0.0
    # Feature snapshot at entry -- the raw material for policy attribution.
    features: dict[str, float] = field(default_factory=dict)

    @property
    def notional(self) -> float:
        return abs(self.quantity) * self.entry_price

    def unrealized_pnl(self, mark: float) -> float:
        return (mark - self.entry_price) * self.quantity * self.side.sign

    def unrealized_pnl_pct(self, mark: float) -> float:
        if self.entry_price == 0:
            return 0.0
        return (mark - self.entry_price) / self.entry_price * 100.0 * self.side.sign


@dataclass(frozen=True)
class ClosedTrade:
    trade_id: str
    book: str
    symbol: str
    side: Side
    quantity: float
    entry_price: float
    exit_price: float
    opened_at: datetime
    closed_at: datetime
    pnl: float
    fees: float
    reason: CloseReason
    signal_id: str
    agent_id: str
    policy_id: str
    features: dict[str, float] = field(default_factory=dict)

    @property
    def net_pnl(self) -> float:
        return self.pnl - self.fees

    @property
    def pnl_pct(self) -> float:
        cost = abs(self.quantity) * self.entry_price
        return (self.net_pnl / cost * 100.0) if cost else 0.0

    @property
    def holding_hours(self) -> float:
        return (self.closed_at - self.opened_at).total_seconds() / 3600.0

    @property
    def is_win(self) -> bool:
        return self.net_pnl > 0


@dataclass(frozen=True)
class AgentScore:
    """Reputation derived only from forward-tested (shadow) outcomes."""

    agent_id: str
    reputation: float
    sample_size: int
    win_rate: float
    profit_factor: float
    avg_pnl_pct: float
    max_drawdown_pct: float
    expectancy: float
    updated_at: datetime

    @property
    def is_trusted(self) -> bool:
        return self.reputation >= 0.5 and self.sample_size > 0


@dataclass(frozen=True)
class Decision:
    """What a policy chose to do about a signal, and why."""

    signal_id: str
    policy_id: str
    accepted: bool
    reason: str
    quantity: float = 0.0
    stop_price: float | None = None
    target_price: float | None = None
    features: dict[str, float] = field(default_factory=dict)


def json_dumps(obj: Any) -> str:
    """Deterministic JSON -- sorted keys keep LLM prompt prefixes cacheable."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=_default)


def _default(obj: Any) -> Any:
    if isinstance(obj, datetime):
        return to_iso(obj)
    if isinstance(obj, Enum):
        return obj.value
    if hasattr(obj, "__dataclass_fields__"):
        return asdict(obj)
    raise TypeError(f"not JSON serializable: {type(obj)!r}")
