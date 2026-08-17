"""Configuration loading.

The important structural decision lives here: `RiskLimits` are *hard bounds*
owned by the human operator. The self-improvement loop may tune a `Policy`
(see improve/policy.py) but every mutated policy is clamped against these
limits, so training can never widen the bot's risk appetite beyond what the
operator wrote in the config file.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import yaml

from .models import Mode

DEFAULT_CONFIG_PATH = Path("config.yaml")


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class MoltbookConfig:
    # Must include `www`. Moltbook redirects the bare domain, and the redirect
    # strips the Authorization header -- requests would silently 401.
    base_url: str = "https://www.moltbook.com"
    api_key_env: str = "MOLTBOOK_API_KEY"
    user_agent: str = "TradeBot/0.1"
    # Documented limits: 60 reads/60s, 30 writes/60s.
    requests_per_minute: int = 55
    timeout_seconds: float = 20.0
    max_retries: int = 3
    # Submolts to mine for trade talk. Only `general` and `announcements` are
    # documented as existing -- confirm the rest with `tradebot verify-api`
    # before relying on them.
    submolts: tuple[str, ...] = ("general",)
    endpoints: dict[str, str] = field(
        default_factory=lambda: {
            "register": "/api/v1/agents/register",
            "me": "/api/v1/agents/me",
            "status": "/api/v1/agents/status",
            "home": "/api/v1/home",
            "posts": "/api/v1/posts",
            "feed": "/api/v1/feed",
            "submolt_posts": "/api/v1/submolts/{submolt}/feed",
            "post_comments": "/api/v1/posts/{post_id}/comments",
            "profile": "/api/v1/agents/profile",
            "submolts": "/api/v1/submolts",
            "search": "/api/v1/search",
        }
    )
    # Moltbook is not consistent about its envelope: `/posts` returns `posts`,
    # `/search` returns `results`, and the generic wrapper is `{success, data}`.
    # The client falls back through several paths, so this is only the hint.
    response_paths: dict[str, str] = field(
        default_factory=lambda: {
            "items": "posts",
            "next_cursor": "next_cursor",
        }
    )

    def api_key(self) -> str | None:
        return os.environ.get(self.api_key_env) or None


@dataclass(frozen=True)
class TradingConfig:
    mode: Mode = Mode.PAPER
    base_currency: str = "USD"
    starting_cash: float = 10_000.0
    # Live trading is gated by two independent switches so that flipping
    # `mode` alone can never move real money.
    live_trading_confirmed: bool = False
    broker: str = "paper"
    fee_bps: float = 10.0
    slippage_bps: float = 5.0
    allowed_symbols: tuple[str, ...] = ()
    blocked_symbols: tuple[str, ...] = ()

    def is_live(self) -> bool:
        return self.mode is Mode.LIVE and self.live_trading_confirmed


@dataclass(frozen=True)
class RiskLimits:
    """Hard ceilings. Policies are clamped to these; they are never mutated."""

    max_position_pct: float = 5.0
    max_gross_exposure_pct: float = 60.0
    max_concurrent_positions: int = 8
    per_asset_cap_pct: float = 15.0
    daily_loss_limit_pct: float = 4.0
    max_drawdown_pct: float = 20.0
    min_stop_loss_pct: float = 1.0
    max_stop_loss_pct: float = 25.0
    max_hold_hours: float = 168.0
    min_trade_notional: float = 10.0

    def validate(self) -> None:
        if not 0 < self.max_position_pct <= 100:
            raise ConfigError("risk.max_position_pct must be in (0, 100]")
        if self.max_position_pct > self.per_asset_cap_pct:
            raise ConfigError("risk.max_position_pct cannot exceed per_asset_cap_pct")
        if self.per_asset_cap_pct > self.max_gross_exposure_pct:
            raise ConfigError("risk.per_asset_cap_pct cannot exceed max_gross_exposure_pct")
        if self.min_stop_loss_pct >= self.max_stop_loss_pct:
            raise ConfigError("risk.min_stop_loss_pct must be below max_stop_loss_pct")
        if self.max_concurrent_positions < 1:
            raise ConfigError("risk.max_concurrent_positions must be >= 1")


@dataclass(frozen=True)
class ImprovementConfig:
    enabled: bool = True
    challengers: int = 4
    # A challenger must accumulate this many closed shadow trades before it is
    # eligible for promotion -- guards against promoting noise.
    min_eval_trades: int = 30
    bootstrap_samples: int = 2000
    promote_confidence: float = 0.90
    # Below this win probability a challenger is convincingly worse and gets
    # retired. Between the two thresholds it is inconclusive, so it keeps
    # trading and accumulating evidence rather than being killed on a small,
    # noisy sample.
    retire_confidence: float = 0.35
    # A challenger is rejected outright if its drawdown is this much worse
    # than the champion's, regardless of how good its PnL looks.
    max_drawdown_regression_pct: float = 2.0
    mutation_scale: float = 0.25
    seed: int = 7


@dataclass(frozen=True)
class ReputationConfig:
    # Number of shadow-closed trades before an agent's record is taken at
    # anything like face value (shrinkage prior strength).
    prior_strength: float = 10.0
    min_track_record: int = 8
    half_life_days: float = 21.0
    max_tracked_agents: int = 250


@dataclass(frozen=True)
class LLMConfig:
    enabled: bool = True
    model: str = "claude-opus-5"
    effort: str = "medium"
    max_tokens: int = 4096
    api_key_env: str = "ANTHROPIC_API_KEY"
    # Posts per Claude call. Batching keeps the cached system prefix hot.
    batch_size: int = 8
    max_lessons_in_prompt: int = 25


@dataclass(frozen=True)
class MarketDataConfig:
    provider: str = "static"
    base_url: str = ""
    api_key_env: str = "MARKETDATA_API_KEY"
    price_path: str = "price"
    symbol_param: str = "symbol"
    cache_seconds: float = 30.0
    static_prices: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class Config:
    moltbook: MoltbookConfig = field(default_factory=MoltbookConfig)
    trading: TradingConfig = field(default_factory=TradingConfig)
    risk: RiskLimits = field(default_factory=RiskLimits)
    improvement: ImprovementConfig = field(default_factory=ImprovementConfig)
    reputation: ReputationConfig = field(default_factory=ReputationConfig)
    llm: LLMConfig = field(default_factory=LLMConfig)
    market_data: MarketDataConfig = field(default_factory=MarketDataConfig)
    database_path: str = "tradebot.db"
    log_level: str = "INFO"
    cycle_seconds: float = 300.0

    def validate(self) -> Config:
        self.risk.validate()
        if self.trading.starting_cash <= 0:
            raise ConfigError("trading.starting_cash must be positive")
        if self.trading.mode is Mode.LIVE and not self.trading.live_trading_confirmed:
            # Not fatal: we degrade to paper rather than refusing to start, but
            # the operator is told loudly by the engine on startup.
            pass
        if self.improvement.challengers < 0:
            raise ConfigError("improvement.challengers must be >= 0")
        return self


_SECTIONS: dict[str, type] = {
    "moltbook": MoltbookConfig,
    "trading": TradingConfig,
    "risk": RiskLimits,
    "improvement": ImprovementConfig,
    "reputation": ReputationConfig,
    "llm": LLMConfig,
    "market_data": MarketDataConfig,
}

_TUPLE_FIELDS = {"submolts", "allowed_symbols", "blocked_symbols"}


def _build_section(cls: type, raw: dict[str, Any]) -> Any:
    known = {f for f in cls.__dataclass_fields__}
    unknown = set(raw) - known
    if unknown:
        raise ConfigError(f"unknown keys for {cls.__name__}: {sorted(unknown)}")
    kwargs: dict[str, Any] = {}
    for key, value in raw.items():
        if key in _TUPLE_FIELDS and isinstance(value, list):
            value = tuple(value)
        if key == "mode":
            value = Mode(value)
        kwargs[key] = value
    return cls(**kwargs)


def load_config(path: str | os.PathLike[str] | None = None) -> Config:
    """Load config from YAML, falling back to built-in defaults.

    Environment overrides (`TRADEBOT_MODE`, `TRADEBOT_DB`) are applied last so
    that deployments can flip mode without editing the file.
    """
    cfg = Config()
    resolved = Path(path) if path else DEFAULT_CONFIG_PATH
    if resolved.exists():
        raw = yaml.safe_load(resolved.read_text()) or {}
        if not isinstance(raw, dict):
            raise ConfigError(f"{resolved} must contain a YAML mapping")
        overrides: dict[str, Any] = {}
        for name, section_cls in _SECTIONS.items():
            if name in raw:
                if not isinstance(raw[name], dict):
                    raise ConfigError(f"config section '{name}' must be a mapping")
                overrides[name] = _build_section(section_cls, raw[name])
        for scalar in ("database_path", "log_level", "cycle_seconds"):
            if scalar in raw:
                overrides[scalar] = raw[scalar]
        leftover = set(raw) - set(_SECTIONS) - {"database_path", "log_level", "cycle_seconds"}
        if leftover:
            raise ConfigError(f"unknown top-level config keys: {sorted(leftover)}")
        cfg = replace(cfg, **overrides)

    if env_mode := os.environ.get("TRADEBOT_MODE"):
        cfg = replace(cfg, trading=replace(cfg.trading, mode=Mode(env_mode)))
    if env_db := os.environ.get("TRADEBOT_DB"):
        cfg = replace(cfg, database_path=env_db)
    return cfg.validate()
