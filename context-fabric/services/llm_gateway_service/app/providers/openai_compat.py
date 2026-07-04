"""M33 — OpenAI Chat Completions provider (covers openai + openrouter).

Ported from `mcp-server/src/llm/providers/openai.ts`. Only HTTP — no SDK.
Streaming is not implemented in v0 of the gateway (callers fall back to
non-streaming + assemble the final response). Adding SSE is a follow-up.
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx

from ..config import settings
from ..provider_config import provider_base_url
from ..types import ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ToolCall, ToolDescriptor


def _response_json_object(res: httpx.Response, *, provider: str, operation: str) -> Dict[str, Any]:
    try:
        data = res.json()
    except Exception as exc:
        snippet = res.text[:400] if isinstance(res.text, str) else ""
        raise RuntimeError(f"{provider} {operation} returned invalid JSON: {snippet}") from exc
    if not isinstance(data, dict):
        raise RuntimeError(f"{provider} {operation} returned invalid JSON object")
    return data


def _to_openai_tools(tools: Optional[List[ToolDescriptor]]) -> Optional[List[Dict[str, Any]]]:
    if not tools:
        return None
    out: List[Dict[str, Any]] = []
    for t in tools:
        params = t.input_schema if t.input_schema else {"type": "object", "properties": {}}
        out.append({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": params}})
    return out


def _to_openai_messages(messages: List[ChatMessage]) -> List[Dict[str, Any]]:
    """Convert internal ChatMessage list to OpenAI Chat Completions shape.

    Covers all providers that share the OpenAI wire format:
      - openai (OpenAI direct + Azure OpenAI deployments)
      - openrouter
      - copilot (GitHub Copilot Chat API; gh copilot CLI calls this same
        endpoint)

    (2026-05-24 RCA — multi-provider sweep)

    Two related bugs lived here, mirroring the ones we fixed in the
    Anthropic provider:

      1. The function only looked for tool_calls inside `m.content`
         (parsed as JSON). Stage_driver ships tool_calls as a sibling
         of `content`, so this path silently dropped every tool round-
         trip going to OpenAI/Copilot. The Anthropic side surfaced as
         "tool_result has no corresponding tool_use" 400s; the OpenAI
         side surfaces more subtly as the assistant looking like it
         hallucinated tool results out of thin air on the next turn
         (no matching tool_calls in its prior message → the LLM
         confidently fabricates).

      2. The shape conversion only understood gateway-flat
         {id, name, args} input, not the OpenAI-nested
         {id, type, function: {name, arguments}} that stage_driver
         actually builds. So even when the JSON-content path did fire
         (for the legacy mcp-server-style caller), the nested form
         got dropped.

    Both shapes are now accepted and normalized to OpenAI's expected
    output format.
    """
    out: List[Dict[str, Any]] = []
    for m in messages:
        if m.role == "tool":
            # tool_call_id is REQUIRED by the OpenAI API. Empty string
            # is silently accepted but the resulting message has no
            # parent and the model treats it as floating context.
            out.append({
                "role": "tool",
                "content": m.content or "",
                "tool_call_id": m.tool_call_id or "",
                "name": m.tool_name or "",
            })
            continue
        if m.role == "assistant":
            structured_tc: Optional[List[Dict[str, Any]]] = m.tool_calls
            if not structured_tc:
                # Legacy callers (pre-2026-05-24) JSON-encoded tool_calls
                # inside content. Try to recover that shape for backward-
                # compat with any caller still on the old wire format.
                try:
                    parsed = json.loads(m.content or "{}")
                    if isinstance(parsed, dict) and isinstance(parsed.get("tool_calls"), list):
                        structured_tc = parsed["tool_calls"]
                except Exception:
                    structured_tc = None
            if structured_tc:
                oa_tool_calls: List[Dict[str, Any]] = []
                for c in structured_tc:
                    if not isinstance(c, dict):
                        continue
                    # Normalize gateway-flat AND OpenAI-nested input
                    # shapes to OpenAI's expected output shape.
                    fn = c.get("function") if isinstance(c.get("function"), dict) else None
                    name = c.get("name") or (fn.get("name") if fn else None) or ""
                    raw_args: Any = c.get("args")
                    if raw_args is None and fn is not None:
                        raw_args = fn.get("arguments")
                    if raw_args is None:
                        raw_args = c.get("input")
                    # OpenAI expects arguments to be a JSON-STRING (not
                    # an object). Stringify whatever we have.
                    if isinstance(raw_args, str):
                        args_str = raw_args
                    elif isinstance(raw_args, dict):
                        args_str = json.dumps(raw_args)
                    elif raw_args is None:
                        args_str = "{}"
                    else:
                        args_str = json.dumps({"_raw": raw_args}, default=str)
                    oa_tool_calls.append({
                        "id": c.get("id") or f"tc-{uuid.uuid4().hex[:8]}",
                        "type": "function",
                        "function": {"name": name, "arguments": args_str},
                    })
                if oa_tool_calls:
                    # OpenAI accepts content=None when tool_calls is set
                    # (and many clients prefer it that way), but it ALSO
                    # accepts a non-empty string. Pass through whatever
                    # text the assistant produced so the next turn sees
                    # the model's reasoning alongside its tool call.
                    out.append({
                        "role": "assistant",
                        "content": m.content or None,
                        "tool_calls": oa_tool_calls,
                    })
                    continue
        out.append({"role": m.role, "content": m.content or ""})
    return out


async def respond(
    req: ChatCompletionRequest,
    *,
    provider: str,
    resolved_model: str,
    api_key: str,
    model_alias: Optional[str] = None,
) -> ChatCompletionResponse:
    if not api_key:
        raise RuntimeError(f"{provider.upper()}_API_KEY is not configured on the gateway")

    base_url = provider_base_url(provider).rstrip("/")
    url = f"{base_url}/chat/completions"
    body: Dict[str, Any] = {
        "model":    resolved_model,
        "messages": _to_openai_messages(req.messages),
    }
    if req.temperature is not None:        body["temperature"] = req.temperature
    if req.max_output_tokens is not None:  body["max_tokens"]  = req.max_output_tokens
    tools = _to_openai_tools(req.tools)
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
        # M83.x parallel exploration — let the model emit multiple
        # read-only tool calls in the same turn. The governed loop in
        # context-fabric dispatches them concurrently via
        # asyncio.gather for the parallel-safe allowlist. Mutating
        # tools (apply_patch, run_test, finish_work_branch) still
        # serialize on the loop side, so this flag is safe to flip
        # on even though some calls in a turn might be mutations —
        # the model can emit them in parallel, but they'll execute
        # in submission order.
        body["parallel_tool_calls"] = True

    start = time.time()
    headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=settings.upstream_timeout_sec) as client:
        res = await client.post(url, headers=headers, json=body)
    if res.status_code != 200:
        # 2000-char snippet to match Anthropic — the 400-char window was
        # enough to truncate "messages.N.content.0.tool_use.id: String
        # should match pattern '..." mid-sentence, sending the operator
        # on a second round trip to reproduce just to see the rest.
        snippet = res.text[:2000] if isinstance(res.text, str) else ""
        raise RuntimeError(f"{provider} returned {res.status_code}: {snippet}")
    data = _response_json_object(res, provider=provider, operation="chat")
    choice = (data.get("choices") or [None])[0]
    if not choice:
        raise RuntimeError(f"{provider} returned no choices")
    message = choice.get("message") or {}
    oa_calls = message.get("tool_calls") or []
    tool_calls: List[ToolCall] = []
    for c in oa_calls:
        try:
            args = json.loads(c.get("function", {}).get("arguments") or "{}")
        except Exception:
            args = {}
        tool_calls.append(ToolCall(
            id=c.get("id") or f"tc-{uuid.uuid4().hex[:8]}",
            name=c.get("function", {}).get("name") or "",
            args=args,
        ))

    finish = choice.get("finish_reason")
    if tool_calls:                  finish_reason = "tool_call"
    elif finish == "length":        finish_reason = "length"
    else:                           finish_reason = "stop"

    usage = data.get("usage") or {}

    # ADR 0003 — surface prompt-cache usage for OpenAI-compatible providers
    # (OpenAI, Azure OpenAI, GitHub Copilot). Caching on these backends is
    # AUTOMATIC (no request flag, ≥1024-token prefix) — there is nothing to
    # send, only to READ. The hit count lives at
    # usage.prompt_tokens_details.cached_tokens; there is no cache-write/
    # creation count on these providers (unlike Anthropic). Read it
    # defensively: prompt_tokens_details may be null/absent (known across
    # providers and Copilot models), so default to 0 and only emit a
    # prompt_cache block when the field was actually present, so we don't
    # fabricate "0 hits" for providers that simply don't report it. Shape
    # mirrors the Anthropic provider's prompt_cache dict for a uniform
    # response contract.
    prompt_cache_usage = None
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict) and details.get("cached_tokens") is not None:
        cached = details.get("cached_tokens")
        cached_int = int(cached) if isinstance(cached, (int, float)) else 0
        prompt_cache_usage = {
            "enabled": True,
            "strategy": (req.prompt_cache.strategy if req.prompt_cache else None) or "provider_auto",
            "cache_read_input_tokens": cached_int,
            # OpenAI/Azure/Copilot do not report a separate cache-write count.
            "cache_creation_input_tokens": 0,
            "reported": True,
        }
        if req.prompt_cache and req.prompt_cache.key:
            prompt_cache_usage["key"] = req.prompt_cache.key

    return ChatCompletionResponse(
        content=(message.get("content") or ""),
        tool_calls=tool_calls or None,
        finish_reason=finish_reason,
        input_tokens=usage.get("prompt_tokens") or 0,
        output_tokens=usage.get("completion_tokens") or 0,
        latency_ms=int((time.time() - start) * 1000),
        provider=provider,
        model=resolved_model,
        model_alias=model_alias,
        prompt_cache=prompt_cache_usage,
    )


async def embed(
    inputs: List[str],
    *,
    provider: str,
    resolved_model: str,
    api_key: str,
) -> Tuple[List[List[float]], int]:
    if not api_key:
        raise RuntimeError(f"{provider.upper()}_API_KEY is not configured on the gateway")
    base_url = provider_base_url(provider).rstrip("/")
    url = f"{base_url}/embeddings"
    headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}
    payload = {"model": resolved_model, "input": inputs}
    async with httpx.AsyncClient(timeout=settings.upstream_timeout_sec) as client:
        res = await client.post(url, headers=headers, json=payload)
    if res.status_code != 200:
        snippet = res.text[:400] if isinstance(res.text, str) else ""
        raise RuntimeError(f"{provider} embeddings {res.status_code}: {snippet}")
    data = _response_json_object(res, provider=provider, operation="embeddings")
    rows = data.get("data") or []
    vectors = [row.get("embedding") or [] for row in rows]
    usage = data.get("usage") or {}
    return vectors, int(usage.get("prompt_tokens") or 0)
