"""M33 — Deterministic mock provider.

Ported from `mcp-server/src/llm/mock.ts`. Same heuristics so existing smoke
tests pass unchanged. No network access.

M65 Slice 3A — Response-injection behaviours. When the request's
model_alias starts with `mock-fail-` or `mock-timeout`, the provider
simulates a flaky upstream by raising the right error / sleeping past
the gateway's `UPSTREAM_TIMEOUT_SEC`. Used by the chaos smoke harness
(M65 Slice 3B) to exercise the retry envelope + structured error
classification we hardened in M64.

Behaviours:
  mock-fast               — happy path (M33 default)
  mock-fail-429           — every call raises UpstreamHttpError(429)
  mock-fail-503           — every call raises UpstreamHttpError(503)
  mock-fail-529           — every call raises UpstreamHttpError(529)
  mock-fail-529-N         — N first calls raise 529, then happy path
                            (N parsed from the alias suffix)
  mock-timeout            — sleep past UPSTREAM_TIMEOUT_SEC then succeed
                            (lets the chaos suite verify timeout
                            classification, not just gateway retries)

Per-process call counter keyed by alias so `mock-fail-529-2` flips to
happy after 2 calls. Reset between test runs is operator
responsibility (restart the gateway container, or use distinct
aliases).
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import time
import uuid
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

from ..config import settings
from ..types import ChatMessage, ChatCompletionRequest, ChatCompletionResponse, ToolCall


# ── M65 Slice 3A — fault injection ─────────────────────────────────────────

# Module-level call counter keyed by model_alias. Used for the "first N
# calls fail" pattern (`mock-fail-529-2`). Per-process; not shared
# across gateway pods (which is fine for the chaos suite — it talks to
# one pod).
_call_counts: Dict[str, int] = defaultdict(int)


def _mock_body_for_status(status: int, alias: str) -> str:
    """Approximate Anthropic / OpenAI error-body shapes per status so
    downstream error classifiers (mcp-server's GatewayError dispatch
    in M64) behave as they would against a real provider.

    - 529 returns Anthropic's overloaded_error envelope (this is what
      mcp-server pattern-matches to LLM_PROVIDER_OVERLOADED).
    - 429 returns Anthropic's rate_limit_error envelope.
    - 503 returns a generic server_error envelope.
    """
    if status == 529:
        return '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_mock"}'
    if status == 429:
        return '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}'
    if status == 503:
        return '{"error":{"message":"Service Unavailable","type":"server_error"}}'
    return f'{{"error":{{"message":"mock-fail {status}","alias":"{alias}"}}}}'


async def _maybe_inject_failure(model_alias: str) -> None:
    """Inspect model_alias and raise HTTPException / async-sleep if it
    matches a fault pattern. Returns normally when no fault applies —
    caller falls through to the happy path.

    Raising HTTPException is the cleanest path because FastAPI
    propagates it as the final response status without the router
    having to know about a mock-specific error type.
    """
    if not model_alias:
        return
    alias = model_alias.lower()

    # `mock-timeout` — sleep just past UPSTREAM_TIMEOUT_SEC so the
    # gateway's AsyncClient cancels mid-call. Lets the chaos suite
    # assert that mcp-server classifies the result as
    # LLM_GATEWAY_TIMEOUT (not LLM_PROVIDER_*).
    if alias == "mock-timeout":
        sleep_for = settings.upstream_timeout_sec + 2
        await asyncio.sleep(sleep_for)
        # If we get here, the gateway's outer timeout didn't fire —
        # something is misconfigured. Return a clear error so the
        # chaos suite reports it instead of silently passing.
        raise HTTPException(
            status_code=500,
            detail=f"mock-timeout: slept {sleep_for}s without external cancellation. "
                   f"Is UPSTREAM_TIMEOUT_SEC ({settings.upstream_timeout_sec}) shorter than expected?",
        )

    # `mock-fail-{status}` — every call fails with that status.
    m = re.match(r"^mock-fail-(\d{3})$", alias)
    if m:
        status = int(m.group(1))
        body = _mock_body_for_status(status, alias)
        # Wrap in the same envelope shape as the anthropic upstream
        # error so mcp-server's classifier (M64) picks up the inner
        # `error.type=overloaded_error` for 529 etc.
        raise HTTPException(
            status_code=status,
            detail=f"LLM_GATEWAY_UPSTREAM: anthropic returned {status}: {body}",
        )

    # `mock-fail-{status}-{N}` — first N calls fail with `status`, then
    # happy. Used by the chaos suite to assert the gateway's retry
    # envelope absorbs transient failures.
    m = re.match(r"^mock-fail-(\d{3})-(\d+)$", alias)
    if m:
        status = int(m.group(1))
        n = int(m.group(2))
        _call_counts[alias] += 1
        if _call_counts[alias] <= n:
            body = _mock_body_for_status(status, alias)
            raise HTTPException(
                status_code=status,
                detail=f"LLM_GATEWAY_UPSTREAM: anthropic returned {status}: {body}",
            )
        # After N failures, fall through to happy path. The counter
        # stays bumped — subsequent calls succeed too. Operator can
        # restart the gateway to reset.
        return

    # Unknown alias — treat as happy.
    return


# ── M33 — original mock heuristics ─────────────────────────────────────────


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
    # M65 Slice 3A — Fault injection. When model_alias starts with
    # mock-fail-* / mock-timeout, this raises HTTPException with the
    # right status before any happy-path logic runs. Returns
    # normally for the standard `mock-fast` alias.
    await _maybe_inject_failure(req.model_alias or "")

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
