"""
Conversation budget — deciding how much of a conversation is worth sending.

Pure. No database, no clock, no network. Everything this module needs arrives as
an argument, so the whole tiering policy is unit-testable without a store.

THE SHAPE OF THE POLICY. Two tiers, in the order the model will read them:

    [CONVERSATION SUMMARY THROUGH TURN 40]  they agreed on X, rejected Y...
    user:       turn 41
    assistant:  turn 42
    ...
    user:       turn 52          <- newest, never dropped
    (the current turn, appended by the caller — outside this plan entirely)

Tier 1 is the verbatim tail: the last N user/assistant pairs, sent word for
word. Tier 2 is everything older, folded into the single summary line the
summariser wrote onto the conversation row. Nothing in between exists — a turn
is either verbatim or summarised.

WHY THE CURRENT TURN IS NOT IN HERE. The caller appends its own user message
after splicing this plan in, so the turn being asked about can never be dropped
by a budget decision. That is the point: a memory feature that could evict the
question would be worse than no memory at all.

DROP ORDER UNDER PRESSURE, and why it is this order:

  1. Oldest end of the verbatim tail. Recency is the cheapest useful proxy for
     relevance, and the oldest tail turns are the ones the summary is most
     likely to already cover.
  2. The summary, only once the tail is down to its last turn. It is dropped
     LAST because it is the only representation of everything before the tail;
     dropping it early would silently delete more history than dropping several
     verbatim turns would.
  3. Never the newest turn. If a single turn exceeds the whole budget the plan
     ships it anyway and says so in `reason`, because the alternative is
     returning an empty context that looks like "no history" instead of
     "history did not fit".

TOKEN ESTIMATE is `len(text) // 4`, which is what llm_client's mock accounting
and direct_llm_client already use. They agree with each other today; a third
estimate that disagreed would make budget maths incomparable across the two.
Exactness does not matter here — this decides how much to send, not what to bill.

MESSAGES ARE REBUILT, NOT FORWARDED. Every message is constructed fresh from
role + content, so DB columns (seq, tenant_id, cf_call_id, trace_id) cannot ride
along into a prompt. The role filter is a second copy of the store's rule: only
user/assistant, never tool. The store already refuses tool traffic on write, but
a read path that trusted that would be one schema change away from replaying an
orphaned tool_result — which Anthropic 400s, and which CF's loop cannot repair.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Mapping, Optional

from ..env_config import bounded_int_env

log = logging.getLogger(__name__)


DEFAULT_TOKEN_BUDGET = 12000
"""Tokens of conversation history, absent a known model window. Roughly 48KB of
text — big enough for a long working session, small enough that it cannot crowd
out the actual task on a 128k-window model."""

DEFAULT_VERBATIM_PAIRS = 6
"""User/assistant pairs kept word-for-word. Six pairs is where a chat stops
feeling amnesiac about what was just agreed."""

WINDOW_FRACTION = 0.25
"""Ceiling as a share of the model's input window. History is context, not the
job: three quarters of the window stays available for the prompt, the grounding
and the answer."""

CF_PRELUDE_KEY = "_cf_prelude"
"""Marks a message as injected conversation memory.

Load-bearing, in two directions:

  • history_compression._split_into_groups treats any assistant message as the
    start of a turn group. Injected history contains assistant turns, so without
    this marker the memory gets breadcrumbed away around turn 9 of a long stage
    — it would appear to work, then silently evaporate mid-run.

  • It must never reach a provider. `_openai_messages` copies unknown message
    keys straight through and OpenAI rejects unrecognised message fields, so the
    marker is stripped at every egress via `strip_internal_keys`.
"""

INJECTABLE_ROLES = ("user", "assistant")

SUMMARY_HEADER = "[CONVERSATION SUMMARY THROUGH TURN {seq}]"


def estimate_tokens(text: Optional[str]) -> int:
    """~4 chars per token. Matches llm_client / direct_llm_client. See module docstring."""
    if not text:
        return 0
    return len(text) // 4


def resolve_token_budget(model_input_window: Optional[int] = None) -> int:
    """The history budget for this turn.

    A known model window caps the budget at a quarter of it; otherwise the env
    value stands alone. `min` rather than `max` on purpose — a huge window is
    permission to spend more, not an instruction to.
    """
    env_budget = bounded_int_env(
        "CF_CONVERSATION_TOKEN_BUDGET",
        default=DEFAULT_TOKEN_BUDGET,
        min_value=0,
        max_value=2_000_000,
        logger=log,
    )
    if isinstance(model_input_window, int) and model_input_window > 0:
        return min(env_budget, int(model_input_window * WINDOW_FRACTION))
    return env_budget


def resolve_verbatim_pairs() -> int:
    return bounded_int_env(
        "CF_CONVERSATION_VERBATIM_PAIRS",
        default=DEFAULT_VERBATIM_PAIRS,
        min_value=0,
        max_value=200,
        logger=log,
    )


def _as_message(turn: Any) -> Optional[Dict[str, Any]]:
    """Rebuild a store row as a prompt message, or None if it does not belong.

    Rebuilt rather than copied so no DB column can ride into a prompt, and
    role-filtered so tool traffic cannot reach one even if the store's own
    write-side rule ever changes.
    """
    if not isinstance(turn, Mapping):
        return None
    role = str(turn.get("role") or "").strip().lower()
    if role not in INJECTABLE_ROLES:
        return None
    content = turn.get("content")
    if not isinstance(content, str) or not content.strip():
        return None
    return {"role": role, "content": content, CF_PRELUDE_KEY: True}


def _summary_message(summary: Optional[str], through_seq: int) -> Optional[Dict[str, Any]]:
    """The Tier 2 line, or None when nothing has been summarised yet.

    User role, not system: it sits mid-list, and Anthropic hoists system
    messages out of the conversation entirely. It also matches how
    history_compression already renders synthetic recaps.
    """
    if not isinstance(summary, str) or not summary.strip():
        return None
    header = SUMMARY_HEADER.format(seq=int(through_seq or 0))
    return {"role": "user", "content": f"{header} {summary.strip()}", CF_PRELUDE_KEY: True}


def _used_tokens(summary: Optional[Dict[str, Any]], tail: Iterable[Dict[str, Any]]) -> int:
    total = estimate_tokens(summary.get("content")) if summary else 0
    return total + sum(estimate_tokens(m.get("content")) for m in tail)


def plan_conversation_context(
    summary: Optional[str],
    turns: Optional[Iterable[Any]],
    *,
    budget: int,
    verbatim_pairs: int = DEFAULT_VERBATIM_PAIRS,
    summary_through_seq: int = 0,
) -> Dict[str, Any]:
    """Decide what to inject.

    `turns` arrives OLDEST-FIRST (what conversation_store.recent_turns returns)
    and stays that way through to the prompt. Selecting newest-first and
    reversing somewhere downstream is how transcripts end up backwards.

    Returns:
        messages      the list to splice into a prompt, oldest-first, every
                      entry tagged CF_PRELUDE_KEY
        dropped_count eligible turns that did not make it in, for any reason
        used_tokens   estimated cost of `messages`
        reason        which rule bound: within_budget | window_trimmed |
                      tail_trimmed | summary_dropped | over_budget_minimum
    """
    budget = max(0, int(budget))
    eligible: List[Dict[str, Any]] = []
    for turn in turns or ():
        message = _as_message(turn)
        if message is not None:
            eligible.append(message)

    window = max(0, int(verbatim_pairs)) * 2
    tail = eligible[-window:] if window else []
    dropped = len(eligible) - len(tail)
    reason = "window_trimmed" if dropped else "within_budget"

    summary_message = _summary_message(summary, summary_through_seq)

    # 1. Oldest end of the tail first, and never the last turn standing.
    while len(tail) > 1 and _used_tokens(summary_message, tail) > budget:
        tail.pop(0)
        dropped += 1
        reason = "tail_trimmed"

    # 2. The summary, only now that the tail cannot shrink further.
    if summary_message is not None and _used_tokens(summary_message, tail) > budget:
        summary_message = None
        reason = "summary_dropped"

    used = _used_tokens(summary_message, tail)
    if used > budget:
        # One turn larger than the entire budget. Ship it and say so: an empty
        # context here would be indistinguishable from "this chat has no history".
        reason = "over_budget_minimum"

    messages: List[Dict[str, Any]] = []
    if summary_message is not None:
        messages.append(summary_message)
    messages.extend(tail)

    return {
        "messages": messages,
        "dropped_count": dropped,
        "used_tokens": used,
        "reason": reason,
    }


def strip_internal_keys(messages: Optional[List[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
    """Remove CF-internal markers before a message list leaves the process.

    Returns the SAME list object when nothing is tagged, so the untagged path
    (which is every path while the feature flag is off) allocates nothing and
    stays byte-identical.
    """
    if not messages:
        return messages
    if not any(isinstance(m, Mapping) and CF_PRELUDE_KEY in m for m in messages):
        return messages
    return [
        {k: v for k, v in m.items() if k != CF_PRELUDE_KEY} if isinstance(m, Mapping) else m
        for m in messages
    ]
