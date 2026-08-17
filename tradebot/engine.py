"""Cycle orchestration.

One cycle:

  1. sweep Moltbook for unseen posts
  2. extract trade signals from them
  3. mark open positions to market and take exits (stops, targets, time, kill
     switch) -- always before opening anything new
  4. route each new signal to every book: the agent's own forward-test book,
     the champion's main book, and each challenger's shadow book
  5. rescore agents from their forward-tested results
  6. run the improvement loop: evaluate challengers, maybe promote, refresh
     the lessons fed back into signal extraction
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Mapping, Sequence

from .config import Config
from .execution.broker import Broker, LiveBroker, LiveBrokerNotConfigured, PaperBroker
from .execution.ledger import InsufficientCash, Ledger
from .execution.risk import RiskManager
from .improve.loop import SelfImprovementLoop
from .improve.policy import Policy
from .llm import ClaudeClient
from .marketdata import PriceFeed, PriceUnavailable, build_feed
from .models import (
    MAIN_BOOK,
    Action,
    CloseReason,
    Position,
    Side,
    TradeSignal,
    agent_book,
    policy_book,
    utcnow,
)
from .moltbook.client import MoltbookClient
from .moltbook.discovery import Discovery
from .scoring.reputation import ReputationScorer
from .signals import ClaudeExtractor, HybridExtractor, RuleExtractor
from .store import Store

log = logging.getLogger(__name__)

# Agents are forward-tested through one fixed, permissive policy so that every
# agent is measured on identical terms. If agent books used the evolving
# champion instead, an agent's score would move when the *bot* changed, which
# would make reputation meaningless as a comparison between agents.
AGENT_TRACKING_POLICY = Policy(
    policy_id="agent-tracker",
    min_reputation=0.0,
    min_track_record=0,
    min_confidence=0.25,
    max_signal_age_minutes=2880.0,
    risk_per_trade_pct=2.0,
    reputation_weight=0.0,
    stop_loss_pct=10.0,
    take_profit_pct=20.0,
    max_hold_hours=168.0,
    max_positions=50,
)


@dataclass
class CycleReport:
    cycle: int = 0
    posts_seen: int = 0
    new_agents: int = 0
    signals_found: int = 0
    signals_new: int = 0
    opened: int = 0
    closed: int = 0
    rejected: list[str] = field(default_factory=list)
    promotions: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    equity: float = 0.0

    def summary(self) -> str:
        return (
            f"cycle {self.cycle}: {self.posts_seen} posts, {self.signals_new} new "
            f"signals, {self.opened} opened, {self.closed} closed, "
            f"equity {self.equity:,.2f}"
        )


class Engine:
    def __init__(
        self,
        config: Config,
        store: Store,
        client: MoltbookClient | None = None,
        feed: PriceFeed | None = None,
        broker: Broker | None = None,
        extractor: HybridExtractor | None = None,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self.config = config
        self.store = store
        # Injectable so the simulator can run on virtual time -- without it,
        # holding periods and time-based exits are meaningless in a backtest.
        self.clock = clock
        self.client = client or MoltbookClient(config.moltbook)
        self.feed = feed or build_feed(config.market_data)
        self.broker = broker or self._build_broker()
        self.discovery = Discovery(self.client, store)
        self.extractor = extractor or self._build_extractor()
        self.risk = RiskManager(config.risk, config.trading, store)
        self.scorer = ReputationScorer(config.reputation)
        self.improve = SelfImprovementLoop(store, config)
        self.main = Ledger(store, MAIN_BOOK, config.trading.starting_cash)

    def _build_broker(self) -> Broker:
        if self.config.trading.is_live():
            if self.config.trading.broker in ("", "paper"):
                raise LiveBrokerNotConfigured(
                    "trading.mode is live and confirmed, but trading.broker is "
                    "'paper'. TradeBot ships no live venue adapter -- subclass "
                    "execution.broker.LiveBroker and pass it to Engine(broker=...)."
                )
            return LiveBroker(self.config.trading.broker)
        if self.config.trading.mode.value == "live":
            log.warning(
                "trading.mode is 'live' but trading.live_trading_confirmed is false "
                "-- running on the paper broker. No real orders will be sent."
            )
        return PaperBroker(
            self.feed,
            fee_bps=self.config.trading.fee_bps,
            slippage_bps=self.config.trading.slippage_bps,
        )

    def _build_extractor(self) -> HybridExtractor:
        rules = RuleExtractor(self.clock)
        claude_client = ClaudeClient(self.config.llm)
        if claude_client.available():
            return HybridExtractor(
                rules, ClaudeExtractor(claude_client, self.config.llm, self.clock)
            )
        log.info("Claude unavailable; running with rule-based extraction only")
        return HybridExtractor(rules, None)

    # ------------------------------------------------------------------ marks

    def marks_for(self, symbols: Sequence[str]) -> dict[str, float]:
        wanted = sorted({s.upper() for s in symbols})
        if not wanted:
            return {}
        try:
            return self.feed.prices(list(wanted))
        except Exception as exc:  # a dead feed must not kill the cycle
            log.error("price feed failed: %s", exc)
            return {}

    def all_open_symbols(self) -> list[str]:
        return sorted({p.symbol for p in self.store.open_positions()})

    # ------------------------------------------------------------------ cycle

    def run_cycle(self) -> CycleReport:
        report = CycleReport(cycle=self.improve.bump_cycle())

        # 1-2. Ingest.
        try:
            signals = self._ingest(report)
        except Exception as exc:
            log.exception("ingest failed")
            report.errors.append(f"ingest: {exc}")
            signals = []

        # 3. Exits first: never add risk to a book that should be flattening.
        marks = self.marks_for(self.all_open_symbols() + [s.symbol for s in signals])
        report.closed = self._manage_positions(marks)

        # 4. Route new signals.
        for signal in signals:
            try:
                report.opened += self._route_signal(signal, marks, report)
            except Exception as exc:
                log.exception("routing %s failed", signal.signal_id)
                report.errors.append(f"{signal.signal_id}: {exc}")

        # 5. Reputation from forward-tested outcomes.
        self.scorer.rescore_all(self.store, self.config.trading.starting_cash)

        # 6. Improvement.
        if self.config.improvement.enabled:
            try:
                self.improve.ensure_population()
                for result in self.improve.evaluate():
                    if result.decision == "promote":
                        report.promotions.append(
                            f"{result.policy_id} (p={result.win_probability:.3f}, "
                            f"n={result.n_trades})"
                        )
                self.improve.refresh_lessons()
            except Exception as exc:
                log.exception("improvement loop failed")
                report.errors.append(f"improve: {exc}")

        report.equity = self.main.mark_to_market(marks)
        return report

    def _ingest(self, report: CycleReport) -> list[TradeSignal]:
        result = self.discovery.sweep(limit_per_source=50)
        report.posts_seen = len(result.posts)
        report.new_agents = result.new_agents
        if not result.posts:
            return []

        lessons = self.store.top_lessons(self.config.llm.max_lessons_in_prompt)
        signals = self.extractor.extract(result.posts, lessons)
        report.signals_found = len(signals)

        fresh: list[TradeSignal] = []
        for signal in signals:
            if self.store.save_signal(signal):
                fresh.append(signal)
        report.signals_new = len(fresh)

        self.store.mark_posts_seen(p.post_id for p in result.posts)
        return fresh

    # -------------------------------------------------------------- routing

    def _route_signal(
        self, signal: TradeSignal, marks: Mapping[str, float], report: CycleReport
    ) -> int:
        opened = 0

        # (a) The agent's own forward-test book -- always, regardless of score.
        # This is how an unproven agent earns (or fails to earn) a reputation.
        opened += self._apply(
            book=agent_book(signal.agent_id),
            policy=AGENT_TRACKING_POLICY,
            signal=signal,
            marks=marks,
            report=report,
            record_rejections=False,
            enforce_eligibility=False,  # this book is how eligibility is earned
        )

        # (b) The champion's real book.
        champion = self.improve.champion()
        opened += self._apply(
            book=MAIN_BOOK,
            policy=champion,
            signal=signal,
            marks=marks,
            report=report,
            record_rejections=True,
        )

        # (c) Challengers, in their own shadow books.
        for challenger in self.improve.challengers():
            opened += self._apply(
                book=policy_book(challenger.policy_id),
                policy=challenger,
                signal=signal,
                marks=marks,
                report=report,
                record_rejections=False,
            )
        return opened

    def _apply(
        self,
        *,
        book: str,
        policy: Policy,
        signal: TradeSignal,
        marks: Mapping[str, float],
        report: CycleReport,
        record_rejections: bool,
        enforce_eligibility: bool = True,
    ) -> int:
        ledger = Ledger(self.store, book, self.config.trading.starting_cash)

        if signal.action is Action.CLOSE:
            position = next(
                (
                    p
                    for p in ledger.positions()
                    if p.symbol == signal.symbol and p.agent_id == signal.agent_id
                ),
                None,
            )
            if position:
                self._close(ledger, position, marks, CloseReason.SIGNAL)
                report.closed += 1
            return 0

        score = self.store.get_agent_score(signal.agent_id)

        # Operator-owned eligibility floor, applied on top of whatever the
        # policy thinks. A policy may tighten who it copies but never loosen
        # past `reputation.min_track_record` -- otherwise the improvement loop
        # could learn its way out of the "prove yourself first" rule, which is
        # the one rule protecting against fabricated track records.
        if enforce_eligibility and not self.scorer.is_eligible(
            score, policy.min_track_record
        ):
            if record_rejections:
                n = score.sample_size if score else 0
                report.rejected.append(
                    f"{signal.symbol}: agent {signal.agent_id} not eligible "
                    f"(n={n}, needs {self.config.reputation.min_track_record} "
                    f"forward-tested trades and reputation >= 0.50)"
                )
            return 0

        equity = ledger.equity(marks)
        decision = policy.evaluate(signal, score, equity)
        if not decision.accepted:
            if record_rejections:
                report.rejected.append(f"{signal.symbol}: {decision.reason}")
            return 0

        approval = self.risk.check_open(ledger, signal, decision.quantity, marks)
        if not approval.allowed:
            if record_rejections:
                report.rejected.append(f"{signal.symbol}: {approval.reason}")
            return 0

        try:
            fill = self.broker.execute(signal.symbol, signal.side, approval.quantity)
        except (PriceUnavailable, LiveBrokerNotConfigured) as exc:
            report.errors.append(f"{signal.symbol}: {exc}")
            return 0

        stop = self.risk.clamp_stop(
            fill.price, signal.side, policy.stop_for(fill.price, signal.side.sign)
        )
        target = policy.target_for(fill.price, signal.side.sign)
        hold = self.risk.clamp_hold_hours(policy.max_hold_hours)

        try:
            ledger.open_position(
                symbol=fill.symbol,
                side=fill.side,
                quantity=fill.quantity,
                price=fill.price,
                fee=fill.fee,
                signal_id=signal.signal_id,
                agent_id=signal.agent_id,
                policy_id=policy.policy_id,
                stop_price=stop,
                target_price=target,
                max_hold_hours=hold,
                features=decision.features,
                opened_at=self.clock(),
            )
        except InsufficientCash as exc:
            if record_rejections:
                report.rejected.append(f"{signal.symbol}: {exc}")
            return 0

        log.info(
            "%s: opened %s %s x%.6f @ %.4f (agent %s)",
            book,
            signal.side.value,
            fill.symbol,
            fill.quantity,
            fill.price,
            signal.agent_id,
        )
        return 1

    # --------------------------------------------------------- position mgmt

    def _manage_positions(self, marks: Mapping[str, float]) -> int:
        closed = 0
        for book in self.store.list_books(active_only=True):
            ledger = Ledger(self.store, book, self.config.trading.starting_cash)
            ledger.mark_to_market(marks)

            flatten = not self.risk.kill_switch(ledger, marks).allowed
            for position in ledger.positions():
                mark = marks.get(position.symbol)
                if mark is None or mark <= 0:
                    continue
                reason = self._exit_reason(position, mark, flatten)
                if reason is not None:
                    self._close(ledger, position, marks, reason)
                    closed += 1
        return closed

    def _exit_reason(
        self, position: Position, mark: float, flatten: bool
    ) -> CloseReason | None:
        if flatten:
            return CloseReason.KILL_SWITCH

        if position.side is Side.BUY:
            if position.stop_price and mark <= position.stop_price:
                return CloseReason.STOP_LOSS
            if position.target_price and mark >= position.target_price:
                return CloseReason.TAKE_PROFIT
        else:
            if position.stop_price and mark >= position.stop_price:
                return CloseReason.STOP_LOSS
            if position.target_price and mark <= position.target_price:
                return CloseReason.TAKE_PROFIT

        if position.max_hold_hours:
            age_hours = (self.clock() - position.opened_at).total_seconds() / 3600.0
            if age_hours >= position.max_hold_hours:
                return CloseReason.MAX_HOLD
        return None

    def _close(
        self,
        ledger: Ledger,
        position: Position,
        marks: Mapping[str, float],
        reason: CloseReason,
    ) -> None:
        exit_side = position.side.opposite
        try:
            fill = self.broker.execute(position.symbol, exit_side, position.quantity)
            exit_price, fee = fill.price, fill.fee
        except (PriceUnavailable, LiveBrokerNotConfigured):
            # Fall back to the last mark so a book is never left with a
            # position we have decided to exit.
            exit_price = marks.get(position.symbol, position.entry_price)
            fee = 0.0

        trade = ledger.close_position(
            position, exit_price, fee, reason, closed_at=self.clock()
        )
        log.info(
            "%s: closed %s %s for %.2f (%.2f%%) via %s",
            ledger.book,
            position.side.value,
            position.symbol,
            trade.net_pnl,
            trade.pnl_pct,
            reason.value,
        )

    # ---------------------------------------------------------------- status

    def status(self) -> dict[str, object]:
        marks = self.marks_for(self.all_open_symbols())
        champion = self.improve.champion()
        return {
            "mode": self.config.trading.mode.value,
            "live_confirmed": self.config.trading.live_trading_confirmed,
            "broker": getattr(self.broker, "name", type(self.broker).__name__),
            "champion": champion.describe(),
            "main": self.main.summary(marks),
            "challengers": [p.policy_id for p in self.improve.challengers()],
            "tracked_agents": len(self.store.list_agents()),
            "attribution": self.improve.attribution().describe(),
        }

    def close(self) -> None:
        self.client.close()
