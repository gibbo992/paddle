"""Command line interface."""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import sys
import time
from pathlib import Path

from .config import Config, DEFAULT_CONFIG_PATH, ImprovementConfig, LLMConfig, load_config
from .engine import Engine
from .improve.loop import SelfImprovementLoop
from .models import MAIN_BOOK, agent_book
from .moltbook.client import MoltbookClient, MoltbookError
from .scoring.reputation import ReputationScorer
from .signals import HybridExtractor, RuleExtractor
from .simulation import SimulatedMarket, SimulatedMoltbook, default_agents
from .store import Store

EXAMPLE_CONFIG = Path(__file__).resolve().parent.parent / "config.example.yaml"


def _setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def _print_table(rows: list[tuple], headers: tuple) -> None:
    if not rows:
        print("  (nothing yet)")
        return
    widths = [
        max(len(str(headers[i])), max(len(str(r[i])) for r in rows))
        for i in range(len(headers))
    ]
    line = "  ".join(str(h).ljust(w) for h, w in zip(headers, widths))
    print("  " + line)
    print("  " + "-" * len(line))
    for row in rows:
        print("  " + "  ".join(str(c).ljust(w) for c, w in zip(row, widths)))


# ------------------------------------------------------------------ commands


def cmd_init(args: argparse.Namespace) -> int:
    target = Path(args.path or DEFAULT_CONFIG_PATH)
    if target.exists() and not args.force:
        print(f"{target} already exists; pass --force to overwrite")
        return 1
    if not EXAMPLE_CONFIG.exists():
        print(f"template missing: {EXAMPLE_CONFIG}")
        return 1
    target.write_text(EXAMPLE_CONFIG.read_text())
    print(f"wrote {target}")
    print("\nNext steps:")
    print("  1. export MOLTBOOK_API_KEY=...   (and ANTHROPIC_API_KEY for LLM parsing)")
    print("  2. tradebot verify-api           # confirm the endpoint paths are right")
    print("  3. tradebot demo                 # watch the loop run on simulated data")
    print("  4. tradebot run                  # paper trade against live Moltbook")
    return 0


def cmd_verify_api(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    print(f"Probing {config.moltbook.base_url}\n")
    if not config.moltbook.api_key():
        print(f"WARNING: ${config.moltbook.api_key_env} is not set; expect auth failures.\n")

    with MoltbookClient(config.moltbook) as client:
        try:
            results = client.verify()
        except MoltbookError as exc:
            print(f"could not reach Moltbook: {exc}")
            return 1

    failures = 0
    for name, status in sorted(results.items()):
        marker = "ok  " if status.startswith("ok") else "FAIL"
        if not status.startswith(("ok", "skipped")):
            failures += 1
        print(f"  [{marker}] {name:<16} {status}")

    print(
        "\nEndpoint paths live under `moltbook.endpoints` in your config file. "
        "Correct any failures there -- they are best-effort defaults, not verified routes."
    )
    return 1 if failures else 0


def cmd_join(args: argparse.Namespace) -> int:
    """Register this bot as a Moltbook agent."""
    config = load_config(args.config)
    print(f"Registering '{args.name}' at {config.moltbook.base_url}\n")

    with MoltbookClient(config.moltbook) as client:
        try:
            result = client.register(args.name, args.bio)
        except MoltbookError as exc:
            print(f"registration failed: {exc}\n")
            print(
                "If this is a connection or 403-at-CONNECT error, the network "
                "policy for this environment is blocking moltbook.com rather "
                "than Moltbook rejecting you. If it is a 404, correct "
                "`moltbook.endpoints.register` in your config -- that path is "
                "an unverified default."
            )
            return 1

    print("Registered.\n")
    for key in ("agent_id", "api_key", "verification_code", "claim_url"):
        if value := result.get(key):
            print(f"  {key:<18} {value}")

    print("\nNext steps (the claim step is yours, not the bot's):")
    print(f"  1. export MOLTBOOK_API_KEY='{result.get('api_key') or '<api key above>'}'")
    if result.get("claim_url"):
        print(f"  2. open {result['claim_url']} and enter the verification code")
    print("  3. tradebot verify-api    # confirm the endpoint paths are right")
    print(
        "\nStore the API key in your environment or a secret manager -- do not "
        "commit it to the repo."
    )
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    _setup_logging(args.log_level or config.log_level)
    store = Store(config.database_path)
    engine = Engine(config, store)

    if config.trading.is_live():
        print("!! LIVE TRADING IS ENABLED -- real orders will be placed !!")
    else:
        print(f"running in {config.trading.mode.value} mode (no real orders)")

    try:
        cycles = 0
        while args.cycles == 0 or cycles < args.cycles:
            report = engine.run_cycle()
            print(report.summary())
            for note in report.promotions:
                print(f"  PROMOTED: {note}")
            for err in report.errors[:5]:
                print(f"  error: {err}")
            cycles += 1
            if args.cycles and cycles >= args.cycles:
                break
            time.sleep(args.interval or config.cycle_seconds)
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        engine.close()
        store.close()
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    store = Store(config.database_path)
    engine = Engine(config, store)
    try:
        status = engine.status()
    finally:
        engine.close()

    print(f"mode        : {status['mode']} (live confirmed: {status['live_confirmed']})")
    print(f"broker      : {status['broker']}")
    print(f"champion    : {status['champion']}")
    print(f"challengers : {', '.join(status['challengers']) or 'none'}")  # type: ignore[arg-type]
    print(f"agents      : {status['tracked_agents']} tracked")
    print(f"attribution : {status['attribution']}")
    print("\nmain book:")
    for key, value in status["main"].items():  # type: ignore[union-attr]
        print(f"  {key:<16} {value:,.4f}" if isinstance(value, float) else f"  {key:<16} {value}")
    store.close()
    return 0


def cmd_agents(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    store = Store(config.database_path)
    scores = store.list_agent_scores()[: args.limit]
    rows = []
    for score in scores:
        agent = store.get_agent(score.agent_id)
        rows.append(
            (
                (agent.handle if agent else score.agent_id)[:20],
                f"{score.reputation:.3f}",
                score.sample_size,
                f"{score.win_rate:.2%}",
                f"{score.avg_pnl_pct:+.2f}%",
                f"{score.profit_factor:.2f}",
                f"{score.max_drawdown_pct:.1f}%",
                "yes" if score.is_trusted else "no",
            )
        )
    print("Agent reputation (from forward-tested shadow trades only):\n")
    _print_table(
        rows,
        ("agent", "rep", "n", "win", "avg pnl", "pf", "maxdd", "trusted"),
    )
    store.close()
    return 0


def cmd_policy(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    store = Store(config.database_path)
    loop = SelfImprovementLoop(store, config)

    print("champion:")
    print(f"  {loop.champion().describe()}")
    print("\nchallengers:")
    for policy in loop.challengers():
        print(f"  {policy.describe()}")
    if not loop.challengers():
        print("  (none active)")

    print(f"\nattribution: {loop.attribution().describe()}")
    for note in loop.attribution().notes:
        print(f"  note: {note}")

    print("\nrecent evaluations:")
    rows = [
        (
            row["policy_id"],
            row["decision"],
            row["n_trades"],
            f"{row['win_probability']:.3f}",
            f"{row['challenger_mean']:+.3f}",
            f"{row['champion_mean']:+.3f}",
            row["detail"][:40],
        )
        for row in store.recent_evaluations(args.limit)
    ]
    _print_table(rows, ("policy", "decision", "n", "p(win)", "chal", "champ", "detail"))
    store.close()
    return 0


def cmd_signals(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    store = Store(config.database_path)
    rows = [
        (
            s.observed_at.strftime("%m-%d %H:%M"),
            s.agent_id[:16],
            s.symbol,
            s.side.value,
            s.action.value,
            f"{s.confidence:.2f}",
            s.extractor,
        )
        for s in store.recent_signals(args.limit)
    ]
    _print_table(rows, ("seen", "agent", "symbol", "side", "action", "conf", "via"))
    store.close()
    return 0


def cmd_demo(args: argparse.Namespace) -> int:
    """Run the whole loop against a simulated Moltbook and market."""
    _setup_logging(args.log_level or "WARNING")

    config = dataclasses.replace(
        load_config(args.config) if args.config else Config(),
        database_path=args.db,
        llm=LLMConfig(enabled=False),
        improvement=ImprovementConfig(
            enabled=True,
            challengers=4,
            min_eval_trades=args.min_eval_trades,
            bootstrap_samples=800,
            promote_confidence=0.85,
            seed=args.seed,
        ),
    ).validate()

    if Path(args.db).exists() and not args.keep:
        Path(args.db).unlink()

    market = SimulatedMarket(seed=args.seed, steps=args.cycles + 20)
    agents = default_agents()
    store = Store(config.database_path)
    engine = Engine(
        config,
        store,
        client=SimulatedMoltbook(market, agents, seed=args.seed),  # type: ignore[arg-type]
        feed=market,  # type: ignore[arg-type]
        extractor=HybridExtractor(RuleExtractor(market.now), None),
        clock=market.now,
    )

    print(f"Simulating {args.cycles} cycles over {len(agents)} agents...\n")
    promotions: list[str] = []
    for _ in range(args.cycles):
        report = engine.run_cycle()
        promotions.extend(report.promotions)
        market.advance()
        if args.verbose:
            print(report.summary())

    print("\n=== Agent reputation vs. true simulated skill ===")
    print("(reputation is derived only from forward-tested shadow trades)\n")
    scorer = ReputationScorer(config.reputation)
    scorer.rescore_all(store, config.trading.starting_cash)
    truth = {a.agent_id: a.skill for a in agents}
    rows = []
    for score in store.list_agent_scores():
        trades = store.closed_trades(agent_book(score.agent_id))
        rows.append(
            (
                score.agent_id[:18],
                f"{truth.get(score.agent_id, 0.0):.2f}",
                f"{score.reputation:.3f}",
                len(trades),
                f"{score.win_rate:.0%}",
                f"{score.avg_pnl_pct:+.2f}%",
                "yes" if score.is_trusted else "no",
            )
        )
    _print_table(
        rows, ("agent", "true skill", "reputation", "n", "win", "avg pnl", "trusted")
    )

    marks = market.prices(list(market.symbols))
    summary = engine.main.summary(marks)
    print("\n=== Main book ===\n")
    for key, value in summary.items():
        print(f"  {key:<16} {value:,.4f}")

    print("\n=== Self-improvement ===\n")
    print(f"  champion   : {engine.improve.champion().describe()}")
    print(f"  attribution: {engine.improve.attribution().describe()}")
    print(f"  promotions : {len(promotions)}")
    for note in promotions:
        print(f"    - {note}")

    engine.close()
    store.close()
    print(
        "\nNote: simulated agents have known skill by construction. On the real "
        "Moltbook nobody's skill is known, which is exactly why nothing here "
        "trusts a self-reported number."
    )
    return 0


# -------------------------------------------------------------------- parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tradebot",
        description="Copy-trading agent for Moltbook, with a self-improvement loop.",
    )
    parser.add_argument("--config", help="path to config.yaml")
    parser.add_argument("--log-level", help="DEBUG, INFO, WARNING, ERROR")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init", help="write a starter config.yaml")
    p.add_argument("path", nargs="?", help="destination (default: config.yaml)")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("join", help="register this bot as a Moltbook agent")
    p.add_argument("--name", required=True, help="agent name to register")
    p.add_argument("--bio", default="Copy-trading research agent.", help="agent bio")
    p.set_defaults(func=cmd_join)

    p = sub.add_parser("verify-api", help="probe the configured Moltbook endpoints")
    p.set_defaults(func=cmd_verify_api)

    p = sub.add_parser("run", help="run trading cycles")
    p.add_argument("--cycles", type=int, default=0, help="0 = run forever")
    p.add_argument("--interval", type=float, default=0.0, help="seconds between cycles")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("status", help="show books, policy, and limits")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("agents", help="show agent reputation")
    p.add_argument("--limit", type=int, default=25)
    p.set_defaults(func=cmd_agents)

    p = sub.add_parser("policy", help="show champion, challengers, evaluations")
    p.add_argument("--limit", type=int, default=15)
    p.set_defaults(func=cmd_policy)

    p = sub.add_parser("signals", help="show recently extracted signals")
    p.add_argument("--limit", type=int, default=25)
    p.set_defaults(func=cmd_signals)

    p = sub.add_parser("demo", help="run the loop on a simulated Moltbook")
    p.add_argument("--cycles", type=int, default=120)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--db", default="demo.db")
    p.add_argument("--min-eval-trades", type=int, default=15, dest="min_eval_trades")
    p.add_argument("--keep", action="store_true", help="keep an existing demo db")
    p.add_argument("--verbose", action="store_true")
    p.set_defaults(func=cmd_demo)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command != "demo":
        _setup_logging(args.log_level or "INFO")
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        logging.getLogger("tradebot").exception("command failed")
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
