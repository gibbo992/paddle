"""SQLite persistence.

One database holds every book the bot runs: the main book, one shadow book
per tracked Moltbook agent, and one per challenger policy. Keeping them in a
single schema is what lets the reputation system and the self-improvement
loop share the same execution and accounting code.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterable, Iterator

from .models import (
    AgentProfile,
    AgentScore,
    ClosedTrade,
    CloseReason,
    Position,
    Side,
    TradeSignal,
    from_iso,
    to_iso,
    utcnow,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents (
    agent_id        TEXT PRIMARY KEY,
    handle          TEXT NOT NULL,
    first_seen      TEXT NOT NULL,
    last_seen       TEXT NOT NULL,
    submolts        TEXT NOT NULL DEFAULT '[]',
    claimed_karma   INTEGER NOT NULL DEFAULT 0,
    claimed_pnl_pct REAL
);

CREATE TABLE IF NOT EXISTS seen_posts (
    post_id TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
    signal_id     TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    post_id       TEXT NOT NULL,
    submolt       TEXT NOT NULL,
    symbol        TEXT NOT NULL,
    side          TEXT NOT NULL,
    action        TEXT NOT NULL,
    confidence    REAL NOT NULL,
    observed_at   TEXT NOT NULL,
    posted_at     TEXT NOT NULL,
    raw_text      TEXT NOT NULL,
    claimed_entry REAL,
    claimed_stop  REAL,
    claimed_target REAL,
    extractor     TEXT NOT NULL DEFAULT 'rules'
);
CREATE INDEX IF NOT EXISTS idx_signals_agent ON signals(agent_id);
CREATE INDEX IF NOT EXISTS idx_signals_observed ON signals(observed_at);

CREATE TABLE IF NOT EXISTS books (
    book          TEXT PRIMARY KEY,
    cash          REAL NOT NULL,
    starting_cash REAL NOT NULL,
    peak_equity   REAL NOT NULL,
    created_at    TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS positions (
    position_id    TEXT PRIMARY KEY,
    book           TEXT NOT NULL,
    symbol         TEXT NOT NULL,
    side           TEXT NOT NULL,
    quantity       REAL NOT NULL,
    entry_price    REAL NOT NULL,
    opened_at      TEXT NOT NULL,
    signal_id      TEXT NOT NULL,
    agent_id       TEXT NOT NULL,
    policy_id      TEXT NOT NULL,
    stop_price     REAL,
    target_price   REAL,
    max_hold_hours REAL,
    fees_paid      REAL NOT NULL DEFAULT 0,
    features       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_positions_book ON positions(book);

CREATE TABLE IF NOT EXISTS trades (
    trade_id    TEXT PRIMARY KEY,
    book        TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    side        TEXT NOT NULL,
    quantity    REAL NOT NULL,
    entry_price REAL NOT NULL,
    exit_price  REAL NOT NULL,
    opened_at   TEXT NOT NULL,
    closed_at   TEXT NOT NULL,
    pnl         REAL NOT NULL,
    fees        REAL NOT NULL,
    reason      TEXT NOT NULL,
    signal_id   TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    policy_id   TEXT NOT NULL,
    features    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_trades_book ON trades(book);
CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_at);

CREATE TABLE IF NOT EXISTS agent_scores (
    agent_id         TEXT PRIMARY KEY,
    reputation       REAL NOT NULL,
    sample_size      INTEGER NOT NULL,
    win_rate         REAL NOT NULL,
    profit_factor    REAL NOT NULL,
    avg_pnl_pct      REAL NOT NULL,
    max_drawdown_pct REAL NOT NULL,
    expectancy       REAL NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
    policy_id   TEXT PRIMARY KEY,
    parent_id   TEXT,
    generation  INTEGER NOT NULL DEFAULT 0,
    params      TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    promoted_at TEXT,
    notes       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_policies_status ON policies(status);

CREATE TABLE IF NOT EXISTS evaluations (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id         TEXT NOT NULL,
    champion_id       TEXT NOT NULL,
    n_trades          INTEGER NOT NULL,
    challenger_mean   REAL NOT NULL,
    champion_mean     REAL NOT NULL,
    win_probability   REAL NOT NULL,
    drawdown_delta    REAL NOT NULL,
    decision          TEXT NOT NULL,
    detail            TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind       TEXT NOT NULL,
    symbol     TEXT NOT NULL DEFAULT '',
    agent_id   TEXT NOT NULL DEFAULT '',
    text       TEXT NOT NULL,
    weight     REAL NOT NULL DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class Store:
    def __init__(self, path: str | Path = "tradebot.db") -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, detect_types=0)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self.conn
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    # ---------------------------------------------------------------- agents

    def upsert_agent(self, agent: AgentProfile) -> None:
        with self.tx() as c:
            c.execute(
                """INSERT INTO agents
                   (agent_id, handle, first_seen, last_seen, submolts, claimed_karma, claimed_pnl_pct)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(agent_id) DO UPDATE SET
                     handle=excluded.handle,
                     last_seen=excluded.last_seen,
                     submolts=excluded.submolts,
                     claimed_karma=excluded.claimed_karma,
                     claimed_pnl_pct=excluded.claimed_pnl_pct""",
                (
                    agent.agent_id,
                    agent.handle,
                    to_iso(agent.first_seen),
                    to_iso(agent.last_seen),
                    json.dumps(list(agent.submolts)),
                    agent.claimed_karma,
                    agent.claimed_pnl_pct,
                ),
            )

    def get_agent(self, agent_id: str) -> AgentProfile | None:
        row = self.conn.execute(
            "SELECT * FROM agents WHERE agent_id=?", (agent_id,)
        ).fetchone()
        return _row_to_agent(row) if row else None

    def list_agents(self) -> list[AgentProfile]:
        rows = self.conn.execute("SELECT * FROM agents ORDER BY last_seen DESC").fetchall()
        return [_row_to_agent(r) for r in rows]

    # ----------------------------------------------------------------- posts

    def is_post_seen(self, post_id: str) -> bool:
        return (
            self.conn.execute(
                "SELECT 1 FROM seen_posts WHERE post_id=?", (post_id,)
            ).fetchone()
            is not None
        )

    def mark_posts_seen(self, post_ids: Iterable[str]) -> None:
        now = to_iso(utcnow())
        with self.tx() as c:
            c.executemany(
                "INSERT OR IGNORE INTO seen_posts(post_id, seen_at) VALUES (?,?)",
                [(p, now) for p in post_ids],
            )

    def prune_seen_posts(self, older_than_days: float = 30.0) -> int:
        cutoff = to_iso(utcnow() - timedelta(days=older_than_days))
        with self.tx() as c:
            cur = c.execute("DELETE FROM seen_posts WHERE seen_at < ?", (cutoff,))
        return cur.rowcount

    # --------------------------------------------------------------- signals

    def save_signal(self, sig: TradeSignal) -> bool:
        """Returns False if this signal was already recorded."""
        with self.tx() as c:
            cur = c.execute(
                """INSERT OR IGNORE INTO signals
                   (signal_id, agent_id, post_id, submolt, symbol, side, action,
                    confidence, observed_at, posted_at, raw_text, claimed_entry,
                    claimed_stop, claimed_target, extractor)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    sig.signal_id,
                    sig.agent_id,
                    sig.post_id,
                    sig.submolt,
                    sig.symbol,
                    sig.side.value,
                    sig.action.value,
                    sig.confidence,
                    to_iso(sig.observed_at),
                    to_iso(sig.posted_at),
                    sig.raw_text,
                    sig.claimed_entry,
                    sig.claimed_stop,
                    sig.claimed_target,
                    sig.extractor,
                ),
            )
        return cur.rowcount > 0

    def get_signal(self, signal_id: str) -> TradeSignal | None:
        row = self.conn.execute(
            "SELECT * FROM signals WHERE signal_id=?", (signal_id,)
        ).fetchone()
        return _row_to_signal(row) if row else None

    def recent_signals(self, limit: int = 50) -> list[TradeSignal]:
        rows = self.conn.execute(
            "SELECT * FROM signals ORDER BY observed_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [_row_to_signal(r) for r in rows]

    # ----------------------------------------------------------------- books

    def ensure_book(self, book: str, starting_cash: float) -> None:
        with self.tx() as c:
            c.execute(
                """INSERT OR IGNORE INTO books
                   (book, cash, starting_cash, peak_equity, created_at, active)
                   VALUES (?,?,?,?,?,1)""",
                (book, starting_cash, starting_cash, starting_cash, to_iso(utcnow())),
            )

    def get_book(self, book: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM books WHERE book=?", (book,)).fetchone()

    def list_books(self, prefix: str | None = None, active_only: bool = True) -> list[str]:
        sql = "SELECT book FROM books WHERE 1=1"
        args: list = []
        if prefix:
            sql += " AND book LIKE ?"
            args.append(f"{prefix}%")
        if active_only:
            sql += " AND active=1"
        return [r["book"] for r in self.conn.execute(sql, args).fetchall()]

    def set_cash(self, book: str, cash: float) -> None:
        with self.tx() as c:
            c.execute("UPDATE books SET cash=? WHERE book=?", (cash, book))

    def update_peak_equity(self, book: str, equity: float) -> None:
        with self.tx() as c:
            c.execute(
                "UPDATE books SET peak_equity=MAX(peak_equity, ?) WHERE book=?",
                (equity, book),
            )

    def deactivate_book(self, book: str) -> None:
        with self.tx() as c:
            c.execute("UPDATE books SET active=0 WHERE book=?", (book,))

    # ------------------------------------------------------------- positions

    def save_position(self, pos: Position) -> None:
        with self.tx() as c:
            c.execute(
                """INSERT OR REPLACE INTO positions
                   (position_id, book, symbol, side, quantity, entry_price, opened_at,
                    signal_id, agent_id, policy_id, stop_price, target_price,
                    max_hold_hours, fees_paid, features)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    pos.position_id,
                    pos.book,
                    pos.symbol,
                    pos.side.value,
                    pos.quantity,
                    pos.entry_price,
                    to_iso(pos.opened_at),
                    pos.signal_id,
                    pos.agent_id,
                    pos.policy_id,
                    pos.stop_price,
                    pos.target_price,
                    pos.max_hold_hours,
                    pos.fees_paid,
                    json.dumps(pos.features, sort_keys=True),
                ),
            )

    def delete_position(self, position_id: str) -> None:
        with self.tx() as c:
            c.execute("DELETE FROM positions WHERE position_id=?", (position_id,))

    def open_positions(self, book: str | None = None) -> list[Position]:
        if book:
            rows = self.conn.execute(
                "SELECT * FROM positions WHERE book=? ORDER BY opened_at", (book,)
            ).fetchall()
        else:
            rows = self.conn.execute("SELECT * FROM positions ORDER BY opened_at").fetchall()
        return [_row_to_position(r) for r in rows]

    def position_for_signal(self, book: str, signal_id: str) -> Position | None:
        row = self.conn.execute(
            "SELECT * FROM positions WHERE book=? AND signal_id=?", (book, signal_id)
        ).fetchone()
        return _row_to_position(row) if row else None

    # ---------------------------------------------------------------- trades

    def save_trade(self, trade: ClosedTrade) -> None:
        with self.tx() as c:
            c.execute(
                """INSERT OR REPLACE INTO trades
                   (trade_id, book, symbol, side, quantity, entry_price, exit_price,
                    opened_at, closed_at, pnl, fees, reason, signal_id, agent_id,
                    policy_id, features)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    trade.trade_id,
                    trade.book,
                    trade.symbol,
                    trade.side.value,
                    trade.quantity,
                    trade.entry_price,
                    trade.exit_price,
                    to_iso(trade.opened_at),
                    to_iso(trade.closed_at),
                    trade.pnl,
                    trade.fees,
                    trade.reason.value,
                    trade.signal_id,
                    trade.agent_id,
                    trade.policy_id,
                    json.dumps(trade.features, sort_keys=True),
                ),
            )

    def closed_trades(
        self, book: str | None = None, since: datetime | None = None, limit: int | None = None
    ) -> list[ClosedTrade]:
        sql = "SELECT * FROM trades WHERE 1=1"
        args: list = []
        if book:
            sql += " AND book=?"
            args.append(book)
        if since:
            sql += " AND closed_at >= ?"
            args.append(to_iso(since))
        sql += " ORDER BY closed_at"
        if limit:
            sql += " LIMIT ?"
            args.append(limit)
        return [_row_to_trade(r) for r in self.conn.execute(sql, args).fetchall()]

    def realized_pnl_since(self, book: str, since: datetime) -> float:
        row = self.conn.execute(
            "SELECT COALESCE(SUM(pnl - fees), 0) AS total FROM trades WHERE book=? AND closed_at >= ?",
            (book, to_iso(since)),
        ).fetchone()
        return float(row["total"])

    # ----------------------------------------------------------- agent score

    def save_agent_score(self, score: AgentScore) -> None:
        with self.tx() as c:
            c.execute(
                """INSERT OR REPLACE INTO agent_scores
                   (agent_id, reputation, sample_size, win_rate, profit_factor,
                    avg_pnl_pct, max_drawdown_pct, expectancy, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    score.agent_id,
                    score.reputation,
                    score.sample_size,
                    score.win_rate,
                    score.profit_factor,
                    score.avg_pnl_pct,
                    score.max_drawdown_pct,
                    score.expectancy,
                    to_iso(score.updated_at),
                ),
            )

    def get_agent_score(self, agent_id: str) -> AgentScore | None:
        row = self.conn.execute(
            "SELECT * FROM agent_scores WHERE agent_id=?", (agent_id,)
        ).fetchone()
        return _row_to_score(row) if row else None

    def list_agent_scores(self) -> list[AgentScore]:
        rows = self.conn.execute(
            "SELECT * FROM agent_scores ORDER BY reputation DESC"
        ).fetchall()
        return [_row_to_score(r) for r in rows]

    # -------------------------------------------------------------- policies

    def save_policy(
        self,
        policy_id: str,
        params: dict,
        status: str,
        parent_id: str | None = None,
        generation: int = 0,
        notes: str = "",
    ) -> None:
        with self.tx() as c:
            c.execute(
                """INSERT INTO policies
                   (policy_id, parent_id, generation, params, status, created_at, notes)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(policy_id) DO UPDATE SET
                     params=excluded.params, status=excluded.status, notes=excluded.notes""",
                (
                    policy_id,
                    parent_id,
                    generation,
                    json.dumps(params, sort_keys=True),
                    status,
                    to_iso(utcnow()),
                    notes,
                ),
            )

    def set_policy_status(self, policy_id: str, status: str) -> None:
        promoted = to_iso(utcnow()) if status == "champion" else None
        with self.tx() as c:
            c.execute(
                "UPDATE policies SET status=?, promoted_at=COALESCE(?, promoted_at) WHERE policy_id=?",
                (status, promoted, policy_id),
            )

    def get_policy(self, policy_id: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM policies WHERE policy_id=?", (policy_id,)
        ).fetchone()

    def policies_by_status(self, status: str) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM policies WHERE status=? ORDER BY created_at", (status,)
        ).fetchall()

    def record_evaluation(
        self,
        policy_id: str,
        champion_id: str,
        n_trades: int,
        challenger_mean: float,
        champion_mean: float,
        win_probability: float,
        drawdown_delta: float,
        decision: str,
        detail: str = "",
    ) -> None:
        with self.tx() as c:
            c.execute(
                """INSERT INTO evaluations
                   (policy_id, champion_id, n_trades, challenger_mean, champion_mean,
                    win_probability, drawdown_delta, decision, detail, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    policy_id,
                    champion_id,
                    n_trades,
                    challenger_mean,
                    champion_mean,
                    win_probability,
                    drawdown_delta,
                    decision,
                    detail,
                    to_iso(utcnow()),
                ),
            )

    def recent_evaluations(self, limit: int = 20) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM evaluations ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()

    # --------------------------------------------------------------- lessons

    def add_lesson(
        self, kind: str, text: str, symbol: str = "", agent_id: str = "", weight: float = 1.0
    ) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT INTO lessons (created_at, kind, symbol, agent_id, text, weight) VALUES (?,?,?,?,?,?)",
                (to_iso(utcnow()), kind, symbol, agent_id, text, weight),
            )

    def top_lessons(self, limit: int = 25) -> list[str]:
        rows = self.conn.execute(
            "SELECT text FROM lessons ORDER BY weight DESC, id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [r["text"] for r in rows]

    # -------------------------------------------------------------------- kv

    def set_kv(self, key: str, value: str) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT OR REPLACE INTO kv (key, value) VALUES (?,?)", (key, value)
            )

    def get_kv(self, key: str, default: str | None = None) -> str | None:
        row = self.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default


# --------------------------------------------------------------- row mappers


def _row_to_agent(row: sqlite3.Row) -> AgentProfile:
    return AgentProfile(
        agent_id=row["agent_id"],
        handle=row["handle"],
        first_seen=from_iso(row["first_seen"]),
        last_seen=from_iso(row["last_seen"]),
        submolts=tuple(json.loads(row["submolts"])),
        claimed_karma=row["claimed_karma"],
        claimed_pnl_pct=row["claimed_pnl_pct"],
    )


def _row_to_signal(row: sqlite3.Row) -> TradeSignal:
    from .models import Action  # local import avoids a cycle at module load

    return TradeSignal(
        signal_id=row["signal_id"],
        agent_id=row["agent_id"],
        post_id=row["post_id"],
        submolt=row["submolt"],
        symbol=row["symbol"],
        side=Side(row["side"]),
        action=Action(row["action"]),
        confidence=row["confidence"],
        observed_at=from_iso(row["observed_at"]),
        posted_at=from_iso(row["posted_at"]),
        raw_text=row["raw_text"],
        claimed_entry=row["claimed_entry"],
        claimed_stop=row["claimed_stop"],
        claimed_target=row["claimed_target"],
        extractor=row["extractor"],
    )


def _row_to_position(row: sqlite3.Row) -> Position:
    return Position(
        position_id=row["position_id"],
        book=row["book"],
        symbol=row["symbol"],
        side=Side(row["side"]),
        quantity=row["quantity"],
        entry_price=row["entry_price"],
        opened_at=from_iso(row["opened_at"]),
        signal_id=row["signal_id"],
        agent_id=row["agent_id"],
        policy_id=row["policy_id"],
        stop_price=row["stop_price"],
        target_price=row["target_price"],
        max_hold_hours=row["max_hold_hours"],
        fees_paid=row["fees_paid"],
        features=json.loads(row["features"]),
    )


def _row_to_trade(row: sqlite3.Row) -> ClosedTrade:
    return ClosedTrade(
        trade_id=row["trade_id"],
        book=row["book"],
        symbol=row["symbol"],
        side=Side(row["side"]),
        quantity=row["quantity"],
        entry_price=row["entry_price"],
        exit_price=row["exit_price"],
        opened_at=from_iso(row["opened_at"]),
        closed_at=from_iso(row["closed_at"]),
        pnl=row["pnl"],
        fees=row["fees"],
        reason=CloseReason(row["reason"]),
        signal_id=row["signal_id"],
        agent_id=row["agent_id"],
        policy_id=row["policy_id"],
        features=json.loads(row["features"]),
    )


def _row_to_score(row: sqlite3.Row) -> AgentScore:
    return AgentScore(
        agent_id=row["agent_id"],
        reputation=row["reputation"],
        sample_size=row["sample_size"],
        win_rate=row["win_rate"],
        profit_factor=row["profit_factor"],
        avg_pnl_pct=row["avg_pnl_pct"],
        max_drawdown_pct=row["max_drawdown_pct"],
        expectancy=row["expectancy"],
        updated_at=from_iso(row["updated_at"]),
    )
