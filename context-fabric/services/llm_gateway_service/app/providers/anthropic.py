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
            # (2026-05-24 RCA) Prefer the structured tool_calls field.
            # Callers (notably context-fabric stage_driver) now ship the
            # list as a sibling of `content` instead of stringifying it
            # inside content. Tolerate both gateway-flat
            # ({id, name, args}) AND OpenAI-nested
            # ({id, type, function: {name, arguments}}) shapes so older
            # callers don't break.
            structured_tc: Optional[List[Dict[str, Any]]] = m.tool_calls
            if not structured_tc:
                # Backward-compat: a legacy caller may still be JSON-
                # encoding tool_calls into content. Try to recover it.
                try:
                    parsed = json.loads(m.content or "{}")
                    if isinstance(parsed, dict) and isinstance(parsed.get("tool_calls"), list):
                        structured_tc = parsed["tool_calls"]
                except Exception:
                    structured_tc = None
            if structured_tc:
                use_blocks: List[Dict[str, Any]] = []
                for c in structured_tc:
                    if not isinstance(c, dict):
                        continue
                    # Normalize OpenAI {id, type, function:{name, arguments}}
                    # → flat {id, name, input}.
                    fn = c.get("function") if isinstance(c.get("function"), dict) else None
                    name = c.get("name") or (fn.get("name") if fn else None) or ""
                    raw_input = c.get("args")
                    if raw_input is None and fn is not None:
                        raw_input = fn.get("arguments")
                    if raw_input is None:
                        raw_input = c.get("input")
                    if isinstance(raw_input, str):
                        try:
                            raw_input = json.loads(raw_input)
                        except Exception:
                            raw_input = {"_raw": raw_input}
                    if not isinstance(raw_input, dict):
                        raw_input = {}
                    use_blocks.append({
                        "type": "tool_use",
                        "id": c.get("id") or "",
                        "name": name,
                        "input": raw_input,
                    })
                if use_blocks:
                    # M83.r — thinking blocks must precede tool_use in the
                    # assistant message. Anthropic validates this ordering
                    # on tool-result continuation turns; getting it wrong
                    # 400s the next call with "unexpected content block
                    # order". When extended thinking is OFF, m.thinking_blocks
                    # is None and we skip cleanly.
                    content_blocks: List[Dict[str, Any]] = []
                    if m.thinking_blocks:
                        for tb in m.thinking_blocks:
                            if not isinstance(tb, dict):
                                continue
                            thinking_text = tb.get("thinking")
                            sig = tb.get("signature")
                            if not isinstance(thinking_text, str) or not isinstance(sig, str):
                                continue
                            content_blocks.append({
                                "type": "thinking",
                                "thinking": thinking_text,
                                "signature": sig,
                            })
                    content_blocks.extend(use_blocks)
                    out.append({"role": "assistant", "content": content_blocks})
                    continue
        # (2026-05-24 RCA) Anthropic's Messages API 400s on assistant
        # content with trailing whitespace. Defensive strip here so a
        # buggy upstream caller can't kill the request — we'd rather
        # send a benign empty/trimmed message than fail the whole turn.
        # The same normalization lives in context-fabric's stage_driver
        # but other callers (tests, agents-and-tools, future services)
        # share this gateway so the defensive copy stays.
        content = m.content or ""
        if m.role == "assistant" and isinstance(content, str):
            content = content.strip()
        out.append({"role": "assistant" if m.role == "assistant" else "user", "content": content})
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
        # M83.x parallel exploration — make the parallel-tool-use
        # opt-in explicit. Anthropic's Messages API enables parallel
        # tool use by default unless tool_choice carries
        # disable_parallel_tool_use=true; setting it explicitly to
        # false makes our intent legible and survives any future
        # default-flip on the provider side. The governed loop's
        # dispatch path (loop.py) handles the parallel calls — for
        # read-only tools it actually runs them concurrently via
        # asyncio.gather, for mutating tools it serializes.
        body["tool_choice"] = {"type": "auto", "disable_parallel_tool_use": False}

    # M83.r — Anthropic extended thinking. Only sent when the caller
    # asked for it (thinking_budget > 0); Claude 3.x silently ignores
    # the field but newer models (Sonnet 4.x, Opus 4.x) use it. Anthropic
    # docs: minimum effective budget 1024, sensible default 4096-8192.
    # max_tokens must be at least 1+budget_tokens for the response to
    # have any room beyond the thinking — we extend it here so the
    # caller's max_output_tokens still controls the visible-output cap.
    if req.thinking_budget and req.thinking_budget > 0:
        budget = max(1024, int(req.thinking_budget))
        body["thinking"] = {"type": "enabled", "budget_tokens": budget}
        # Anthropic requires max_tokens > budget_tokens. If the caller
        # didn't set enough headroom, bump max_tokens to budget + 4096
        # so the visible reply still has reasonable room. Don't bump
        # above 32k to avoid runaway costs.
        current_max = int(body.get("max_tokens") or 4096)
        needed_max = budget + 4096
        if current_max <= budget:
            body["max_tokens"] = min(32_000, needed_max)
        # Temperature must be 1 (or omitted) with extended thinking —
        # the docs are explicit: "thinking is incompatible with
        # temperature ≠ 1, top_p ≠ 1, top_k ≠ -1". Quietly normalize
        # rather than 400 the call.
        body.pop("temperature", None)

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
        # Widened snippet to 2000 chars (was 400) so the full Anthropic
        # complaint always lands in the audit trail instead of being
        # truncated mid-sentence. The 2026-05-24 tool_use_id RCA spent
        # an extra round trip because the original snippet stopped at
        # "found in `tool_r" — we never saw the block kind.
        snippet = res.text[:2000] if isinstance(res.text, str) else ""
        raise AnthropicUpstreamError(res.status_code, f"anthropic returned {res.status_code}: {snippet}")
    data = res.json()
    text_content = ""
    tool_calls: List[ToolCall] = []
    # M83.r — capture thinking blocks. Anthropic emits them as content
    # blocks with type="thinking", carrying the reasoning text plus an
    # opaque signature. Callers thread them back into history via
    # ChatMessage.thinking_blocks (required for tool-use continuation).
    thinking_blocks: List[Dict[str, Any]] = []
    for block in data.get("content") or []:
        if block.get("type") == "text":
            text_content += block.get("text") or ""
        elif block.get("type") == "tool_use":
            tool_calls.append(ToolCall(
                id=block.get("id") or f"tc-{uuid.uuid4().hex[:8]}",
                name=block.get("name") or "",
                args=block.get("input") or {},
            ))
        elif block.get("type") == "thinking":
            thinking_text = block.get("thinking")
            signature = block.get("signature")
            if isinstance(thinking_text, str) and isinstance(signature, str):
                thinking_blocks.append({
                    "thinking": thinking_text,
                    "signature": signature,
                })
        elif block.get("type") == "redacted_thinking":
            # Anthropic encrypts thinking blocks that tripped a safety
            # filter — they come back without the plaintext but the
            # signature still needs to be threaded for continuation.
            # We store an empty-thinking marker so the converter still
            # emits the block on the next turn.
            sig = block.get("data") or block.get("signature")
            if isinstance(sig, str):
                thinking_blocks.append({
                    "thinking": "[redacted by Anthropic safety filter]",
                    "signature": sig,
                    "redacted": True,
                })

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
    # M83.r — Anthropic returns thinking-token usage under cache-aware
    # accounting; older response shapes may put it under
    # `cache_creation_input_tokens` or roll it into output_tokens. The
    # documented field is `thinking_tokens` (Anthropic, late-2025 docs).
    # Falling back to 0 keeps cost math safe when the field is absent.
    thinking_tokens_raw = usage.get("thinking_tokens") or 0
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
        thinking_blocks=thinking_blocks or None,
        thinking_tokens=int(thinking_tokens_raw) if isinstance(thinking_tokens_raw, (int, float)) else 0,
    )
