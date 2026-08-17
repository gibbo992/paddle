"""Rule-based signal extraction and post normalisation."""

from __future__ import annotations

from datetime import timedelta

import pytest

from tradebot.models import Action, Side, utcnow
from tradebot.moltbook.client import coerce_post
from tradebot.signals import (
    RuleExtractor,
    dedupe_signals,
    find_symbols,
    looks_tradelike,
)
from tradebot.moltbook.client import RawPost


def post(body: str, post_id: str = "p1", agent: str = "a1") -> RawPost:
    return RawPost(
        post_id=post_id,
        agent_id=agent,
        agent_handle=agent,
        submolt="algotrading",
        title="",
        body=body,
        created_at=utcnow() - timedelta(minutes=5),
    )


@pytest.fixture
def rules():
    return RuleExtractor()


def test_extracts_a_long(rules):
    sig = rules.extract_one(post("Going long $BTC here. Entry 100, stop 92, target 115."))
    assert sig is not None
    assert sig.symbol == "BTC"
    assert sig.side is Side.BUY
    assert sig.action is Action.OPEN
    assert sig.claimed_entry == 100.0
    assert sig.claimed_stop == 92.0
    assert sig.claimed_target == 115.0


def test_extracts_a_short(rules):
    sig = rules.extract_one(post("Shorting $ETH from 50. SL 54 TP 42."))
    assert sig.side is Side.SELL
    assert sig.action is Action.OPEN


def test_extracts_a_close(rules):
    sig = rules.extract_one(post("Closed my $SOL position, took profit."))
    assert sig.action is Action.CLOSE


def test_ignores_chatter(rules):
    assert rules.extract_one(post("Anyone else watching the macro data?")) is None
    assert rules.extract_one(post("position sizing beats being right")) is None


def test_ignores_posts_without_a_symbol(rules):
    assert rules.extract_one(post("I went long and it worked out great")) is None


def test_confidence_rises_with_specificity(rules):
    vague = rules.extract_one(post("bullish on $BTC", post_id="a"))
    precise = rules.extract_one(
        post("Long $BTC entry 100, stop 92, target 115", post_id="b")
    )
    assert precise.confidence > vague.confidence
    assert precise.confidence <= RuleExtractor.max_confidence


def test_rule_confidence_never_reaches_certainty(rules):
    sig = rules.extract_one(post("Long $BTC entry 100 stop 92 target 115"))
    assert sig.confidence < 1.0


def test_common_words_are_not_tickers():
    assert find_symbols("THE API IS DOWN LOL") == []
    assert find_symbols("my PNL is up, DYOR NFA") == []
    assert "BTC" in find_symbols("$BTC to the moon")


def test_tagged_symbols_beat_bare_words():
    assert find_symbols("I think NVDA and $BTC")[0] == "BTC"


def test_pair_notation():
    assert "SOL" in find_symbols("entering SOL/USDT here")


def test_prefilter_rejects_noise():
    assert not looks_tradelike(post("Good morning everyone"))
    assert looks_tradelike(post("long $BTC"))


def test_signal_id_is_stable_across_reextraction(rules):
    a = rules.extract_one(post("Long $BTC entry 100", post_id="same"))
    b = rules.extract_one(post("Long $BTC entry 100", post_id="same"))
    assert a.signal_id == b.signal_id


def test_dedupe_keeps_highest_confidence(rules):
    a = rules.extract_one(post("bullish $BTC", post_id="x"))
    b = rules.extract_one(post("Long $BTC entry 100 stop 92 target 120", post_id="x"))
    kept = dedupe_signals([a, b])
    assert len(kept) == 1
    assert kept[0].confidence == max(a.confidence, b.confidence)


def test_signal_age_is_computed_from_post_time(rules):
    sig = rules.extract_one(post("Long $BTC entry 100"))
    assert 4.0 < sig.age_minutes < 6.0


# ------------------------------------------------------- post normalisation


def test_coerce_post_handles_field_aliases():
    p = coerce_post(
        {"id": "1", "author": "bob", "content": "long $BTC", "community": "trading"}
    )
    assert p.post_id == "1"
    assert p.agent_handle == "bob"
    assert p.body == "long $BTC"
    assert p.submolt == "trading"


def test_coerce_post_handles_nested_author():
    p = coerce_post(
        {"id": "2", "author": {"id": "u9", "username": "alice"}, "text": "short $ETH"}
    )
    assert p.agent_id == "u9"
    assert p.agent_handle == "alice"


def test_coerce_post_handles_wrapped_envelope():
    p = coerce_post({"kind": "post", "data": {"id": "3", "author": "z", "body": "hi"}})
    assert p.post_id == "3"


def test_coerce_post_rejects_unusable_records():
    assert coerce_post({"no_id": True}) is None
    assert coerce_post("not a dict") is None


def test_coerce_post_parses_epoch_and_iso_timestamps():
    ms = coerce_post({"id": "4", "author": "a", "created_at": 1767225600000})
    iso = coerce_post({"id": "5", "author": "a", "created_at": "2026-01-01T00:00:00Z"})
    assert ms.created_at.year == 2026
    assert iso.created_at.year == 2026
