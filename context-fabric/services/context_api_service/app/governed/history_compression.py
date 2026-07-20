"""
M74 Phase 3A — history compression for long stages.

A 25-turn stage with 3 tool calls per turn produces ~100 messages by
the end. Anthropic's prompt cache covers the prefix; everything past
the last verbatim message in the cache invalidates per turn. The cost
per turn grows linearly without bound.

Solution: keep the most recent N turns verbatim, compress everything
older into one-line "breadcrumb" messages that record what was called
(so the agent doesn't repeat the same lookup) but drop the full bodies.
Matches invoke.ts's applySlidingWindow + buildBreadcrumbMessage pattern
that the M71 cutover dropped.

Receipts (PhaseState.receipts) stay verbatim because they're the audit
trail of what the agent committed to per phase — compressing them
would defeat the receipt contract. Only the LLM-facing message log
compresses.

Design choices:

  • Turn boundary = assistant-role message. The history shape is
    one assistant + N tool messages per turn (see stage_driver
    _history_from_turn). The first assistant in the list is turn 1.

  • Prelude (everything before the first assistant message) stays
    verbatim. This is where Phase 2B's eval_feedback message lives,
    plus any caller-provided initial_history. Compressing prelude
    risks losing closed-loop signal.

  • Auto-verify injection (Phase 1A) lands as a user message AFTER
    a turn group. We attach it to the turn that came before it for
    compression purposes — the auto-verify output is what shaped
    the NEXT turn's decision, so dropping it without trace loses
    important context.

  • Breadcrumb format is one user-role message per compressed turn:
        [TURN-N-RECAP] called: tool1, tool2(query=foo); produced: assistant text snippet
    Bounded ~200 chars per breadcrumb; cheaper than the original
    ~1KB tool results but enough to prevent re-calling the same
    thing.
"""
from __future__ import annotations

import json
from typing import Any

from .conversation_budget import CF_PRELUDE_KEY

DEFAULT_RECENT_TURNS = 8
"""Default sliding-window size. After the first 8 turns, each older
turn collapses to a breadcrumb. Sized by inspection: 8 turns × ~3
tool calls × ~1KB result = ~24KB verbatim, plus per-breadcrumb ~200
bytes for the older N turns. A 25-turn stage compresses to roughly
24KB + 17 × 200B = ~27KB instead of unbounded ~100KB."""

_MAX_TOOL_ARGS_SUMMARY = 60
"""Per-tool args preview length inside the breadcrumb."""

_MAX_ASSISTANT_TEXT_SUMMARY = 120
"""Per-turn assistant content preview length inside the breadcrumb."""


_BREADCRUMB_MARKER = "[TURN-"
_BREADCRUMB_TAIL = "-RECAP]"


def _is_cf_prelude(msg: Any) -> bool:
    """Injected conversation memory, tagged by conversation_budget.

    Regardless of role. This is the whole point: injected history contains
    ASSISTANT turns, and `_is_assistant_start` would otherwise read each one as
    the start of a new turn group. On a long stage those groups fall out of the
    sliding window and collapse into breadcrumbs — so the conversation would
    work for eight turns and then silently evaporate around turn 9, with nothing
    in the logs to say memory had been thrown away. Tagged messages are prelude
    and prelude is never compressed.
    """
    return isinstance(msg, dict) and bool(msg.get(CF_PRELUDE_KEY))


def _count_breadcrumbs(prelude: list[dict[str, Any]]) -> int:
    """Count "[TURN-N-RECAP]" messages in a prelude slice. Used to
    preserve monotonic turn-index numbering across multiple
    compression passes (see review fix #1)."""
    count = 0
    for msg in prelude:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "user":
            continue
        if _is_cf_prelude(msg):
            # A user could paste "[TURN-3-RECAP]" into a chat. Injected
            # conversation text is never one of OUR breadcrumbs, so it must not
            # shift the numbering.
            continue
        content = msg.get("content") or ""
        if isinstance(content, str) and content.startswith(_BREADCRUMB_MARKER) and _BREADCRUMB_TAIL in content:
            count += 1
    return count


def _is_assistant_start(msg: dict[str, Any]) -> bool:
    """A turn group starts at the assistant message that closed
    the prior LLM call. Anything else (user/system/tool) is either
    prelude or part of the prior turn group.

    Injected conversation memory is exempt even when it is assistant-role: it
    records what was said in an EARLIER conversation, not a tool-calling turn
    this stage took."""
    if _is_cf_prelude(msg):
        return False
    return isinstance(msg, dict) and msg.get("role") == "assistant"


def _split_into_groups(
    messages: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[list[dict[str, Any]]]]:
    """Split a flat message list into (prelude, [turn_group, ...]).

    Prelude = everything before the first assistant message (typically
    eval_feedback + caller initial_history).

    Each turn_group starts at an assistant message and extends until
    the next assistant message. Tool messages and post-turn user
    injections (auto-verify, etc.) get bundled with the assistant
    they followed.

    `_cf_prelude`-tagged messages always land in prelude, whatever their role
    and wherever they appear. They arrive at the head of the list in practice,
    so the routing is usually a no-op; making it unconditional means the
    "never compressed" guarantee does not depend on a caller splicing them in
    the right position.
    """
    prelude: list[dict[str, Any]] = []
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] | None = None

    for msg in messages:
        if _is_cf_prelude(msg):
            prelude.append(msg)
        elif _is_assistant_start(msg):
            if current is not None:
                groups.append(current)
            current = [msg]
        elif current is None:
            prelude.append(msg)
        else:
            current.append(msg)

    if current is not None:
        groups.append(current)

    return prelude, groups


def _summarise_tool_args(args_str: str) -> str:
    """Render a tool_calls.function.arguments JSON string as a
    short, human-readable summary. The full args round-tripped
    through M73-followup #4 are too verbose for breadcrumbs."""
    if not args_str:
        return ""
    try:
        parsed = json.loads(args_str)
    except (json.JSONDecodeError, TypeError, ValueError):
        return args_str[:_MAX_TOOL_ARGS_SUMMARY]
    if not isinstance(parsed, dict):
        return str(parsed)[:_MAX_TOOL_ARGS_SUMMARY]
    # Pick the most informative single field — typically `path`,
    # `query`, `file`, `command`, or the first available key.
    for preferred in ("path", "query", "file", "command", "name"):
        if preferred in parsed:
            value = str(parsed[preferred])
            if len(value) > _MAX_TOOL_ARGS_SUMMARY:
                value = value[: _MAX_TOOL_ARGS_SUMMARY - 3] + "..."
            return f"{preferred}={value}"
    # Fall back to first key
    if parsed:
        key = next(iter(parsed))
        value = str(parsed[key])[:_MAX_TOOL_ARGS_SUMMARY]
        return f"{key}={value}"
    return ""


def _compress_group(
    group: list[dict[str, Any]],
    turn_index: int,
) -> dict[str, Any]:
    """Render one turn group as a single user-role breadcrumb. The
    breadcrumb captures what tools the agent invoked and a snippet
    of its text response — enough to prevent re-trying the same call,
    not enough to reconstruct the full reasoning."""
    assistant = group[0] if group else {}
    tool_calls = assistant.get("tool_calls") or []
    text_content = (assistant.get("content") or "").strip()

    parts: list[str] = []
    if tool_calls:
        tool_summaries: list[str] = []
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
            name = (fn or {}).get("name") or "(unknown)"
            args_summary = _summarise_tool_args(
                (fn or {}).get("arguments") or "",
            )
            tool_summaries.append(
                f"{name}({args_summary})" if args_summary else str(name),
            )
        if tool_summaries:
            parts.append(f"called: {', '.join(tool_summaries)}")

    if text_content:
        snippet = text_content[:_MAX_ASSISTANT_TEXT_SUMMARY]
        if len(text_content) > _MAX_ASSISTANT_TEXT_SUMMARY:
            snippet = snippet.rstrip() + "..."
        parts.append(f'said: "{snippet}"')

    if not parts:
        parts.append("(empty turn)")

    return {
        "role": "user",
        "content": f"[TURN-{turn_index}-RECAP] " + "; ".join(parts),
    }


def compress_history(
    messages: list[dict[str, Any]],
    recent_turns: int = DEFAULT_RECENT_TURNS,
) -> list[dict[str, Any]]:
    """Sliding-window compression: keep the last `recent_turns` turn
    groups verbatim; compress older groups to one breadcrumb each.

    Idempotent on already-compressed history (re-running produces the
    same shape; breadcrumbs don't start with assistant role, so they're
    treated as user prelude on subsequent passes — but only the prelude
    BEFORE the first verbatim assistant turn is preserved, which
    matches what we want).

    No-op when:
      • messages is empty
      • there are <= recent_turns turn groups
      • recent_turns <= 0 (defensive — caller shouldn't pass this)
    """
    if not messages or recent_turns <= 0:
        return messages
    prelude, groups = _split_into_groups(messages)
    if len(groups) <= recent_turns:
        return messages

    # Fix (review issue #1, 2026-05-23) — turn_index reset bug.
    #
    # compress_history is called every turn. After the first call, the
    # previously-emitted "[TURN-N-RECAP]" breadcrumbs are user-role
    # messages, so _split_into_groups classifies them into `prelude`
    # rather than as their own assistant-headed groups. Without
    # accounting for that, the next compression run starts numbering
    # at 1 again — operators (and the LLM) see multiple
    # "[TURN-1-RECAP]" entries with no chronological order.
    #
    # Count existing breadcrumbs in the prelude and offset new
    # indices past them so the breadcrumb stream stays monotonic
    # across compression passes.
    existing_breadcrumbs = _count_breadcrumbs(prelude)

    cutoff = len(groups) - recent_turns
    out: list[dict[str, Any]] = list(prelude)
    for idx, group in enumerate(groups[:cutoff]):
        # turn_index is 1-based for human display in the breadcrumb.
        # +existing_breadcrumbs preserves chronological numbering
        # across multiple compression passes.
        out.append(_compress_group(group, turn_index=existing_breadcrumbs + idx + 1))
    for group in groups[cutoff:]:
        out.extend(group)
    return out
