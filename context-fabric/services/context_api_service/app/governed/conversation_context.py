"""
Conversation context — the one place that turns a run_context into prior turns,
and the one place that writes a completed turn back.

This is the I/O half of the memory feature: resolve which conversation a turn
belongs to, read it, budget it, hand back messages — then, once the turn has
actually produced an answer, append the pair. The policy lives next door in
conversation_budget (pure); everything that can fail lives here.

READS AND WRITES ARE GATED SEPARATELY, ON PURPOSE.

    CF_CONVERSATION_ENABLED        -> build() returns prior turns
    CF_CONVERSATION_WRITE_ENABLED  -> record_turn() persists completed turns

Two flags rather than one because a store with no history in it is useless to
read. Writes can be switched on first to WARM the store — every enabled surface
starts accumulating turns while reads stay dark and no model output changes —
and reads flipped on afterwards, at which point there is already something to
remember. One flag would have forced the first enabled conversation to also be
the first conversation with an empty history, which is the worst moment to
learn the read path is wrong.

The surface allowlist (`CF_CONVERSATION_SURFACES`) deliberately gates READS
only. Narrowing reads while writing broadly is the whole point of warming: an
operator can accumulate history everywhere and let exactly one surface read it.

DARK BY DEFAULT. Both flags are false unless someone sets them, and each is
checked in exactly one place — the first line of `build()` and of
`record_turn()`. Every call site therefore has one behaviour to reason about
when the flags are off: `build()` returns `[]`, `splice_prelude` returns its
input list unchanged (the same object), `record_turn()` writes nothing, and the
message list the model sees is byte-identical to today's. That identity is the
entire safety story of this PR, and it is what test_conversation_context
asserts first.

`CF_CONVERSATION_SURFACES` narrows the rollout further — a comma-separated
allowlist of normalised surface names, checked against what conversation_identity
resolved. Empty means "every surface that has a conversation at all". It exists
so turning memory on for the Ask sidecar, then rooms, then workflows is three
env changes and no caller redeploys.

MEMORY MUST NEVER FAIL A TURN. Every failure mode here degrades to `[]` on read
and to a dropped write, which is exactly today's behaviour: store unreachable,
row missing, schema surprise, slow read, malformed run_context. A conversation
feature that can 500 a chat is a worse product than no conversation feature.
This matters MORE on the write path than the read path: a write happens after
the model has already answered, so an exception escaping here would throw away
a good answer over a bookkeeping failure. The `except Exception` is deliberate
and total; CancelledError is a BaseException and is deliberately left to
propagate, because a cancelled request should stay cancelled.

Both directions are bounded (`CF_CONVERSATION_READ_TIMEOUT_SEC`,
`CF_CONVERSATION_WRITE_TIMEOUT_SEC`) and run in a worker thread, because
conversation_store is synchronous DB-API code. Without the thread hop a slow
Postgres would block the whole event loop, and the timeout would measure
nothing.

ONLY USER TEXT AND FINAL ASSISTANT TEXT ARE EVER WRITTEN. `record_turn` takes
exactly two strings and has no parameter that could carry a tool call, a
tool_result, a system prompt or a composed prompt layer. That is a type-level
restatement of conversation_store's role filter rather than a second copy of the
rule: the store refuses tool traffic, and this signature means the call sites
cannot even offer it. Persisting a composed prompt would be its own bug — the
platform's own grounding would come back next turn wearing the user's voice.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from .. import conversation_store
from ..conversation_identity import resolve_conversation
from ..env_config import bounded_float_env
from .conversation_budget import (
    CF_PRELUDE_KEY,
    estimate_tokens,
    plan_conversation_context,
    resolve_token_budget,
    resolve_verbatim_pairs,
)

log = logging.getLogger(__name__)


DEFAULT_READ_TIMEOUT_SEC = 2.0
"""A conversation read is on the critical path of every LLM turn on an enabled
surface. Two seconds is far longer than a primary-key lookup plus an indexed
range scan should ever take, and short enough that a sick database costs a turn
its memory rather than its latency budget."""

DEFAULT_WRITE_TIMEOUT_SEC = 2.0
"""Same reasoning as the read timeout, applied after the answer exists. The
turn's result is already in hand by the time this runs, so blowing the timeout
costs the conversation one remembered exchange and costs the caller nothing."""

_TRUTHY = {"1", "true", "yes", "on"}


def is_enabled() -> bool:
    """THE read gate. One place, checked first, default false."""
    return str(os.environ.get("CF_CONVERSATION_ENABLED", "")).strip().lower() in _TRUTHY


def is_write_enabled() -> bool:
    """THE write gate. Independent of the read gate so the store can be warmed.

    See the module docstring: writes-on/reads-off is a real, useful state — it
    accumulates history with zero change to any model's output.
    """
    return str(os.environ.get("CF_CONVERSATION_WRITE_ENABLED", "")).strip().lower() in _TRUTHY


def _surface_allowlist() -> Set[str]:
    raw = str(os.environ.get("CF_CONVERSATION_SURFACES", "") or "")
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


def _surface_allowed(surface: Optional[str]) -> bool:
    allowed = _surface_allowlist()
    if not allowed:
        return True
    # An unset allowlist means "all"; a set one is exhaustive, so a conversation
    # whose surface did not normalise stays dark rather than defaulting open.
    return bool(surface) and str(surface).strip().lower() in allowed


def _read_timeout_sec() -> float:
    return bounded_float_env(
        "CF_CONVERSATION_READ_TIMEOUT_SEC",
        default=DEFAULT_READ_TIMEOUT_SEC,
        min_value=0.05,
        max_value=60.0,
        logger=log,
    )


def _write_timeout_sec() -> float:
    return bounded_float_env(
        "CF_CONVERSATION_WRITE_TIMEOUT_SEC",
        default=DEFAULT_WRITE_TIMEOUT_SEC,
        min_value=0.05,
        max_value=60.0,
        logger=log,
    )


def _load(conversation_id: str, limit: int) -> Optional[Tuple[Dict[str, Any], List[Dict[str, Any]]]]:
    """Synchronous store read: the conversation row plus its unsummarised tail.

    `after_seq=summary_through_seq` asks for exactly the span the summary does
    NOT cover, so a turn can never be both summarised and replayed verbatim.
    """
    conversation = conversation_store.get_conversation(conversation_id)
    if not conversation:
        return None
    through_seq = int(conversation.get("summary_through_seq") or 0)
    turns = conversation_store.recent_turns(conversation_id, limit, after_seq=through_seq)
    return conversation, turns


async def build(
    run_context: Optional[Mapping[str, Any]],
    explicit_id: Optional[str] = None,
    *,
    model_input_window: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Prior turns for this conversation, ready to splice into a prompt.

    Returns `[]` — today's behaviour, unchanged — when the flag is off, when the
    surface is not in the allowlist, when the turn belongs to no conversation,
    when the conversation is empty, or when anything at all goes wrong.

    Every returned message carries `_cf_prelude: True`; see conversation_budget
    for why that marker exists and where it gets stripped.
    """
    try:
        if not is_enabled():
            return []

        identity = resolve_conversation(run_context, explicit_id)
        if not identity:
            # No conversation for this turn. The ten one-shot extractors live
            # here permanently, by design — see conversation_identity rule 1.
            return []
        conversation_id = identity.get("conversation_id")
        if not conversation_id:
            return []
        if not _surface_allowed(identity.get("surface")):
            return []

        verbatim_pairs = resolve_verbatim_pairs()
        budget = resolve_token_budget(model_input_window)
        # Read only what Tier 1 could possibly use. Anything older is the
        # summary's job, so fetching it would be bytes we would then discard.
        limit = max(1, verbatim_pairs * 2)

        loaded = await asyncio.wait_for(
            asyncio.to_thread(_load, conversation_id, limit),
            timeout=_read_timeout_sec(),
        )
        if not loaded:
            return []
        conversation, turns = loaded

        plan = plan_conversation_context(
            conversation.get("summary_text"),
            turns,
            budget=budget,
            verbatim_pairs=verbatim_pairs,
            summary_through_seq=int(conversation.get("summary_through_seq") or 0),
        )
        messages = plan.get("messages") or []
        if not messages:
            return []
        # The marker is an invariant of anything this function returns, not just
        # of what the planner happened to build. Cheap to guarantee here.
        for message in messages:
            message[CF_PRELUDE_KEY] = True

        log.info(
            "conversation_context: injected %d message(s) conversation=%s surface=%s "
            "tokens~%d dropped=%d reason=%s",
            len(messages), conversation_id, identity.get("surface"),
            plan.get("used_tokens"), plan.get("dropped_count"), plan.get("reason"),
        )
        return messages

    except TimeoutError:
        # asyncio.TimeoutError is the builtin from 3.11 on.
        log.warning(
            "conversation_context: read timed out after %.2fs; continuing without memory",
            _read_timeout_sec(),
        )
        return []
    except Exception:  # noqa: BLE001 — memory degrades, it never fails a turn
        log.warning("conversation_context: unavailable; continuing without memory", exc_info=True)
        return []


def _persist(
    identity: Mapping[str, Optional[str]],
    user_text: str,
    assistant_text: str,
    *,
    tenant_id: Optional[str],
    user_id: Optional[str],
    capability_id: Optional[str],
    agent_role: Optional[str],
    cf_call_id: Optional[str],
    trace_id: Optional[str],
) -> int:
    """Synchronous store write: ensure the row exists, then append the pair.

    Returns how many turns actually landed. `append_turn` returns None for an
    ineligible role or empty content, so a pure-tool-call turn with no prose
    quietly contributes nothing rather than writing a blank message.
    """
    conversation_id = str(identity.get("conversation_id"))
    conversation_store.ensure_conversation(
        conversation_id,
        tenant_id=tenant_id,
        user_id=user_id,
        surface=identity.get("surface"),
        scope_kind=identity.get("scope_kind"),
        scope_id=identity.get("scope_id"),
        capability_id=capability_id,
        agent_role=agent_role,
    )
    written = 0
    # Order matters: the user turn must take a lower seq than the answer to it,
    # and append_turn assigns seq in call order.
    for role, text in (("user", user_text), ("assistant", assistant_text)):
        seq = conversation_store.append_turn(
            conversation_id,
            role,
            text,
            tokens=estimate_tokens(text),
            cf_call_id=cf_call_id,
            trace_id=trace_id,
            tenant_id=tenant_id,
        )
        if seq is not None:
            written += 1
    return written


async def record_turn(
    run_context: Optional[Mapping[str, Any]],
    *,
    user_text: Optional[str],
    assistant_text: Optional[str],
    explicit_id: Optional[str] = None,
    cf_call_id: Optional[str] = None,
    trace_id: Optional[str] = None,
) -> int:
    """Persist one completed exchange. Returns the number of turns written.

    Call this AFTER the turn has produced its answer, never before: an
    unanswered user turn left in the store would be replayed next time as a
    question the assistant ignored. Both halves are written together or not at
    all, so a failed LLM call leaves the conversation exactly as it was.

    Writes nothing — and raises nothing — when the write flag is off, when the
    turn belongs to no conversation, when either half is empty, or when anything
    at all goes wrong. See the module docstring: this runs after the model has
    already answered, so it is never allowed to be the reason a turn fails.

    `user_text` and `assistant_text` are the only content parameters that exist.
    Tool traffic has no way in.
    """
    try:
        if not is_write_enabled():
            return 0

        identity = resolve_conversation(run_context, explicit_id)
        if not identity or not identity.get("conversation_id"):
            # Stateless by design — the one-shot extractors live here forever.
            return 0

        user_clean = (user_text or "").strip()
        assistant_clean = (assistant_text or "").strip()
        if not user_clean or not assistant_clean:
            # A half-exchange is worse than none: replaying a question with no
            # answer teaches the model that it ignores users.
            return 0

        rc = run_context or {}
        written = await asyncio.wait_for(
            asyncio.to_thread(
                _persist,
                identity,
                user_clean,
                assistant_clean,
                tenant_id=rc.get("tenant_id") or rc.get("tenantId"),
                user_id=rc.get("user_id") or rc.get("userId"),
                capability_id=rc.get("capability_id") or rc.get("capabilityId"),
                agent_role=rc.get("agent_role") or rc.get("agentRole"),
                cf_call_id=cf_call_id,
                trace_id=trace_id,
            ),
            timeout=_write_timeout_sec(),
        )
        log.info(
            "conversation_context: recorded %d turn(s) conversation=%s surface=%s",
            written, identity.get("conversation_id"), identity.get("surface"),
        )
        return written

    except TimeoutError:
        log.warning(
            "conversation_context: write timed out after %.2fs; turn not remembered",
            _write_timeout_sec(),
        )
        return 0
    except Exception:  # noqa: BLE001 — memory degrades, it never fails a turn
        log.warning("conversation_context: write failed; turn not remembered", exc_info=True)
        return 0


def splice_prelude(
    messages: Sequence[Dict[str, Any]],
    prelude: Optional[Sequence[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Insert conversation history after the system prompt, before the current turn.

    The current turn is the last user message in the list, so history lands
    immediately in front of it and the model reads the transcript in order. With
    an empty prelude the input list is returned unchanged — same object, so the
    flag-off path is provably a no-op.
    """
    if not prelude:
        return messages  # type: ignore[return-value]

    out = list(messages)
    for idx in range(len(out) - 1, -1, -1):
        if isinstance(out[idx], Mapping) and out[idx].get("role") == "user":
            insert_at = idx
            break
    else:
        # No user message to sit in front of; land after any leading system block.
        insert_at = 0
        while insert_at < len(out) and isinstance(out[insert_at], Mapping) \
                and out[insert_at].get("role") == "system":
            insert_at += 1

    out[insert_at:insert_at] = list(prelude)
    return out
