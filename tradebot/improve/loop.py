"""Champion / challenger self-improvement.

How the bot trains itself:

  1. One **champion** policy trades the main book.
  2. N **challenger** policies, mutated from the champion and biased by
     attribution over past trades, see the *same live signal stream* and trade
     their own shadow books. They cost nothing and risk nothing.
  3. Once a challenger has closed `min_eval_trades`, its per-trade returns are
     compared with the champion's by bootstrap resampling.
  4. A challenger is promoted only if it beats the champion at the configured
     confidence **and** does not deepen drawdown. On promotion it takes over
     the main book and a fresh generation of challengers is spawned from it.

Two properties matter more than the search itself. Every challenger is
clamped to the operator's `RiskLimits`, so training cannot widen risk. And
evaluation is forward-only -- challengers are judged on signals that arrived
after they were created, never replayed over the history that produced them,
which is what stops the loop from congratulating itself on hindsight.
"""

from __future__ import annotations

import logging
import random
import statistics
from dataclasses import dataclass
from typing import Sequence

from ..config import Config
from ..models import ClosedTrade, MAIN_BOOK, policy_book
from ..store import Store
from .attribution import Attribution, attribute, lessons_from
from .policy import Policy, distance

log = logging.getLogger(__name__)

STATUS_CHAMPION = "champion"
STATUS_CHALLENGER = "challenger"
STATUS_RETIRED = "retired"

CYCLE_KEY = "improve.cycle"


@dataclass
class PromotionResult:
    policy_id: str
    decision: str
    win_probability: float
    challenger_mean: float
    champion_mean: float
    drawdown_delta: float
    n_trades: int
    detail: str = ""


def bootstrap_win_probability(
    challenger: Sequence[float],
    champion: Sequence[float],
    samples: int,
    rng: random.Random,
) -> float:
    """P(challenger's mean beats the champion's) under resampling.

    A plain two-sample bootstrap rather than a t-test: trade returns are
    fat-tailed and skewed, and this makes no normality assumption.
    """
    if not challenger:
        return 0.0
    if not champion:
        # No champion baseline to beat -- ask instead whether the challenger
        # is convincingly profitable on its own.
        wins = 0
        n = len(challenger)
        for _ in range(samples):
            resample = [challenger[rng.randrange(n)] for _ in range(n)]
            if statistics.fmean(resample) > 0.0:
                wins += 1
        return wins / samples

    wins = 0
    n_a, n_b = len(challenger), len(champion)
    for _ in range(samples):
        a = statistics.fmean([challenger[rng.randrange(n_a)] for _ in range(n_a)])
        b = statistics.fmean([champion[rng.randrange(n_b)] for _ in range(n_b)])
        if a > b:
            wins += 1
    return wins / samples


class SelfImprovementLoop:
    def __init__(self, store: Store, config: Config) -> None:
        self.store = store
        self.config = config
        self.limits = config.risk
        self.settings = config.improvement
        self.rng = random.Random(config.improvement.seed)

    # ------------------------------------------------------------ population

    def champion(self) -> Policy:
        rows = self.store.policies_by_status(STATUS_CHAMPION)
        if rows:
            import json

            return Policy.from_params(json.loads(rows[-1]["params"]))
        seed = Policy.seed(self.limits)
        self.store.save_policy(
            seed.policy_id, seed.to_params(), STATUS_CHAMPION, notes="seed policy"
        )
        log.info("seeded champion policy %s", seed.describe())
        return seed

    def challengers(self) -> list[Policy]:
        import json

        return [
            Policy.from_params(json.loads(row["params"]))
            for row in self.store.policies_by_status(STATUS_CHALLENGER)
        ]

    def attribution(self) -> Attribution:
        """Attribute over trades from every book that a policy drove.

        Pooling across policies is what gives the exit and sizing parameters
        any variance to learn from -- within one policy they are constants.
        """
        trades = [t for t in self.store.closed_trades() if not t.book.startswith("agent:")]
        return attribute(trades)

    def ensure_population(self) -> tuple[Policy, list[Policy]]:
        """Top the challenger pool back up to the configured size."""
        champion = self.champion()
        if not self.settings.enabled or self.settings.challengers <= 0:
            return champion, []

        existing = self.challengers()
        missing = self.settings.challengers - len(existing)
        if missing <= 0:
            return champion, existing

        hints = self.attribution().hints
        spawned: list[Policy] = []
        for _ in range(missing):
            # A few attempts to land somewhere meaningfully different from the
            # policies already in the pool, so the pool does not collapse.
            best: Policy | None = None
            best_gap = -1.0
            for _ in range(6):
                candidate = champion.mutate(
                    self.rng, self.limits, self.settings.mutation_scale, hints
                )
                gap = min(
                    (distance(candidate, other) for other in existing + spawned),
                    default=1.0,
                )
                if gap > best_gap:
                    best, best_gap = candidate, gap
            assert best is not None
            self.store.save_policy(
                best.policy_id,
                best.to_params(),
                STATUS_CHALLENGER,
                parent_id=best.parent_id,
                generation=best.generation,
                notes=f"spawned from {champion.policy_id}",
            )
            self.store.ensure_book(
                policy_book(best.policy_id), self.config.trading.starting_cash
            )
            spawned.append(best)
            log.info("spawned challenger %s", best.describe())

        return champion, existing + spawned

    # ------------------------------------------------------------ evaluation

    def evaluate(self) -> list[PromotionResult]:
        """Score every challenger; promote at most one per call."""
        if not self.settings.enabled:
            return []

        champion = self.champion()
        champion_trades = self.store.closed_trades(MAIN_BOOK)
        champion_returns = [t.pnl_pct for t in champion_trades]
        champion_dd = _drawdown(champion_trades)

        results: list[PromotionResult] = []
        candidates: list[tuple[float, PromotionResult, Policy]] = []

        for challenger in self.challengers():
            trades = self.store.closed_trades(policy_book(challenger.policy_id))
            returns = [t.pnl_pct for t in trades]

            if len(returns) < self.settings.min_eval_trades:
                results.append(
                    PromotionResult(
                        policy_id=challenger.policy_id,
                        decision="pending",
                        win_probability=0.0,
                        challenger_mean=statistics.fmean(returns) if returns else 0.0,
                        champion_mean=statistics.fmean(champion_returns)
                        if champion_returns
                        else 0.0,
                        drawdown_delta=0.0,
                        n_trades=len(returns),
                        detail=f"{len(returns)}/{self.settings.min_eval_trades} trades",
                    )
                )
                continue

            probability = bootstrap_win_probability(
                returns,
                champion_returns,
                self.settings.bootstrap_samples,
                self.rng,
            )
            drawdown_delta = _drawdown(trades) - champion_dd

            if probability >= self.settings.promote_confidence:
                if drawdown_delta > self.settings.max_drawdown_regression_pct:
                    decision, detail = "rejected", (
                        f"beat champion on returns but drawdown worse by "
                        f"{drawdown_delta:.2f}pp > "
                        f"{self.settings.max_drawdown_regression_pct:.2f}pp"
                    )
                else:
                    decision, detail = "promote", "beat champion on returns and drawdown"
            elif probability < self.settings.retire_confidence:
                decision, detail = "rejected", (
                    f"win probability {probability:.3f} < "
                    f"{self.settings.retire_confidence:.3f}"
                )
            else:
                # Inconclusive: neither clearly better nor clearly worse. Let
                # it keep trading -- killing it here would discard a possibly
                # good policy on a sample too small to tell.
                decision, detail = "inconclusive", (
                    f"win probability {probability:.3f} between "
                    f"{self.settings.retire_confidence:.3f} and "
                    f"{self.settings.promote_confidence:.3f}; gathering more trades"
                )

            result = PromotionResult(
                policy_id=challenger.policy_id,
                decision=decision,
                win_probability=round(probability, 4),
                challenger_mean=round(statistics.fmean(returns), 4),
                champion_mean=round(
                    statistics.fmean(champion_returns) if champion_returns else 0.0, 4
                ),
                drawdown_delta=round(drawdown_delta, 4),
                n_trades=len(returns),
                detail=detail,
            )
            results.append(result)
            self.store.record_evaluation(
                policy_id=challenger.policy_id,
                champion_id=champion.policy_id,
                n_trades=result.n_trades,
                challenger_mean=result.challenger_mean,
                champion_mean=result.champion_mean,
                win_probability=result.win_probability,
                drawdown_delta=result.drawdown_delta,
                decision=decision,
                detail=detail,
            )
            if decision == "promote":
                candidates.append((probability, result, challenger))
            elif decision == "inconclusive":
                pass  # keep it in the pool, keep gathering evidence
            elif decision == "rejected":
                self.store.set_policy_status(challenger.policy_id, STATUS_RETIRED)
                self.store.deactivate_book(policy_book(challenger.policy_id))

        if candidates:
            # Only ever promote the single strongest candidate: swapping the
            # champion is the one irreversible act in this loop.
            _, best_result, best_policy = max(candidates, key=lambda c: c[0])
            self._promote(champion, best_policy)
            for _, other, policy in candidates:
                if policy.policy_id != best_policy.policy_id:
                    other.decision = "runner_up"
                    self.store.set_policy_status(policy.policy_id, STATUS_RETIRED)

        return results

    def _promote(self, old: Policy, new: Policy) -> None:
        self.store.set_policy_status(old.policy_id, STATUS_RETIRED)
        self.store.set_policy_status(new.policy_id, STATUS_CHAMPION)
        self.store.deactivate_book(policy_book(new.policy_id))
        log.info(
            "PROMOTED %s -> %s (%s)", old.policy_id, new.policy_id, new.describe()
        )
        # Everything left in the pool was bred from the old champion; start
        # a fresh generation from the new one.
        for challenger in self.challengers():
            self.store.set_policy_status(challenger.policy_id, STATUS_RETIRED)
            self.store.deactivate_book(policy_book(challenger.policy_id))

    # --------------------------------------------------------------- lessons

    def refresh_lessons(self, limit: int = 10) -> list[str]:
        """Write post-mortems on recent losers back into the lesson store."""
        trades = self.store.closed_trades(MAIN_BOOK)
        lessons = lessons_from(trades, limit=limit)
        for lesson in lessons:
            self.store.add_lesson("post_mortem", lesson)
        return lessons

    # ---------------------------------------------------------------- cycles

    def bump_cycle(self) -> int:
        current = int(self.store.get_kv(CYCLE_KEY, "0") or 0) + 1
        self.store.set_kv(CYCLE_KEY, str(current))
        return current


def _drawdown(trades: Sequence[ClosedTrade]) -> float:
    """Max peak-to-trough drawdown of a cumulative return series, in points."""
    equity = 0.0
    peak = 0.0
    worst = 0.0
    for trade in sorted(trades, key=lambda t: t.closed_at):
        equity += trade.pnl_pct
        peak = max(peak, equity)
        worst = max(worst, peak - equity)
    return worst
