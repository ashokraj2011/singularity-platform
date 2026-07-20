"""
Conversation context — the one place that turns a run_context into prior turns.

This is the I/O half of the memory feature: resolve which conversation a turn
belongs to, read it, budget it, hand back messages. The policy lives next door
in conversation_budget (pure); everything that can fail lives here.

DARK BY DEFAULT. `CF_CONVERSATION_ENABLED` is false unless someone sets it, and
it is checked in exactly one place — the first line of `build()`. Every call
site therefore has one behaviour to reason about when the flag is off: `build()`
returns `[]`, `splice_prelude` returns its input list unchanged (the same
object), and the message list the model sees is byte-identical to today's. That
identity is the entire safety story of this PR, and it is what
test_conversation_context asserts first.

`CF_CONVERSATION_SURFACES` narrows the rollout further — a comma-separated
allowlist of normalised surface names, checked against what conversation_identity
resolved. Empty means "every surface that has a conversation at all". It exists
so turning memory on for the Ask sidecar, then rooms, then workflows is three
env changes and no caller redeploys.

MEMORY MUST NEVER FAIL A TURN. Every failure mode here degrades to `[]`, which
is exactly today's behaviour: store unreachable, row missing, schema surprise,
slow read, malformed run_context. A conversation feature that can 500 a chat is
a worse product than no conversation feature. The `except Exception` is
deliberate and total; CancelledError is a BaseException and is deliberately left
to propagate, because a cancelled request should stay cancelled.

The read is bounded by `CF_CONVERSATION_READ_TIMEOUT_SEC` and runs in a worker
thread, because conversation_store is synchronous DB-API code. Without the
thread hop a slow Postgres would block the whole event loop, and the timeout
would measure nothing.
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

_TRUTHY = {"1", "true", "yes", "on"}


def is_enabled() -> bool:
    """THE feature gate. One place, checked first, default false."""
    return str(os.environ.get("CF_CONVERSATION_ENABLED", "")).strip().lower() in _TRUTHY


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
