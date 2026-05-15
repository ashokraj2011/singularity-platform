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


def _to_openai_tools(tools: Optional[List[ToolDescriptor]]) -> Optional[List[Dict[str, Any]]]:
    if not tools:
        return None
    out: List[Dict[str, Any]] = []
    for t in tools:
        params = t.input_schema if t.input_schema else {"type": "object", "properties": {}}
        out.append({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": params}})
    return out


def _to_openai_messages(messages: List[ChatMessage]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for m in messages:
        if m.role == "tool":
            out.append({
                "role": "tool",
                "content": m.content,
                "tool_call_id": m.tool_call_id or "",
                "name": m.tool_name,
            })
            continue
        if m.role == "assistant":
            # mcp-server stringifies prior tool_calls into content; reverse here.
            try:
                parsed = json.loads(m.content or "{}")
                if isinstance(parsed, dict) and isinstance(parsed.get("tool_calls"), list) and parsed["tool_calls"]:
                    out.append({
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": c.get("id"),
                                "type": "function",
                                "function": {"name": c.get("name"), "arguments": json.dumps(c.get("args") or {})},
                            }
                            for c in parsed["tool_calls"]
                        ],
                    })
                    continue
            except Exception:
                pass
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
        body["parallel_tool_calls"] = False

    start = time.time()
    headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=settings.upstream_timeout_sec) as client:
        res = await client.post(url, headers=headers, json=body)
    if res.status_code != 200:
        snippet = res.text[:400] if isinstance(res.text, str) else ""
        raise RuntimeError(f"{provider} returned {res.status_code}: {snippet}")
    data = res.json()
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
    data = res.json()
    rows = data.get("data") or []
    vectors = [row.get("embedding") or [] for row in rows]
    usage = data.get("usage") or {}
    return vectors, int(usage.get("prompt_tokens") or 0)
