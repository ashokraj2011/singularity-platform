"""
M73 — conversation memory.

Interaction with the context-memory service for /execute's post-LLM-turn
persistence. The compile half (history + system prompt + recent turns
fetched at the START of a run) lives in
``prompt_context.compile_execute_context`` because it's a pure function
with no execute-body coupling. This module owns the WRITE half: after a
successful LLM response, persist the new user/assistant turn pair and
optionally trigger summarisation.

Done:

  persist_turn_and_maybe_summarise(...)
      ✅ EXTRACTED below. Wraps both the user+assistant message inserts
      and the rolling-summary trigger as one best-effort operation. The
      callsite in ``execute()`` used to be 36 lines of inline httpx
      calls in a single try/except; it's now one ``await``.

Deferred:

  build_history(...)
      Not extracted from this module — see
      ``prompt_context.compile_execute_context``. That function reads
      memory the way the prompt-composer expects, so it lives with the
      prompt context plumbing rather than with the writers.
"""
from __future__ import annotations

from typing import Any, Optional

import httpx

from ..config import settings


def _summary_every_default(limits: dict[str, Any]) -> int:
    """The rolling summariser fires when this many new messages have been
    persisted since the last summary. Caller-overridable via
    limits.summaryEveryMessages / summary_every_messages; default 6."""
    raw = (
        limits.get("summaryEveryMessages")
        or limits.get("summary_every_messages")
    )
    if isinstance(raw, int) and raw > 0:
        return raw
    if isinstance(raw, float) and raw > 0:
        return int(raw)
    return 6


async def persist_turn_and_maybe_summarise(
    *,
    session_id: str,
    agent_id: Optional[str],
    user_message: str,
    assistant_response: Optional[str],
    limits: dict[str, Any] | None = None,
) -> None:
    """Post-LLM bookkeeping. Best-effort: any failure is swallowed.

    Three calls happen here, in order:

      1. POST /memory/messages with role=user — always, because the
         caller's task text becomes the next compile's "last user
         message" anchor.

      2. POST /memory/messages with role=assistant — only when the LLM
         produced a final_response. Tool-only turns (no assistant text)
         skip this; the verification receipts still flow through other
         channels.

      3. POST /memory/summaries/update — non-forcing trigger that tells
         the summariser "check if we've crossed the threshold since the
         last summary." The summariser decides whether to actually run.

    The whole block is wrapped in one try/except: memory write is
    secondary to returning the LLM response to the caller. Workgraph
    treats memory persistence as a soft signal; an outage there should
    not bubble up to the agent-task executor as a failure.
    """
    base = settings.context_memory_url.rstrip("/")
    summary_every = _summary_every_default(limits or {})

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{base}/memory/messages",
                json={
                    "session_id": session_id,
                    "agent_id": agent_id,
                    "role": "user",
                    "content": user_message,
                },
            )
            if assistant_response:
                await client.post(
                    f"{base}/memory/messages",
                    json={
                        "session_id": session_id,
                        "agent_id": agent_id,
                        "role": "assistant",
                        "content": assistant_response,
                    },
                )
            await client.post(
                f"{base}/memory/summaries/update",
                json={
                    "session_id": session_id,
                    "agent_id": agent_id,
                    "force": False,
                    "min_messages_since_last_summary": summary_every,
                },
                timeout=20.0,
            )
    except Exception:
        # Best-effort. Memory write is a soft signal; an outage here must
        # not propagate to the /execute response.
        return
