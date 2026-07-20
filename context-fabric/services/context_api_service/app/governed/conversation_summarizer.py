"""
Conversation summariser — folding the old end of a conversation into prose.

WHAT THIS FIXES. conversation_budget ships two tiers: a verbatim tail of the
last N pairs, and a summary covering everything older. Until this module
existed only the first tier was real. `build()` reads turns with
`after_seq=summary_through_seq`, and `summary_through_seq` never moved off zero,
so every turn older than the verbatim window was simply DROPPED — memory was
exactly "last N pairs" and a long session forgot its own beginning. This is what
moves the watermark, and therefore what makes tier 2 exist.

IT NEVER RUNS ON THE REQUEST PATH. This is the load-bearing constraint of the
whole module and the reason `schedule()` exists as a separate entry point from
`summarize_conversation()`. Summarising is an LLM call — hundreds of
milliseconds at best, `CF_CONVERSATION_SUMMARY_TIMEOUT_SEC` at worst — and a
chat surface that paid that cost on the turn that happened to cross the
threshold would stutter unpredictably: fast, fast, fast, four seconds, fast.
Worse, it would be a second LLM call inside the handler of the first.

So the trigger is fire-and-forget: `schedule()` starts a task, returns
immediately, and the response goes out while the summariser is still thinking.
Nothing waits on the result and nothing reads it until some LATER turn calls
`build()`. A stale summary is a complete non-event — the watermark is simply
lower than it could be, so a few extra turns ride verbatim, which is the
behaviour of the system before this module existed. That is the whole reason
this design is safe: the failure mode of "too slow" and the failure mode of
"never ran" are both just "slightly more verbatim history".

MCP STAYS THE ONLY GATEWAY CLIENT. Ported from context_memory_service's
summarizer, which routes through `/mcp/invoke` rather than calling the LLM
gateway directly, and that routing is preserved deliberately — the platform's
rule is that MCP is the sole gateway caller, and a second direct client here
would be a hole in it, not a shortcut. The structured-JSON schema and the
deterministic `fallback_summary` parser come across with it, so a summariser
that cannot reach an LLM still produces something honest rather than nothing.

THE WATERMARK ONLY MOVES FORWARD. `conversation_store.set_summary` refuses a
`through_seq` at or below the one already recorded, so two overlapping
summarisation runs cannot have the slow one clobber the fast one's coverage.
This module leans on that rather than locking: the in-process `_IN_FLIGHT` guard
below is an LLM-cost optimisation, not a correctness mechanism, and it is
per-process so it would not be one anyway.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any, Dict, List, Mapping, Optional, Set

import httpx

from context_fabric_shared import get_system_prompt

from .. import conversation_store
from ..config import settings
from ..conversation_identity import resolve_conversation
from ..env_config import bounded_float_env, bounded_int_env
from .conversation_budget import estimate_tokens, resolve_verbatim_pairs

log = logging.getLogger(__name__)

_TRUTHY = {"1", "true", "yes", "on"}


DEFAULT_SUMMARY_TIMEOUT_SEC = 120.0
"""Generous on purpose. Nothing is waiting on this call — it runs after the
response has gone out — so the only thing a long timeout costs is a background
task hanging around. Matches context_memory_service's summariser default."""

DEFAULT_TRIGGER_SLACK_TURNS = 4
"""How far past the verbatim window the unsummarised span must run before a
summarisation is worth an LLM call.

Without slack the watermark would chase the tail on EVERY turn: each new
exchange pushes exactly one old exchange out of the verbatim window, so the
trigger would fire perpetually and spend a model call per turn to fold two more
messages in. Slack turns that into one call per few turns. The cost of slack is
that a handful of turns sit in neither tier for a short while — they are past
the verbatim window and not yet summarised — which is exactly the drop this
module exists to fix, so the number is kept small."""

DEFAULT_MAX_TURNS_PER_SUMMARY = 40
"""Cap on how many messages get fed to one summarisation call, newest kept.
Matches the source summariser's `messages[-40:]`. The rolling design means the
prior summary carries everything older, so this bounds the prompt without
losing coverage."""

SUMMARY_SCHEMA_KEYS = [
    "current_goal",
    "important_context",
    "decisions_made",
    "requirements",
    "constraints",
    "open_questions",
    "user_preferences",
    "technical_design",
    "changes_done",
    "next_best_actions",
    "durable_learning",
]

_SUMMARIZER_SYSTEM_FALLBACK = (
    "You are Context Fabric's summarization engine. Return only valid JSON."
)
_SUMMARIZER_USER_FALLBACK = (
    "You are Context Fabric's summarization engine.\n"
    "Create a compact structured JSON summary of this conversation.\n"
    "Return only valid JSON with these keys:\n"
    "{{schemaKeys}}\n\n"
    "Rules:\n"
    "- Preserve decisions, requirements, constraints, open questions, and durable learning.\n"
    "- Do not invent details.\n"
    "- Keep each list concise.\n\n"
    "Conversation:\n"
    "{{conversation}}"
)

# Strong references to in-flight background tasks. asyncio holds only a WEAK
# reference to a running task, so a fire-and-forget task with no owner can be
# garbage-collected mid-await and vanish silently. This set is the owner.
_TASKS: Set[asyncio.Task] = set()

# Conversations currently being summarised in THIS process. Purely a
# duplicate-LLM-call guard; correctness comes from the store's forward-only
# watermark, which holds across processes and this does not.
_IN_FLIGHT: Set[str] = set()


def is_enabled() -> bool:
    """THE summariser gate. Default false — this one spends money when on."""
    return str(os.environ.get("CF_CONVERSATION_SUMMARY_ENABLED", "")).strip().lower() in _TRUTHY


def _timeout_sec() -> float:
    return bounded_float_env(
        "CF_CONVERSATION_SUMMARY_TIMEOUT_SEC",
        default=DEFAULT_SUMMARY_TIMEOUT_SEC,
        min_value=1.0,
        max_value=3600.0,
        logger=log,
    )


def _trigger_slack_turns() -> int:
    return bounded_int_env(
        "CF_CONVERSATION_SUMMARY_SLACK_TURNS",
        default=DEFAULT_TRIGGER_SLACK_TURNS,
        min_value=0,
        max_value=1000,
        logger=log,
    )


def _max_turns_per_summary() -> int:
    return bounded_int_env(
        "CF_CONVERSATION_SUMMARY_MAX_TURNS",
        default=DEFAULT_MAX_TURNS_PER_SUMMARY,
        min_value=1,
        max_value=1000,
        logger=log,
    )


# ── deciding whether it is worth a call ─────────────────────────────────────


def due_through_seq(conversation: Mapping[str, Any]) -> Optional[int]:
    """The seq a summary should now cover, or None when one is not worth making.

    The target is always "everything except the verbatim tail": the tail is sent
    word for word anyway, so summarising it would duplicate it into the prompt
    twice. Returns None unless the target runs far enough past the current
    watermark to clear the slack — see DEFAULT_TRIGGER_SLACK_TURNS for why
    chasing the tail every turn is the thing being avoided.
    """
    head_seq = int(conversation.get("head_seq") or 0)
    covered = int(conversation.get("summary_through_seq") or 0)
    verbatim_turns = max(0, resolve_verbatim_pairs() * 2)

    target = head_seq - verbatim_turns
    if target <= 0:
        return None
    if target <= covered + _trigger_slack_turns():
        return None
    return target


# ── the LLM call, routed through MCP ────────────────────────────────────────


def _extract_json(text: str) -> Optional[dict]:
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except Exception:  # noqa: BLE001 — a non-JSON reply is expected, not exceptional
        pass
    match = re.search(r"\{.*\}", text, re.S)
    if match:
        try:
            data = json.loads(match.group(0))
            if isinstance(data, dict):
                return data
        except Exception:  # noqa: BLE001
            return None
    return None


def normalize_summary(data: Mapping[str, Any]) -> Dict[str, Any]:
    """Coerce whatever the model returned into the declared schema.

    A model that returns a string where a list belongs, or omits a key, or
    returns two hundred bullet points, must not be able to produce a summary
    that breaks the prompt it will later be spliced into.
    """
    normalized: Dict[str, Any] = {
        key: data.get(key, "" if key == "current_goal" else [])
        for key in SUMMARY_SCHEMA_KEYS
    }
    for key in SUMMARY_SCHEMA_KEYS:
        if key == "current_goal":
            normalized[key] = str(normalized[key])[:1000]
        elif not isinstance(normalized[key], list):
            normalized[key] = [str(normalized[key])]
        else:
            normalized[key] = [str(item) for item in normalized[key]][:20]
    return normalized


def fallback_summary(messages: List[Mapping[str, Any]]) -> Dict[str, Any]:
    """Deterministic, in-process, no network. The ONLY fallback.

    Ported from context_memory_service. It exists so an unreachable MCP degrades
    to a crude summary rather than to no summary at all — and a crude summary
    still moves the watermark, which still beats dropping those turns on the
    floor, which is what happens today.
    """
    lines = [
        line.strip()
        for message in messages
        for line in f"{message.get('role')}: {message.get('content')}".splitlines()
        if line.strip()
    ]
    last_user = next(
        (m.get("content") or "" for m in reversed(messages) if m.get("role") == "user"),
        "",
    )
    bullets = [(line[:220] + "...") if len(line) > 220 else line for line in lines[-20:]]
    decisions = [
        line for line in bullets
        if re.search(r"\b(decided|decision|use|split|build|should|must)\b", line, re.I)
    ][:8]
    open_questions = [line for line in bullets if "?" in line][:8]
    return normalize_summary({
        "current_goal": str(last_user)[:500] if last_user else "Continue the conversation.",
        "important_context": bullets[-10:],
        "decisions_made": decisions,
        "open_questions": open_questions,
        "durable_learning": decisions[:5],
    })


async def _resolve_prompts(schema_keys_text: str, compact: str) -> tuple[str, str]:
    """System + user templates from prompt-composer, with inline fallbacks.

    Same posture as the source summariser: composer is the source of truth, but
    it being unreachable on cold start must not stop a background job.
    """
    try:
        system_msg = (await get_system_prompt("context-fabric.summarizer.system")).content
    except Exception as err:  # noqa: BLE001
        log.warning("conversation_summarizer: system prompt fetch failed (%s); using fallback", err)
        system_msg = _SUMMARIZER_SYSTEM_FALLBACK
    try:
        user_msg = (await get_system_prompt(
            "context-fabric.summarizer.user-template",
            vars_payload={"schemaKeys": schema_keys_text, "conversation": compact},
        )).content
    except Exception as err:  # noqa: BLE001
        log.warning("conversation_summarizer: user prompt fetch failed (%s); using fallback", err)
        user_msg = (
            _SUMMARIZER_USER_FALLBACK
            .replace("{{schemaKeys}}", schema_keys_text)
            .replace("{{conversation}}", compact)
        )
    return system_msg, user_msg


async def summarize_with_llm(
    messages: List[Mapping[str, Any]], conversation_id: Optional[str] = None
) -> Dict[str, Any]:
    """Summarise via MCP. Falls back to the deterministic parser on any failure.

    Routed through `/mcp/invoke` rather than the LLM gateway directly, because
    MCP is the platform's sole gateway client and this module is not an
    exception to that.
    """
    compact = "\n".join(
        f"{m.get('role')}: {m.get('content')}"
        for m in messages[-_max_turns_per_summary():]
    )
    system_msg, prompt = await _resolve_prompts(str(SUMMARY_SCHEMA_KEYS), compact)
    timeout_sec = _timeout_sec()
    payload: Dict[str, Any] = {
        "systemPrompt": system_msg,
        "message": prompt,
        "tools": [],
        "modelConfig": {"temperature": 0, "maxTokens": 1500},
        "runContext": {
            "traceId": f"conversation-summary-{conversation_id or 'anon'}",
            # Deliberately NOT the conversation's own run_context: this is a
            # background maintenance call, not a turn on the surface, and
            # threading the surface through would make it look like one.
        },
        "limits": {
            "maxSteps": 1,
            "timeoutSec": timeout_sec,
            "compressToolResults": True,
            "includeLocalTools": False,
        },
    }
    model_alias = str(os.environ.get("SUMMARIZER_MODEL_ALIAS", "") or "").strip()
    if model_alias:
        payload["modelConfig"]["modelAlias"] = model_alias

    try:
        headers = {"content-type": "application/json"}
        if settings.mcp_default_bearer_token:
            headers["authorization"] = f"Bearer {settings.mcp_default_bearer_token}"
        async with httpx.AsyncClient(timeout=timeout_sec) as client:
            resp = await client.post(
                f"{settings.mcp_default_base_url.rstrip('/')}/mcp/invoke",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            result = resp.json()
        envelope = result.get("data") if isinstance(result, dict) else {}
        data = _extract_json((envelope or {}).get("finalResponse", "") or "")
        if data:
            return normalize_summary(data)
        log.warning("conversation_summarizer: MCP returned no parseable JSON; using fallback")
    except Exception as err:  # noqa: BLE001 — a background job never propagates
        log.warning("conversation_summarizer: MCP call failed (%s); using fallback", err)
    return fallback_summary(messages)


def summary_to_text(summary: Mapping[str, Any]) -> str:
    """Render the structured summary as the prose that goes into a prompt."""
    lines: List[str] = []
    if summary.get("current_goal"):
        lines.append(f"Current goal: {summary['current_goal']}")
    for key in SUMMARY_SCHEMA_KEYS:
        if key == "current_goal":
            continue
        values = summary.get(key) or []
        if values:
            lines.append(f"\n{key.replace('_', ' ').title()}:")
            for item in list(values)[:12]:
                lines.append(f"- {item}")
    return "\n".join(lines).strip()


# ── the job ─────────────────────────────────────────────────────────────────


def _load_span(conversation_id: str, through_seq: int, after_seq: int) -> List[Dict[str, Any]]:
    """Turns in (after_seq, through_seq], oldest first.

    Filtered in Python rather than SQL because the store exposes
    `turns_through` and `recent_turns`, and neither takes a bounded range —
    `recent_turns` would return the newest turns, which is the verbatim tail we
    are specifically excluding. This runs off the request path, so reading a few
    already-summarised rows and discarding them costs nothing that matters.
    """
    rows = conversation_store.turns_through(conversation_id, through_seq)
    return [row for row in rows if int(row.get("seq") or 0) > after_seq]


async def summarize_conversation(conversation_id: str) -> Optional[int]:
    """Summarise one conversation if it is due. Returns the new watermark or None.

    The rolling step: the PRIOR summary plus the turns it does not yet cover go
    in, one summary covering both comes out. Re-folding the whole conversation
    every time would grow the prompt without bound and cost more with every
    turn; carrying the prior summary forward is what makes this O(new turns).

    Raises nothing. This runs detached, so an exception escaping would surface
    as an unretrieved-task warning and nothing else useful.
    """
    if conversation_id in _IN_FLIGHT:
        return None
    _IN_FLIGHT.add(conversation_id)
    try:
        conversation = await asyncio.to_thread(
            conversation_store.get_conversation, conversation_id
        )
        if not conversation:
            return None
        through_seq = due_through_seq(conversation)
        if through_seq is None:
            return None

        covered = int(conversation.get("summary_through_seq") or 0)
        turns = await asyncio.to_thread(_load_span, conversation_id, through_seq, covered)
        if not turns:
            return None

        messages: List[Mapping[str, Any]] = []
        prior = conversation.get("summary_text")
        if prior:
            # The prior summary enters as context, labelled, so the model folds
            # into it rather than starting over and losing everything older.
            messages.append({
                "role": "user",
                "content": f"[SUMMARY OF THE CONVERSATION THROUGH TURN {covered}]\n{prior}",
            })
        messages.extend({"role": t.get("role"), "content": t.get("content")} for t in turns)

        summary = await summarize_with_llm(messages, conversation_id=conversation_id)
        text = summary_to_text(summary)
        if not text.strip():
            return None

        await asyncio.to_thread(
            conversation_store.set_summary,
            conversation_id,
            text,
            through_seq,
            estimate_tokens(text),
        )
        log.info(
            "conversation_summarizer: summarised conversation=%s through_seq=%d (was %d) turns=%d",
            conversation_id, through_seq, covered, len(turns),
        )
        return through_seq
    except Exception:  # noqa: BLE001 — detached job; nothing upstream can act on this
        log.warning(
            "conversation_summarizer: failed for conversation=%s; the watermark stays put",
            conversation_id, exc_info=True,
        )
        return None
    finally:
        _IN_FLIGHT.discard(conversation_id)


def _on_done(task: asyncio.Task) -> None:
    _TASKS.discard(task)
    # Retrieve the exception so a failed detached task does not log an
    # "exception was never retrieved" warning at GC time. summarize_conversation
    # already swallows everything, so this is belt-and-braces.
    if not task.cancelled():
        task.exception()


def schedule(
    run_context: Optional[Mapping[str, Any]],
    explicit_id: Optional[str] = None,
) -> Optional[asyncio.Task]:
    """Kick off summarisation in the background. Returns immediately, always.

    THE entry point for call sites, and the reason this is not just
    `await summarize_conversation(...)`: nothing on the request path may wait
    for an LLM call. The task runs on the same event loop, so the response goes
    out while it is still working, and if it never finishes the only consequence
    is a watermark that stayed where it was.

    Returns the task so tests can await it deterministically. Production callers
    ignore the return value — awaiting it would defeat the entire point.
    """
    try:
        if not is_enabled():
            return None
        identity = resolve_conversation(run_context, explicit_id)
        if not identity:
            return None
        conversation_id = identity.get("conversation_id")
        if not conversation_id:
            return None

        task = asyncio.create_task(summarize_conversation(str(conversation_id)))
        _TASKS.add(task)
        task.add_done_callback(_on_done)
        return task
    except RuntimeError:
        # No running event loop — a synchronous caller, or interpreter shutdown.
        # Summarisation is optional maintenance; there is nothing to recover.
        log.debug("conversation_summarizer: no event loop; skipping summarisation")
        return None
    except Exception:  # noqa: BLE001 — scheduling must never fail a turn
        log.warning("conversation_summarizer: could not schedule; skipping", exc_info=True)
        return None
