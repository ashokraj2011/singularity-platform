"""
M71 Slice C(b) — LLM-gateway client.

Thin async wrapper around the central LLM gateway. Mirrors the same contract
mcp-server's llm/client.ts uses today (POST /v1/chat/completions on
`LLM_GATEWAY_URL`) so context-fabric can drive the agent loop without going
through mcp-server's old /invoke path.

Provider keys NEVER live here. They stay on llm-gateway-service. This module
holds only the URL + bearer + per-request timeout.

The `mock` value for LLM_GATEWAY_URL gives a deterministic in-process stub
so unit tests run without a live gateway — same convention as mcp-server.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger(__name__)


# Environment knobs (same names as mcp-server so dev compose stays consistent):
#   LLM_GATEWAY_URL          — base URL, or the literal "mock" for tests
#   LLM_GATEWAY_BEARER       — optional bearer
#   LLM_GATEWAY_TIMEOUT_SEC  — per-call timeout, default 300s (LLM calls are slow)
_GATEWAY_URL = os.environ.get("LLM_GATEWAY_URL", "http://llm-gateway:8001").rstrip("/")
_GATEWAY_BEARER = os.environ.get("LLM_GATEWAY_BEARER", "")
_TIMEOUT = float(os.environ.get("LLM_GATEWAY_TIMEOUT_SEC", "300"))

# ── Dynamic gateway discovery (consumer side of M11.a) ───────────────────────
# The gateway self-registers with platform-registry (see the gateway's
# app/platform_registry.py). When PLATFORM_REGISTRY_URL is set, we resolve the
# gateway's live address from the registry instead of trusting the static
# LLM_GATEWAY_URL — this is what lets a developer's LOCAL gateway (registered
# under LLM_GATEWAY_SERVICE_NAME, e.g. "llm-gateway-local") be discovered.
# Resolution is cached in-process with a short TTL to keep the per-call hot
# path cheap, and ALWAYS falls back to the static LLM_GATEWAY_URL on miss /
# error / unset registry, so behavior is unchanged when discovery is off.
#   PLATFORM_REGISTRY_URL        — registry base; unset → discovery disabled
#   LLM_GATEWAY_SERVICE_NAME     — service_name to resolve (default "llm-gateway")
#   LLM_GATEWAY_DISCOVERY_TTL_SEC — resolver cache TTL (default 30s)
_REGISTRY_URL = os.environ.get("PLATFORM_REGISTRY_URL", "").rstrip("/")
_GATEWAY_SERVICE_NAME = os.environ.get("LLM_GATEWAY_SERVICE_NAME", "llm-gateway")
_DISCOVERY_TTL_SEC = float(os.environ.get("LLM_GATEWAY_DISCOVERY_TTL_SEC", "30"))
# {"url": str | None, "expires_at": float}. Module-global; reset in tests.
_GATEWAY_CACHE: dict[str, Any] = {"url": None, "expires_at": 0.0}


async def _resolve_gateway_url() -> str:
    """Return the base URL to use for the gateway.

    Order of precedence:
      1. If LLM_GATEWAY_URL == "mock", callers short-circuit before this runs;
         this function is never reached in mock mode (kept as a guard anyway).
      2. If PLATFORM_REGISTRY_URL is unset → static LLM_GATEWAY_URL (no change).
      3. Otherwise GET {registry}/api/v1/services/{name} and use internal_url
         or base_url, cached for _DISCOVERY_TTL_SEC. On 404 / timeout / any
         error → fall back to the static LLM_GATEWAY_URL.
    """
    if not _REGISTRY_URL:
        return _GATEWAY_URL

    now = time.monotonic()
    cached = _GATEWAY_CACHE.get("url")
    if cached and now < _GATEWAY_CACHE.get("expires_at", 0.0):
        return cached

    resolved = _GATEWAY_URL  # fail-safe default
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            res = await client.get(
                f"{_REGISTRY_URL}/api/v1/services/{_GATEWAY_SERVICE_NAME}"
            )
        if res.status_code == 200:
            data = res.json()
            # GET /services/:name returns the row flat at top level, so
            # internal_url / base_url sit at the top. internal_url is nullable;
            # prefer it (container-network address) then fall back to base_url.
            url = (data.get("internal_url") or data.get("base_url") or "").rstrip("/")
            if url:
                resolved = url
        # Non-200 (e.g. 404 NOT_FOUND) → keep the static fallback.
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "gateway discovery failed (%s); falling back to %s",
            exc, _GATEWAY_URL,
        )

    _GATEWAY_CACHE["url"] = resolved
    _GATEWAY_CACHE["expires_at"] = now + _DISCOVERY_TTL_SEC
    return resolved
# ADR 0003 — server-level prompt caching for the governed/workbench loop.
# Default ON: governed turns repeat a large stable prefix (system + tools +
# context) every turn, so caching is a clear win. The gateway has its own
# global kill switch (LLM_PROMPT_CACHE_ENABLED there) and per-provider
# handling; this knob lets the caller opt out without redeploying the gateway.
_PROMPT_CACHE_ENABLED = os.environ.get("LLM_PROMPT_CACHE_ENABLED", "true").lower() == "true"


class LLMGatewayError(RuntimeError):
    """Endpoint-level failure. Carries an error_code that context-fabric's
    error mapper can route to specific UI handling (e.g. LLM_GATEWAY_TIMEOUT
    vs LLM_PROVIDER_OVERLOADED). Mirrors the codes mcp-server uses today."""

    def __init__(self, error_code: str, message: str, upstream_status: int | None = None):
        super().__init__(message)
        self.error_code = error_code
        self.upstream_status = upstream_status


@dataclass
class ChatToolCall:
    """A tool the LLM wants to invoke. Matches the gateway's tool_calls
    response shape: {id, name, arguments}. context-fabric's loop hands
    these off to tool_gateway.check_tool_allowed + dispatch_tool."""

    id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "ChatToolCall":
        # The llm-gateway's ToolCall pydantic model serializes the args
        # under the field name `args` (see
        # context-fabric/services/llm_gateway_service/app/types.py:54).
        # Earlier code here only checked `arguments`, which was wrong for
        # every gateway-served call — args silently became `{}` on every
        # tool call across the governed loop, including
        # `submit_phase_output`. That bug masqueraded as "the LLM keeps
        # calling submit_phase_output with empty payload" all the way
        # through to a VALIDATION_BLOCKED stage halt. We accept both
        # names here for resilience: gateways or providers that prefer
        # the OpenAI-style `arguments` key still work, but the gateway's
        # canonical `args` wins. Some providers also stringify the
        # arguments value; we JSON-decode that case so the inner shape
        # survives.
        args = raw.get("args")
        if args is None:
            args = raw.get("arguments")
        if isinstance(args, str):
            import json

            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {"_raw": args}
        if not isinstance(args, dict):
            args = {}
        return cls(
            id=str(raw.get("id") or raw.get("tool_call_id") or ""),
            name=str(raw.get("name") or raw.get("tool_name") or ""),
            arguments=args,
        )


@dataclass
class ChatResponse:
    """Decoded gateway response. Field names match the gateway's wire shape
    (snake_case JSON) for traceability."""

    content: str
    tool_calls: list[ChatToolCall]
    finish_reason: str
    input_tokens: int
    output_tokens: int
    latency_ms: int
    provider: str
    model: str
    model_alias: str | None = None
    estimated_cost: float | None = None
    # M83.r — Anthropic extended thinking. List of {thinking, signature}
    # dicts. Empty list when extended thinking was off or the provider
    # doesn't support it. Stage_driver threads these back into the
    # assistant message of the next turn (required for tool-use
    # continuation).
    thinking_blocks: list[dict[str, Any]] = field(default_factory=list)
    thinking_tokens: int = 0
    # ADR 0003 — prompt-cache usage echoed by the gateway:
    # {enabled, strategy, cache_read_input_tokens, cache_creation_input_tokens,
    #  reported, [key]}. None when caching was not requested / unsupported.
    prompt_cache: dict[str, Any] | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "ChatResponse":
        thinking_raw = raw.get("thinking_blocks")
        thinking_blocks: list[dict[str, Any]] = []
        if isinstance(thinking_raw, list):
            for tb in thinking_raw:
                if isinstance(tb, dict):
                    thinking_blocks.append(tb)
        return cls(
            content=str(raw.get("content") or ""),
            tool_calls=[
                ChatToolCall.from_dict(tc)
                for tc in (raw.get("tool_calls") or [])
                if isinstance(tc, dict)
            ],
            finish_reason=str(raw.get("finish_reason") or "stop"),
            input_tokens=int(raw.get("input_tokens") or 0),
            output_tokens=int(raw.get("output_tokens") or 0),
            latency_ms=int(raw.get("latency_ms") or 0),
            provider=str(raw.get("provider") or "unknown"),
            model=str(raw.get("model") or ""),
            model_alias=raw.get("model_alias"),
            estimated_cost=raw.get("estimated_cost"),
            thinking_blocks=thinking_blocks,
            thinking_tokens=int(raw.get("thinking_tokens") or 0),
            prompt_cache=raw.get("prompt_cache") if isinstance(raw.get("prompt_cache"), dict) else None,
        )


async def call_gateway_chat(
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    model_alias: str | None = None,
    temperature: float | None = None,
    max_output_tokens: int | None = None,
    bearer: str | None = None,
    # M83.r — Anthropic extended thinking budget (in tokens). When >0,
    # the gateway enables thinking on Anthropic providers and the
    # response carries thinking_blocks. Ignored by non-Anthropic
    # providers. None / 0 → off.
    thinking_budget: int | None = None,
    # ADR 0003 — opt into server-level prompt caching. None → use the
    # _PROMPT_CACHE_ENABLED default (on). False → force off for this call
    # (e.g. a genuinely one-shot turn with no repeated prefix, where the
    # cache-write surcharge would not be recovered).
    prompt_cache: bool | None = None,
    prompt_cache_key: str | None = None,
) -> ChatResponse:
    """POST one chat completion to llm-gateway.

    Args:
      messages:           OpenAI-style message list. The gateway normalises
                          across Anthropic / OpenAI / Mock providers.
      tools:              Tool descriptors the LLM may emit calls for. Shape:
                            [{"name": "apply_patch",
                              "description": "...",
                              "input_schema": {...}}]
      model_alias:        Logical alias resolved by the gateway's rate card
                          (e.g. "claude-sonnet", "mock-fast"). When unset,
                          the gateway uses its default.
      temperature:        Standard OpenAI param.
      max_output_tokens:  Standard OpenAI param.
      bearer:             Override env-default LLM_GATEWAY_BEARER. Used when
                          workgraph-api wants to forward a user-scoped token.

    Raises:
      LLMGatewayError on timeout / 5xx / network. The `error_code` field
      lets the caller distinguish LLM_GATEWAY_TIMEOUT (slow but maybe okay
      to retry with longer budget) from LLM_PROVIDER_OVERLOADED (rate-limit;
      back off) from LLM_GATEWAY_UNAVAILABLE (config / network).
    """
    if _GATEWAY_URL == "mock":
        return _mock_response(messages, tools)

    body: dict[str, Any] = {"messages": messages}
    if tools:
        body["tools"] = tools
    if model_alias:
        body["model_alias"] = model_alias
    if temperature is not None:
        body["temperature"] = temperature
    if max_output_tokens is not None:
        body["max_output_tokens"] = max_output_tokens
    if thinking_budget is not None and thinking_budget > 0:
        body["thinking_budget"] = int(thinking_budget)
    cache_on = _PROMPT_CACHE_ENABLED if prompt_cache is None else prompt_cache
    if cache_on:
        pc: dict[str, Any] = {"enabled": True, "strategy": "provider_auto"}
        if prompt_cache_key:
            pc["key"] = prompt_cache_key
        body["prompt_cache"] = pc

    headers = {"content-type": "application/json"}
    token = bearer or _GATEWAY_BEARER
    if token:
        headers["authorization"] = f"Bearer {token}"

    base_url = await _resolve_gateway_url()
    url = f"{base_url}/v1/chat/completions"

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(url, headers=headers, json=body)
    except httpx.TimeoutException as exc:
        # Surface timeout distinctly so callers can decide to widen the
        # envelope vs. give up. Mirrors the M64 handling in mcp-server.
        raise LLMGatewayError(
            "LLM_GATEWAY_TIMEOUT",
            f"LLM gateway did not respond within {_TIMEOUT}s. Raise LLM_GATEWAY_TIMEOUT_SEC "
            "above the gateway's retry envelope if you keep hitting this.",
        ) from exc
    except httpx.HTTPError as exc:
        raise LLMGatewayError(
            "LLM_GATEWAY_UNAVAILABLE",
            f"LLM gateway unreachable: {exc}",
        ) from exc

    if response.status_code == 429:
        raise LLMGatewayError(
            "LLM_PROVIDER_OVERLOADED",
            f"Gateway returned 429: {response.text[:200]}",
            upstream_status=429,
        )
    if response.status_code >= 500:
        raise LLMGatewayError(
            "LLM_GATEWAY_UPSTREAM_ERROR",
            f"Gateway returned {response.status_code}: {response.text[:200]}",
            upstream_status=response.status_code,
        )
    if response.status_code >= 400:
        raise LLMGatewayError(
            "LLM_GATEWAY_BAD_REQUEST",
            f"Gateway returned {response.status_code}: {response.text[:200]}",
            upstream_status=response.status_code,
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise LLMGatewayError(
            "LLM_GATEWAY_BAD_RESPONSE",
            f"Gateway returned non-JSON: {response.text[:200]}",
        ) from exc

    return ChatResponse.from_dict(payload)


def _mock_response(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
) -> ChatResponse:
    """In-process mock matching the gateway's `mock` provider shape.

    Used by unit tests that don't want a live gateway. Returns a deterministic
    `[mock] received N messages` content with no tool calls and a sensible
    token estimate. Tests that need a specific shape should monkey-patch
    `call_gateway_chat` instead of going through the mock path.
    """
    input_text = "\n".join(str(m.get("content") or "") for m in messages)
    reply = f"[mock] Received {len(messages)} message(s) ({len(input_text)} chars). No tool call needed."
    return ChatResponse(
        content=reply,
        tool_calls=[],
        finish_reason="stop",
        input_tokens=max(1, len(input_text) // 4),
        output_tokens=max(1, len(reply) // 4),
        latency_ms=1,
        provider="mock",
        model="mock-fast",
        model_alias="mock-fast",
        estimated_cost=0.0,
    )
