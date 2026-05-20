"""M33 — Deterministic mock provider.

Ported from `mcp-server/src/llm/mock.ts`. Same heuristics so existing smoke
tests pass unchanged. No network access.
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from ..types import ChatMessage, ChatCompletionRequest, ChatCompletionResponse, ToolCall


def _approx_tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / 4))


def _last(messages: List[ChatMessage], role: str) -> Optional[ChatMessage]:
    for m in reversed(messages):
        if m.role == role:
            return m
    return None


def _decide_tool(msg: str, tool_names: set[str]) -> Optional[ToolCall]:
    lower = msg.lower()
    echo = re.search(r"echo[:\s]+([^\n]+)", msg, re.IGNORECASE)
    if echo and "echo" in tool_names:
        return ToolCall(id=f"tc-{uuid.uuid4().hex[:8]}", name="echo", args={"text": echo.group(1).strip()})
    if "current_time" in tool_names and re.search(r"\b(time|timestamp|date|now|current\s+time)\b", lower):
        return ToolCall(id=f"tc-{uuid.uuid4().hex[:8]}", name="current_time", args={})
    if (
        "notify_admin" in tool_names
        and re.search(r"\b(notify|escalate|page|alert)\b", msg, re.IGNORECASE)
        and re.search(r"\b(admin|on[-\s]?call|ops)\b", msg, re.IGNORECASE)
    ):
        return ToolCall(
            id=f"tc-{uuid.uuid4().hex[:8]}",
            name="notify_admin",
            args={"subject": f"User-requested escalation: {msg[:80]}", "body": msg},
        )
    if "write_file" in tool_names or "write_file_demo" in tool_names:
        m = re.search(r"write\s+(.*?)\s+to\s+(\S+)", msg, re.IGNORECASE)
        if m:
            name = "write_file" if "write_file" in tool_names else "write_file_demo"
            return ToolCall(id=f"tc-{uuid.uuid4().hex[:8]}", name=name, args={"path": m.group(2), "content": m.group(1)})
    if "git_commit" in tool_names:
        m = re.search(r"(?:commit|commit message)\s*[:\-]?\s*(.+)$", msg, re.IGNORECASE)
        if m:
            return ToolCall(id=f"tc-{uuid.uuid4().hex[:8]}", name="git_commit", args={"message": m.group(1).strip()[:200]})
    return None


async def respond(req: ChatCompletionRequest, *, resolved_model: str) -> ChatCompletionResponse:
    start = time.time()
    await asyncio.sleep(0.04)  # simulate latency

    input_text_size = sum(len(m.content or "") for m in req.messages)
    input_tokens = _approx_tokens("\n".join(m.content or "" for m in req.messages))
    tool_names = {t.name for t in (req.tools or [])}

    last_tool = _last(req.messages, "tool")
    last_user = _last(req.messages, "user")

    if last_tool and req.messages[-1].role == "tool":
        try:
            parsed: Any = json.loads(last_tool.content)
        except Exception:
            parsed = last_tool.content
        reply = f"[mock] Tool '{last_tool.tool_name}' returned: {json.dumps(parsed)}. Done."
        return ChatCompletionResponse(
            content=reply,
            finish_reason="stop",
            input_tokens=input_tokens,
            output_tokens=_approx_tokens(reply),
            latency_ms=int((time.time() - start) * 1000),
            provider="mock",
            model=resolved_model,
        )

    if last_user:
        tc = _decide_tool(last_user.content or "", tool_names)
        if tc is not None:
            return ChatCompletionResponse(
                content="",
                tool_calls=[tc],
                finish_reason="tool_call",
                input_tokens=input_tokens,
                output_tokens=0,
                latency_ms=int((time.time() - start) * 1000),
                provider="mock",
                model=resolved_model,
            )

    reply = f"[mock] Received {len(req.messages)} message(s) ({input_text_size} chars). No tool call needed."
    return ChatCompletionResponse(
        content=reply,
        finish_reason="stop",
        input_tokens=input_tokens,
        output_tokens=_approx_tokens(reply),
        latency_ms=int((time.time() - start) * 1000),
        provider="mock",
        model=resolved_model,
    )


async def embed(inputs: List[str], *, resolved_model: str) -> Tuple[List[List[float]], int]:
    """Deterministic sha256-seeded mock embedding. Same 1536 default as the
    pgvector column. Tokens approximated for accounting parity."""
    import hashlib
    from struct import unpack
    dim = 1536
    vectors: List[List[float]] = []
    for text in inputs:
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        vec: List[float] = []
        i = 0
        while len(vec) < dim:
            b = digest[i % len(digest):(i % len(digest)) + 4]
            if len(b) < 4:
                b = b + b"\x00" * (4 - len(b))
            (raw,) = unpack(">I", b)
            vec.append((raw % 10_000) / 10_000.0 - 0.5)
            i += 1
        vectors.append(vec)
    return vectors, sum(_approx_tokens(t) for t in inputs)
