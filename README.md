# TradeBot

A copy-trading agent that mines [Moltbook](https://www.moltbook.com) — the social
network whose users are AI agents — for trade calls, forward-tests the agents
making them, copies the ones that earn it, and tunes its own behaviour over time.

**Paper trading by default. No live venue adapter ships with this repo.**

---

## Read this before you run it

The premise — "find successful agents on Moltbook and copy them" — has a hole in
it, and the whole design is built around that hole:

- **Claimed performance is worthless.** On a network where every user is a
  program, "up 340% this quarter" costs nothing to type. Nothing here reads a
  claimed P&L, karma score, or follower count as evidence.
- **The winners you can see are the survivors.** Agents who blew up stopped
  posting. Ranking by visible returns selects for luck and for whoever took the
  most leverage and lived.
- **Copying is exploitable.** An agent that knows it is being copied can post a
  position, wait for followers to push the price, and exit into them. Latency
  between their post and your fill is a cost you pay every time.

So TradeBot never copies an agent on the strength of what they say. When it first
sees an agent it opens a **shadow book** for them and follows every call they make
with fake money at independently-sourced prices. Only after those calls have
closed does that agent have a record, and only then can they be copied with real
size. That is the central mechanic, and it is what the reputation score measures.

None of this makes copy trading a good way to make money. It makes the bot honest
about what it actually knows. Run it on paper for a long time before you consider
anything else.

---

## How it works

One cycle:

```
 1. sweep      Moltbook submolts + semantic search -> unseen posts
 2. extract    posts -> structured TradeSignals (regex prefilter, then Claude)
 3. exits      mark open positions, take stops / targets / time exits first
 4. route      each signal goes to every book at once:
                 agent:<id>   forward-test of that agent (always, no filter)
                 main         the champion policy's real book
                 policy:<id>  each challenger policy's shadow book
 5. rescore    recompute agent reputation from closed shadow trades
 6. improve    evaluate challengers, maybe promote, refresh lessons
```

Every book is the same `Ledger` over the same tables, which is what makes "how
would this agent have done?" and "how would this policy have done?" answerable
with the accounting the real book uses.

### Signal extraction

A regex pass (`RuleExtractor`) handles the obvious cases and acts as a prefilter
so Claude only sees plausible trade posts. Claude then does a structured-output
pass over those, which catches the phrasing regexes miss. The bot still runs
without an Anthropic key — just on regexes alone.

Post text is treated as **data, never instructions**. The extraction prompt says
so explicitly, because posts on Moltbook are written by other agents and some of
them will try to talk yours into something.

### Reputation

Computed only from forward-tested shadow trades, with:

- **recency decay** (21-day half-life by default) so last quarter outweighs last year
- **shrinkage toward a sceptical prior** (0.35, deliberately below the 0.5 trust
  line) so three lucky wins do not read as skill
- **a drawdown penalty** — a 60% win rate means nothing at a 40% drawdown

### The self-improvement loop

Behaviour is a set of numbers (`improve/policy.py`): who to copy, how sure to be,
how big to go, when to get out. One **champion** trades the main book. Four
**challengers**, mutated from it, see the same live signals and trade shadow books.

Mutations are not blind — `improve/attribution.py` reads the feature snapshot on
every closed trade, asks per feature whether high values earned more than low
ones, and biases the next round of mutations accordingly. Losing trades also
produce written post-mortems that feed back into the extraction prompt.

A challenger is judged by **bootstrap resampling** of per-trade returns against
the champion's, and the verdict is three-way:

| P(challenger beats champion) | Outcome |
|---|---|
| ≥ `promote_confidence` (0.90) | promoted — takes the main book, new generation spawned |
| ≤ `retire_confidence` (0.35) | retired |
| in between | keeps trading and gathering evidence |

Promotion also requires that drawdown not regress. Evaluation is forward-only:
challengers are judged on signals that arrived *after* they were created, never
replayed over the history that bred them.

Promotions are rare by design. A run where nothing gets promoted is the loop
working — it means nothing beat the incumbent by enough to be worth the swap.

### Safety model

Two things are deliberately outside the loop's reach:

1. **`config.risk` is never mutated.** Every mutated policy is passed through
   `Policy.clamp()` against those limits before it is allowed to trade, so
   training can change *what* the bot trades but never *how much it can lose*.
   `tests/test_policy_safety.py` hammers this with 1000 compounding mutations at
   an absurd scale and asserts nothing escapes.
2. **The eligibility floor.** `reputation.min_track_record` and a reputation of
   ≥ 0.50 are required before an agent is copied into any real book, regardless
   of what a policy would prefer. Without this the loop could learn its way out
   of the "prove yourself first" rule, which is the only thing standing between
   the bot and a fabricated track record.

Plus: a drawdown kill switch that flattens everything, a daily loss limit, per
position / per asset / gross exposure caps, a forced stop on every position even
when the post named none, and adverse slippage and fees on every simulated fill.

**Live trading needs three separate things**: `mode: live`, `live_trading_confirmed:
true`, *and* a broker adapter you wrote yourself. `execution/broker.py` defines the
seam and refuses to run without it. Wiring a real venue needs decisions this repo
cannot make for you — which exchange, which account, spot or margin, custody — and
getting any of them wrong moves real money.

---

## Quickstart

```bash
pip install -e ".[dev]"
tradebot init                  # writes config.yaml
tradebot demo --cycles 250     # full loop on a simulated Moltbook, no network
```

The demo builds a synthetic population of agents with *known* skill levels and
shows whether reputation recovers them — the one claim the design rests on:

```
  agent          true skill  reputation  n   win  avg pnl  trusted
  ----------------------------------------------------------------
  alpha_quant    0.85        0.720       42  64%  +5.40%   yes
  steady_edge    0.60        0.661       41  54%  +4.18%   yes
  mean_reverter  0.35        0.627       40  55%  +2.96%   yes
  coinflip_carl  0.05        0.530       49  49%  +1.10%   yes
  lucky_larry    0.15        0.375       36  36%  -0.53%   no
  hype_maxi      0.00        0.336       54  35%  -1.22%   no
```

Ranking tracks true skill, and the shrinkage prior keeps thin records off the
trusted list. Note `coinflip_carl` sitting too high — with ~50 trades the
estimator still gets fooled sometimes. That is the honest error bar.

### Going live against Moltbook

```bash
tradebot join --name YourBotName    # register; returns api_key + claim_url
export MOLTBOOK_API_KEY=moltbook_xxx
export ANTHROPIC_API_KEY=sk-ant-... # optional; enables LLM extraction
tradebot verify-api                 # probe every configured route
tradebot run --cycles 1             # one paper cycle
```

`join` prints a `claim_url` and verification code. **A human has to complete that
step** — verify an email, then post a verification tweet. The bot cannot claim
itself, by design.

`verify-api` matters: endpoint paths live in config, not in code. If Moltbook
moves a route, fix the YAML rather than the source.

### Other commands

```bash
tradebot status     # books, champion policy, limits, attribution
tradebot agents     # reputation table
tradebot policy     # champion, challengers, evaluation history
tradebot signals    # recently extracted signals
```

---

## Configuration

Everything lives in `config.yaml`; see `config.example.yaml` for the annotated
version. Secrets are read from the environment only — `MOLTBOOK_API_KEY`,
`ANTHROPIC_API_KEY`, `MARKETDATA_API_KEY`. The Moltbook key is only ever attached
to requests to `www.moltbook.com`; the client checks the host at request time and
refuses otherwise, since `base_url` is operator-editable.

**A price feed is required.** The bot marks every position itself rather than
believing prices quoted in posts, so `market_data` must point at a real quote API
(`provider: http`) before live paper trading means anything. The `static` default
exists for the demo and tests.

---

## Layout

```
tradebot/
  config.py          layered config; RiskLimits are the hard ceilings
  models.py          domain types shared across layers
  store.py           sqlite schema + DAO (all books in one place)
  moltbook/          HTTP client, post normalisation, discovery
  signals.py         rule + Claude extraction
  llm.py             thin Anthropic wrapper (structured output, prompt caching)
  marketdata.py      independent price feeds
  execution/         ledger, paper broker, hard risk gates
  scoring/           forward-tested reputation
  improve/           policy, attribution, champion/challenger loop
  engine.py          cycle orchestration
  simulation.py      synthetic Moltbook + market for offline testing
  cli.py
```

```bash
python -m pytest        # 152 tests
```

---

## Known gaps

- **No live broker.** Paper execution only; the seam is `execution/broker.py`.
- **Endpoint paths are config, not gospel.** They follow Moltbook's published
  skill doc, but run `verify-api` against the live API before trusting them.
- **Submolt names are unconfirmed.** Only `general` and `announcements` are
  documented as existing. Note that submolts default to `allow_crypto: false`
  and auto-remove crypto posts, so crypto calls concentrate in crypto-flagged
  communities you will need to find and add.
- **The margin model is crude** — a short reserves the same cash as a long.
  Conservative and symmetric, but not what a real venue charges.
- **No heartbeat / posting behaviour.** This bot reads Moltbook; it does not post,
  comment, vote, or follow. Adding autonomous posting is a separate decision with
  its own risks and should be an explicit opt-in, not a side effect of copy trading.
