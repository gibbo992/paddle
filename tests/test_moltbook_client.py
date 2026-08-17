"""Moltbook client: auth handling, envelope tolerance, rate limiting."""

from __future__ import annotations

import dataclasses

import httpx
import pytest

from tradebot.config import MoltbookConfig
from tradebot.moltbook.client import (
    MoltbookAuthError,
    MoltbookClient,
    MoltbookError,
    RateLimiter,
    coerce_post,
)


def client_for(handler, config: MoltbookConfig | None = None) -> MoltbookClient:
    config = config or MoltbookConfig()
    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport, base_url=config.base_url.rstrip("/"))
    return MoltbookClient(config, client=http, sleep=lambda _: None)


# ------------------------------------------------------------ key protection


def test_api_key_is_sent_to_moltbook(monkeypatch):
    monkeypatch.setenv("MOLTBOOK_API_KEY", "moltbook_secret")
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"posts": []})

    client_for(handler).fetch_feed()
    assert seen["auth"] == "Bearer moltbook_secret"


def test_api_key_is_never_sent_to_another_host(monkeypatch):
    """The key is the agent's identity; it must not leak to a rehosted API."""
    monkeypatch.setenv("MOLTBOOK_API_KEY", "moltbook_secret")
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"posts": []})

    evil = MoltbookConfig(base_url="https://moltbook.evil.example.com")
    client_for(handler, evil).fetch_feed()
    assert seen["auth"] is None


def test_bare_domain_is_not_treated_as_moltbook(monkeypatch):
    """`moltbook.com` without www strips auth on redirect -- do not send it."""
    monkeypatch.setenv("MOLTBOOK_API_KEY", "moltbook_secret")
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"posts": []})

    client_for(handler, MoltbookConfig(base_url="https://notmoltbook.com")).fetch_feed()
    assert seen["auth"] is None


def test_default_base_url_keeps_www():
    assert MoltbookConfig().base_url == "https://www.moltbook.com"


# ------------------------------------------------------------------ requests


def test_auth_failure_is_distinct_from_other_errors():
    with pytest.raises(MoltbookAuthError):
        client_for(lambda r: httpx.Response(401, json={})).fetch_feed()


def test_client_error_is_reported():
    with pytest.raises(MoltbookError, match="404"):
        client_for(lambda r: httpx.Response(404, text="nope")).fetch_feed()


def test_server_errors_are_retried_then_surfaced():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(503, json={})

    with pytest.raises(MoltbookError):
        client_for(handler).fetch_feed()
    assert calls["n"] > 1


def test_rate_limit_response_is_retried():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "0"}, json={})
        return httpx.Response(200, json={"posts": [{"id": "1", "author": "a", "body": "hi"}]})

    posts = client_for(handler).fetch_feed()
    assert calls["n"] == 2
    assert len(posts) == 1


def test_unconfigured_endpoint_is_a_clear_error():
    config = dataclasses.replace(MoltbookConfig(), endpoints={})
    with pytest.raises(MoltbookError, match="no endpoint configured"):
        client_for(lambda r: httpx.Response(200, json={}), config).fetch_feed()


def test_non_json_response_is_an_error():
    with pytest.raises(MoltbookError, match="non-JSON"):
        client_for(lambda r: httpx.Response(200, text="<html>")).fetch_feed()


# ----------------------------------------------------------------- envelopes


@pytest.mark.parametrize(
    "payload",
    [
        {"posts": [{"id": "1", "author": "a", "body": "long $BTC"}]},
        {"success": True, "data": {"posts": [{"id": "1", "author": "a", "body": "x"}]}},
        {"results": [{"id": "1", "author": "a", "content": "x"}]},
        {"data": [{"id": "1", "author": "a", "body": "x"}]},
    ],
)
def test_items_found_in_any_documented_envelope(payload):
    assert len(client_for(lambda r: httpx.Response(200, json=payload)).fetch_feed()) == 1


def test_search_sends_semantic_query_params():
    seen = {}

    def handler(request):
        seen.update(dict(request.url.params))
        return httpx.Response(200, json={"results": []})

    client_for(handler).search_posts("agents describing a trade", limit=99)
    assert seen["q"] == "agents describing a trade"
    assert int(seen["limit"]) <= 50  # server caps at 50
    assert seen["type"] == "all"


def test_submolt_feed_requests_newest_first():
    seen = {}

    def handler(request):
        seen.update(dict(request.url.params))
        return httpx.Response(200, json={"posts": []})

    client_for(handler).fetch_submolt_posts("general")
    assert seen["sort"] == "new"


def test_iter_posts_skips_a_broken_submolt():
    def handler(request):
        if "broken" in str(request.url):
            return httpx.Response(404, text="gone")
        return httpx.Response(200, json={"posts": [{"id": "1", "author": "a", "body": "x"}]})

    config = dataclasses.replace(MoltbookConfig(), submolts=("broken", "general"))
    posts = list(client_for(handler, config).iter_posts())
    assert len(posts) == 1


def test_auth_error_aborts_the_whole_sweep():
    """A bad key is not a per-submolt problem; stop rather than spin."""
    config = dataclasses.replace(MoltbookConfig(), submolts=("a", "b"))
    with pytest.raises(MoltbookAuthError):
        list(client_for(lambda r: httpx.Response(403, json={}), config).iter_posts())


# -------------------------------------------------------------- registration


def test_register_reads_the_documented_agent_envelope():
    payload = {
        "agent": {
            "api_key": "moltbook_xxx",
            "claim_url": "https://www.moltbook.com/claim/abc",
            "verification_code": "reef-X4B2",
        }
    }
    result = client_for(lambda r: httpx.Response(200, json=payload)).register("Bot", "desc")
    assert result["api_key"] == "moltbook_xxx"
    assert result["verification_code"] == "reef-X4B2"
    assert result["claim_url"].endswith("/claim/abc")


def test_register_sends_name_and_description():
    import json as jsonlib

    seen = {}

    def handler(request):
        seen.update(jsonlib.loads(request.content))
        return httpx.Response(200, json={"agent": {"api_key": "k"}})

    client_for(handler).register("TradeBot", "copy trading")
    assert seen["name"] == "TradeBot"
    assert seen["description"] == "copy trading"


def test_register_surfaces_a_rejection():
    with pytest.raises(MoltbookError):
        client_for(lambda r: httpx.Response(400, text="name taken")).register("x")


# --------------------------------------------------------------- post fields


def test_author_name_becomes_the_agent_id_when_no_id_is_given():
    """Moltbook posts carry `author: {name}` only -- track by name."""
    post = coerce_post({"id": "1", "author": {"name": "AlphaMolty"}, "content": "long $BTC"})
    assert post.agent_id == "AlphaMolty"
    assert post.agent_handle == "AlphaMolty"


def test_submolt_object_is_flattened():
    post = coerce_post(
        {"id": "1", "author": {"name": "a"}, "content": "x",
         "submolt": {"name": "general", "display_name": "General"}}
    )
    assert post.submolt == "general"


# --------------------------------------------------------------- rate limiter


def test_rate_limiter_allows_up_to_the_budget():
    limiter = RateLimiter(per_minute=5)
    for _ in range(5):
        limiter.acquire()
    assert len(limiter._hits) == 5


def test_rate_limiter_floor_is_one():
    assert RateLimiter(per_minute=0).per_minute == 1
