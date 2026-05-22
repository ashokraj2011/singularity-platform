"""M33 — Anthropic Messages API provider.

Ported from `mcp-server/src/llm/providers/anthropic.ts`. HTTP-only — no SDK.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Optional

import httpx

from ..config import settings
from ..provider_config import provider_base_url
from ..types import ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ToolCall, ToolDescriptor


class AnthropicUpstreamError(RuntimeError):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


def _retry_after_seconds(res: httpx.Response) -> float:
    raw = res.headers.get("retry-after")
    if raw:
        try:
            return max(0.0, float(raw))
        except ValueError:
            try:
                parsed = parsedate_to_datetime(raw)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return max(0.0, (parsed - datetime.now(timezone.utc)).total_seconds())
            except Exception:
                pass
    return settings.upstream_rate_limit_retry_delay_sec


def _to_anthropic(messages: List[ChatMessage]):
    system_chunks: List[str] = []
    out: List[Dict[str, Any]] = []
    for m in messages:
        if m.role == "system":
            system_chunks.append(m.content or "")
            continue
        if m.role == "tool":
            out.append({
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": m.tool_call_id or "", "content": m.content or ""}],
            })
            continue
        if m.role == "assistant":
            try:
                parsed = json.loads(m.content or "{}")
                if isinstance(parsed, dict) and isinstance(parsed.get("tool_calls"), list) and parsed["tool_calls"]:
                    out.append({
                        "role": "assistant",
                        "content": [
                            {"type": "tool_use", "id": c.get("id"), "name": c.get("name"), "input": c.get("args") or {}}
                            for c in parsed["tool_calls"]
                        ],
                    })
                    continue
            except Exception:
                pass
        out.append({"role": "assistant" if m.role == "assistant" else "user", "content": m.content or ""})
    system = "\n\n".join(s for s in system_chunks if s) if system_chunks else None
    return system, out


def _to_anthropic_tools(tools: Optional[List[ToolDescriptor]]):
    if not tools:
        return None
    return [
        {"name": t.name, "description": t.description, "input_schema": t.input_schema or {"type": "object", "properties": {}}}
        for t in tools
    ]


async def respond(
    req: ChatCompletionRequest,
    *,
    resolved_model: str,
    api_key: str,
    model_alias: Optional[str] = None,
) -> ChatCompletionResponse:
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured on the gateway")
    system, messages = _to_anthropic(req.messages)
    body: Dict[str, Any] = {
        "model": resolved_model,
        "messages": messages,
        "max_tokens": req.max_output_tokens or 4096,
    }
    if system:
        body["system"] = system
    if req.temperature is not None:
        body["temperature"] = req.temperature
    tools = _to_anthropic_tools(req.tools)
    if tools:
        body["tools"] = tools

    url = f"{provider_base_url('anthropic').rstrip('/')}/v1/messages"
    headers = {
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": settings.anthropic_version,
    }
    start = time.time()
    # M62 — Retryable upstream status codes. Originally only 429 (rate
    # limit) was retried. Added 529 (Anthropic's overloaded_error —
    # transient capacity shedding, distinct from rate limiting) and
    # 503 (generic upstream-down) after operator hit a 529 mid-workflow
    # which surfaced as MCP_INVOKE_FAILED → send-back recommendation
    # in the workbench. Retry-After is honored if the provider sent one;
    # otherwise we back off with the configured floor.
    RETRYABLE_STATUS = {429, 503, 529}
    async with httpx.AsyncClient(timeout=settings.upstream_timeout_sec) as client:
        attempts = max(0, settings.upstream_rate_limit_retries) + 1
        for attempt in range(attempts):
            res = await client.post(url, headers=headers, json=body)
            if res.status_code not in RETRYABLE_STATUS or attempt >= attempts - 1:
                break
            # 529 / 503 typically come WITHOUT a Retry-After header.
            # _retry_after_seconds already falls back to the configured
            # rate-limit delay (a reasonable backoff for overload — gives
            # the upstream pool time to recover) so we get sensible
            # behaviour for both 429 (with header) and 529/503 (without).
            delay = min(settings.upstream_rate_limit_max_sleep_sec, _retry_after_seconds(res))
            await asyncio.sleep(delay)
    if res.status_code != 200:
        snippet = res.text[:400] if isinstance(res.text, str) else ""
        raise AnthropicUpstreamError(res.status_code, f"anthropic returned {res.status_code}: {snippet}")
    data = res.json()
    text_content = ""
    tool_calls: List[ToolCall] = []
    for block in data.get("content") or []:
        if block.get("type") == "text":
            text_content += block.get("text") or ""
        elif block.get("type") == "tool_use":
            tool_calls.append(ToolCall(
                id=block.get("id") or f"tc-{uuid.uuid4().hex[:8]}",
                name=block.get("name") or "",
                args=block.get("input") or {},
            ))

    stop = data.get("stop_reason")
    if tool_calls:
        finish_reason = "tool_call"
    elif stop == "max_tokens":
        finish_reason = "length"
    elif stop == "end_turn":
        finish_reason = "stop"
    elif stop == "tool_use":
        finish_reason = "tool_call"
    else:
        finish_reason = "stop"

    usage = data.get("usage") or {}
    return ChatCompletionResponse(
        content=text_content,
        tool_calls=tool_calls or None,
        finish_reason=finish_reason,
        input_tokens=usage.get("input_tokens") or 0,
        output_tokens=usage.get("output_tokens") or 0,
        latency_ms=int((time.time() - start) * 1000),
        provider="anthropic",
        model=resolved_model,
        model_alias=model_alias,
    )
