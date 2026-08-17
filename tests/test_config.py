"""Config loading and validation."""

from __future__ import annotations

import pytest
import yaml

from tradebot.config import Config, ConfigError, RiskLimits, load_config
from tradebot.models import Mode


def write(tmp_path, data):
    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(data))
    return path


def test_defaults_are_valid():
    assert Config().validate() is not None


def test_defaults_are_paper_and_unconfirmed():
    """Safe by default: neither switch is pre-flipped."""
    config = Config()
    assert config.trading.mode is Mode.PAPER
    assert config.trading.live_trading_confirmed is False
    assert config.trading.is_live() is False


def test_live_needs_both_switches():
    from tradebot.config import TradingConfig

    assert not TradingConfig(mode=Mode.LIVE).is_live()
    assert not TradingConfig(live_trading_confirmed=True).is_live()
    assert TradingConfig(mode=Mode.LIVE, live_trading_confirmed=True).is_live()


def test_loads_sections_from_yaml(tmp_path):
    path = write(tmp_path, {"trading": {"starting_cash": 500.0}, "log_level": "DEBUG"})
    config = load_config(path)
    assert config.trading.starting_cash == 500.0
    assert config.log_level == "DEBUG"


def test_missing_file_falls_back_to_defaults(tmp_path):
    assert load_config(tmp_path / "nope.yaml").trading.starting_cash == 10_000.0


def test_unknown_key_is_rejected(tmp_path):
    path = write(tmp_path, {"trading": {"stating_cash": 1}})
    with pytest.raises(ConfigError, match="unknown keys"):
        load_config(path)


def test_unknown_section_is_rejected(tmp_path):
    path = write(tmp_path, {"tradng": {}})
    with pytest.raises(ConfigError, match="unknown top-level"):
        load_config(path)


def test_lists_become_tuples(tmp_path):
    path = write(tmp_path, {"moltbook": {"submolts": ["a", "b"]}})
    assert load_config(path).moltbook.submolts == ("a", "b")


def test_env_overrides_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADEBOT_MODE", "live")
    assert load_config(tmp_path / "none.yaml").trading.mode is Mode.LIVE


def test_api_key_read_from_environment(monkeypatch):
    monkeypatch.setenv("MOLTBOOK_API_KEY", "secret")
    assert Config().moltbook.api_key() == "secret"
    monkeypatch.delenv("MOLTBOOK_API_KEY")
    assert Config().moltbook.api_key() is None


# ------------------------------------------------------------- risk validation


def test_incoherent_limits_are_rejected():
    with pytest.raises(ConfigError):
        RiskLimits(max_position_pct=0).validate()
    with pytest.raises(ConfigError):
        RiskLimits(max_position_pct=20.0, per_asset_cap_pct=10.0).validate()
    with pytest.raises(ConfigError):
        RiskLimits(per_asset_cap_pct=80.0, max_gross_exposure_pct=60.0).validate()
    with pytest.raises(ConfigError):
        RiskLimits(min_stop_loss_pct=30.0, max_stop_loss_pct=20.0).validate()
    with pytest.raises(ConfigError):
        RiskLimits(max_concurrent_positions=0).validate()


def test_sane_limits_pass():
    RiskLimits().validate()


def test_negative_starting_cash_rejected():
    from tradebot.config import TradingConfig

    with pytest.raises(ConfigError):
        Config(trading=TradingConfig(starting_cash=-1)).validate()


def test_example_config_matches_the_schema():
    """The shipped example must actually load -- it is the onboarding path."""
    from pathlib import Path

    example = Path(__file__).resolve().parent.parent / "config.example.yaml"
    assert example.exists()
    config = load_config(example)
    assert config.trading.mode is Mode.PAPER
    assert config.trading.live_trading_confirmed is False
    assert "register" in config.moltbook.endpoints
