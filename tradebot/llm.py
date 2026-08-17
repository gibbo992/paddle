"""Thin Anthropic wrapper for structured extraction.

Kept deliberately small: one method that takes a JSON schema and a user
payload and returns validated JSON. The `anthropic` import is lazy so the
rest of the bot runs (rules-only) without the SDK or an API key present.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from .config import LLMConfig

log = logging.getLogger(__name__)


class LLMUnavailable(RuntimeError):
    """Raised when Claude is disabled, uninstalled, or unauthenticated."""


class ClaudeClient:
    def __init__(self, config: LLMConfig, client: Any | None = None) -> None:
        self.config = config
        self._client = client
        self._checked = client is not None

    def available(self) -> bool:
        if not self.config.enabled:
            return False
        try:
            self._ensure_client()
        except LLMUnavailable:
            return False
        return True

    def _ensure_client(self) -> Any:
        if self._client is not None:
            return self._client
        if not self.config.enabled:
            raise LLMUnavailable("llm.enabled is false in config")
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover - depends on env
            raise LLMUnavailable("anthropic SDK not installed (pip install anthropic)") from exc
        if not os.environ.get(self.config.api_key_env):
            # The SDK can also authenticate from an `ant auth login` profile,
            # so this is a warning path, not a hard failure.
            log.debug("%s unset; relying on SDK credential resolution", self.config.api_key_env)
        try:
            self._client = anthropic.Anthropic()
        except Exception as exc:  # pragma: no cover - depends on env
            raise LLMUnavailable(f"could not construct Anthropic client: {exc}") from exc
        return self._client

    def extract_json(
        self,
        *,
        instructions: str,
        context: str,
        payload: str,
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        """Run one structured-output call and return the parsed object.

        `instructions` is the stable prefix and carries the cache breakpoint;
        `context` (accumulated lessons, which change every cycle) goes after
        it so that rewriting lessons never invalidates the cached instructions.
        """
        client = self._ensure_client()
        system: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": instructions,
                "cache_control": {"type": "ephemeral"},
            }
        ]
        if context:
            system.append({"type": "text", "text": context})

        try:
            response = client.messages.create(
                model=self.config.model,
                max_tokens=self.config.max_tokens,
                system=system,
                thinking={"type": "adaptive"},
                output_config={
                    "effort": self.config.effort,
                    "format": {"type": "json_schema", "schema": schema},
                },
                messages=[{"role": "user", "content": payload}],
            )
        except Exception as exc:
            raise LLMUnavailable(f"Claude request failed: {exc}") from exc

        if getattr(response, "stop_reason", None) == "refusal":
            detail = getattr(response, "stop_details", None)
            raise LLMUnavailable(f"Claude declined the request: {detail}")

        text = next((b.text for b in response.content if b.type == "text"), None)
        if not text:
            raise LLMUnavailable("Claude returned no text block")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LLMUnavailable(f"Claude returned non-JSON output: {text[:200]}") from exc
        if not isinstance(parsed, dict):
            raise LLMUnavailable("expected a JSON object from Claude")

        usage = getattr(response, "usage", None)
        if usage is not None:
            log.debug(
                "claude usage: input=%s cache_read=%s output=%s",
                getattr(usage, "input_tokens", "?"),
                getattr(usage, "cache_read_input_tokens", "?"),
                getattr(usage, "output_tokens", "?"),
            )
        return parsed
