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

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "ChatResponse":
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
        )


async def call_gateway_chat(
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    model_alias: str | None = None,
    temperature: float | None = None,
    max_output_tokens: int | None = None,
    bearer: str | None = None,
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

    headers = {"content-type": "application/json"}
    token = bearer or _GATEWAY_BEARER
    if token:
        headers["authorization"] = f"Bearer {token}"

    url = f"{_GATEWAY_URL}/v1/chat/completions"

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
