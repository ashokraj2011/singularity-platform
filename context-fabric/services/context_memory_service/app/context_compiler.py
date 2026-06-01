from __future__ import annotations

import asyncio
import logging
from typing import Any
from context_fabric_shared.token_counter import count_message_tokens, count_text_tokens, trim_text_to_tokens
from context_fabric_shared.hash_utils import sha256_json
from context_fabric_shared.costs import estimate_input_cost
from context_fabric_shared import get_system_prompt
from .repository import get_messages, get_latest_summary, list_memory_items, insert_context_package
from .memory_search import rank_memory_items
from .summarizer import summary_to_text

_logger = logging.getLogger(__name__)

# M37.2 — Was a module-level DEFAULT_SYSTEM_PROMPT string literal. Now fetched
# from prompt-composer (SystemPrompt key=context-fabric.context-compiler.default-system).
# Cached at first use; falls back to the legacy literal if composer is
# unreachable so context-fabric still serves traffic.
_FALLBACK_DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful assistant using Context Fabric. Use the supplied optimized "
    "context carefully. If information is missing, say what is missing instead of "
    "inventing details."
)
_DEFAULT_SYSTEM_PROMPT_CACHE: dict[str, str] = {}


async def _get_default_system_prompt_async() -> str:
    if "value" in _DEFAULT_SYSTEM_PROMPT_CACHE:
        return _DEFAULT_SYSTEM_PROMPT_CACHE["value"]
    try:
        result = await get_system_prompt("context-fabric.context-compiler.default-system")
        _DEFAULT_SYSTEM_PROMPT_CACHE["value"] = result.content
        return result.content
    except Exception as err:
        _logger.warning("[context_compiler] could not fetch default system prompt from composer: %s; falling back", err)
        _DEFAULT_SYSTEM_PROMPT_CACHE["value"] = _FALLBACK_DEFAULT_SYSTEM_PROMPT
        return _FALLBACK_DEFAULT_SYSTEM_PROMPT


def _get_default_system_prompt_sync() -> str:
    """Sync wrapper for callers that aren't async — uses the cache once warmed
    by the async path; otherwise returns the fallback."""
    return _DEFAULT_SYSTEM_PROMPT_CACHE.get("value", _FALLBACK_DEFAULT_SYSTEM_PROMPT)


# Back-compat shim — kept so external imports of DEFAULT_SYSTEM_PROMPT
# don't break. New code should call _get_default_system_prompt_sync().
DEFAULT_SYSTEM_PROMPT = _FALLBACK_DEFAULT_SYSTEM_PROMPT


async def warm_default_system_prompt() -> None:
    """Call this from app startup so the first request hits a warm cache."""
    await _get_default_system_prompt_async()

MODE_SETTINGS = {
    "none": {"recent": 999999, "memory": 999999, "summary": False},
    "conservative": {"recent": 12, "memory": 10, "summary": True},
    "medium": {"recent": 6, "memory": 5, "summary": True},
    "aggressive": {"recent": 3, "memory": 3, "summary": True},
    "ultra_aggressive": {"recent": 1, "memory": 2, "summary": True},
    "code_aware": {"recent": 8, "memory": 8, "summary": True},
    "audit_safe": {"recent": 20, "memory": 20, "summary": True},
}


def _to_chat_messages(rows: list[dict]) -> list[dict]:
    return [{"role": r["role"], "content": r["content"]} for r in rows]


def build_raw_context(session_id: str, user_message: str | None = None, system_prompt: str | None = None) -> list[dict]:
    messages = [{"role": "system", "content": system_prompt or _get_default_system_prompt_sync()}]
    messages.extend(_to_chat_messages(get_messages(session_id, ascending=True)))
    if user_message:
        messages.append({"role": "user", "content": user_message})
    return messages


def _format_memory(items: list[dict]) -> str:
    if not items:
        return "No relevant long-term memory found."
    lines = []
    for i, item in enumerate(items, start=1):
        lines.append(f"{i}. [{item.get('memory_type')}] {item.get('content')}")
    return "\n".join(lines)


def _fit_text_to_budget(text: str, max_tokens: int) -> str:
    """Token-based budget fit (was char-slicing). Kept as a thin wrapper over
    the shared trim_text_to_tokens so existing call sites stay valid."""
    if count_text_tokens(text) <= max_tokens:
        return text
    return trim_text_to_tokens(text, max_tokens) + "\n...[trimmed to fit token budget]"


def _norm_line(s: str) -> str:
    """Normalize a line for exact-match dedup: strip a leading list marker
    ('- ', '* '), collapse whitespace, lowercase. summary_to_text renders
    items as '- {item}', so stripping the marker lets a verbatim recent
    message match its summarized copy."""
    s = s.strip()
    if s[:2] in ("- ", "* "):
        s = s[2:]
    return " ".join(s.split()).lower()


def _resolve_mode(mode: str) -> tuple[str, str | None]:
    """Return (effective_mode, warning). Unknown modes fall back to 'medium'
    but produce a warning instead of silently degrading. Pure (no logging) so
    callers can decide whether/where to log."""
    if mode in MODE_SETTINGS:
        return mode, None
    return "medium", f"unknown optimization mode {mode!r}; fell back to 'medium'"


def _budget_section_bodies(
    sections: list[tuple[str, str]], budget_tokens: int
) -> tuple[list[tuple[str, str]], bool]:
    """Fit a list of (label, body) sections into budget_tokens, processed in
    KEEP-priority order (earliest = highest priority, trimmed last). Each label
    is counted against the budget; bodies are token-trimmed only when the
    remaining budget can't hold them. Returns (fitted_sections, any_trimmed).
    """
    out: list[tuple[str, str]] = []
    remaining = max(0, budget_tokens)
    any_trimmed = False
    for label, body in sections:
        label_cost = count_text_tokens(label)
        remaining = max(0, remaining - label_cost)
        body_tokens = count_text_tokens(body)
        if body_tokens <= remaining:
            out.append((label, body))
            remaining -= body_tokens
        elif remaining > 0:
            out.append((label, _fit_text_to_budget(body, remaining)))
            remaining = 0
            any_trimmed = True
        else:
            out.append((label, "...[trimmed to fit token budget]"))
            any_trimmed = True
    return out, any_trimmed


def build_optimized_context(session_id: str, agent_id: str | None, user_message: str, mode: str, max_context_tokens: int,
                            system_prompt: str | None = None) -> tuple[list[dict], list[str]]:
    effective_mode, mode_warning = _resolve_mode(mode)
    if mode_warning:
        _logger.warning("[context_compiler] %s", mode_warning)
    mode = effective_mode
    settings = MODE_SETTINGS[mode]
    included_sections = ["system_prompt", "current_user_message"]
    if mode_warning:
        included_sections.append("invalid_mode_fallback")

    if mode == "none":
        return build_raw_context(session_id, user_message, system_prompt), ["raw_full_context"]

    latest_summary = get_latest_summary(session_id)
    summary_text = ""
    if settings["summary"] and latest_summary:
        summary_text = summary_to_text(latest_summary["content"])
        included_sections.append("rolling_summary")

    recent_rows = get_messages(session_id, limit=settings["recent"], ascending=False)
    recent_messages = _to_chat_messages(recent_rows)
    if recent_messages:
        included_sections.append("recent_messages")

    all_memory = list_memory_items(agent_id=agent_id, session_id=None, limit=200) + list_memory_items(session_id=session_id, limit=200)
    ranked_memory = rank_memory_items(user_message + "\n" + summary_text, all_memory, limit=settings["memory"])
    memory_text = _format_memory(ranked_memory)
    if ranked_memory:
        included_sections.append("relevant_memory")

    # P3 — de-duplicate: drop verbatim recent lines whose normalized text is
    # already present in the rolling summary (the summary was built from the
    # last ~40 messages, so the recent window overlaps it). Exact-match only.
    summary_norm = {_norm_line(l) for l in summary_text.splitlines() if l.strip()} if summary_text else set()
    recent_lines: list[str] = []
    deduped = False
    for m in recent_messages:
        line = f"{m['role']}: {m['content']}"
        if summary_norm and _norm_line(m["content"]) in summary_norm:
            deduped = True
            continue
        recent_lines.append(line)
    if deduped:
        included_sections.append("recent_deduped_vs_summary")
    recent_text = "\n".join(recent_lines) or "No recent messages."

    system_content = system_prompt or _get_default_system_prompt_sync()

    # P1 — section-aware budgeting. The CURRENT USER MESSAGE is a fixed,
    # reserved cost and is NEVER trimmed (truncating the user's actual question
    # is a correctness failure). Only summary/memory/recent share the remaining
    # budget, trimmed in priority order recent → memory → summary (recent kept
    # first because freshest; summary trimmed first because most compressible).
    header = f"[CONTEXT FABRIC OPTIMIZED CONTEXT]\nOptimization mode: {mode}"
    current_block = f"[CURRENT USER MESSAGE]\n{user_message}"

    reserve = max(1000, int(max_context_tokens * 0.15))
    usable = max(1000, max_context_tokens - reserve - count_text_tokens(system_content))
    fixed_cost = count_text_tokens(header) + count_text_tokens(current_block)
    trim_budget = max(0, usable - fixed_cost)

    trimmable = [
        ("[RECENT MESSAGES]", recent_text),
        ("[RELEVANT MEMORY]", memory_text),
        ("[ROLLING SESSION SUMMARY]", summary_text or "No rolling summary yet."),
    ]
    fitted, any_trimmed = _budget_section_bodies(trimmable, trim_budget)
    if any_trimmed:
        included_sections.append("trimmed")
    # Reassemble in display order (summary → memory → recent → current).
    body_by_label = {label: body for label, body in fitted}
    context_block = "\n\n".join([
        header,
        f"[ROLLING SESSION SUMMARY]\n{body_by_label['[ROLLING SESSION SUMMARY]']}",
        f"[RELEVANT MEMORY]\n{body_by_label['[RELEVANT MEMORY]']}",
        f"[RECENT MESSAGES]\n{body_by_label['[RECENT MESSAGES]']}",
        current_block,
    ])

    return [
        {"role": "system", "content": system_content},
        {"role": "user", "content": context_block},
    ], included_sections


def _estimate_summary_generation_tokens(session_id: str, summary_text: str, model: str) -> int:
    """P2 — estimate the LLM-call cost incurred to PRODUCE the rolling summary
    now embedded in the optimized context. The summarizer (summarizer.py) feeds
    the last ~40 messages in and emits the summary. We approximate that call's
    input+output token cost so it can be charged against gross savings. Pure +
    deterministic (uses the same repository read + tiktoken counts as the
    summarizer), so unit tests can assert it exactly. Returns 0 when there is
    no embedded summary."""
    if not summary_text:
        return 0
    recent_for_summary = get_messages(session_id, limit=40, ascending=False)
    summary_input = "\n".join(f"{m['role']}: {m['content']}" for m in _to_chat_messages(recent_for_summary))
    return count_text_tokens(summary_input, model=model) + count_text_tokens(summary_text, model=model)


def compile_context(session_id: str, agent_id: str | None, user_message: str, mode: str, max_context_tokens: int,
                    provider: str = "mock", model: str = "mock-fast", system_prompt: str | None = None) -> dict[str, Any]:
    requested_mode = mode
    effective_mode, mode_warning = _resolve_mode(mode if mode != "none" else "none")
    # "none" is a valid mode; _resolve_mode already passes it through unchanged.

    raw_messages = build_raw_context(session_id, user_message=user_message, system_prompt=system_prompt)
    raw_tokens = count_message_tokens(raw_messages, model=model)

    optimized_messages, included_sections = build_optimized_context(
        session_id=session_id,
        agent_id=agent_id,
        user_message=user_message,
        mode=mode,
        max_context_tokens=max_context_tokens,
        system_prompt=system_prompt,
    )
    optimized_tokens = count_message_tokens(optimized_messages, model=model)
    tokens_saved = max(0, raw_tokens - optimized_tokens)
    percent_saved = round((tokens_saved / raw_tokens) * 100, 2) if raw_tokens else 0.0

    # P2 — honest accounting (additive; gross tokens_saved/percent_saved kept as-is).
    summary_included = "rolling_summary" in included_sections
    summary_text_for_cost = ""
    if summary_included:
        latest = get_latest_summary(session_id)
        if latest:
            summary_text_for_cost = summary_to_text(latest["content"])
    summary_generation_tokens = _estimate_summary_generation_tokens(session_id, summary_text_for_cost, model)
    net_tokens_saved = max(0, tokens_saved - summary_generation_tokens)
    net_percent_saved = round((net_tokens_saved / raw_tokens) * 100, 2) if raw_tokens else 0.0
    # Scaffolding = tokens spent purely on the [CONTEXT FABRIC ...] labels, so
    # consumers can see how much of the optimized footprint is formatting.
    scaffolding = sum(count_text_tokens(lbl, model=model) for lbl in (
        "[CONTEXT FABRIC OPTIMIZED CONTEXT]", "Optimization mode:",
        "[ROLLING SESSION SUMMARY]", "[RELEVANT MEMORY]",
        "[RECENT MESSAGES]", "[CURRENT USER MESSAGE]",
    ))

    raw_cost = estimate_input_cost(provider, model, raw_tokens)
    opt_cost = estimate_input_cost(provider, model, optimized_tokens)

    ctx_id = insert_context_package({
        "session_id": session_id,
        "agent_id": agent_id,
        "optimization_mode": effective_mode,
        "compiled_context": optimized_messages,
        "raw_context_hash": sha256_json(raw_messages),
        "optimized_context_hash": sha256_json(optimized_messages),
        "raw_input_tokens": raw_tokens,
        "optimized_input_tokens": optimized_tokens,
        "tokens_saved": tokens_saved,
        "percent_saved": percent_saved,
        "included_sections": included_sections,
    })

    optimization = {
        "mode": effective_mode,
        "requested_mode": requested_mode,
        "raw_input_tokens": raw_tokens,
        "optimized_input_tokens": optimized_tokens,
        "tokens_saved": tokens_saved,
        "percent_saved": percent_saved,
        # P2 — honest net accounting + breakdown (additive).
        "summary_generation_tokens": summary_generation_tokens,
        "net_tokens_saved": net_tokens_saved,
        "net_percent_saved": net_percent_saved,
        "optimized_scaffolding_tokens": scaffolding,
        "estimated_raw_cost": raw_cost,
        "estimated_optimized_cost": opt_cost,
        "estimated_cost_saved": round(max(0.0, raw_cost - opt_cost), 8),
    }
    if mode_warning:
        optimization["mode_warning"] = mode_warning

    return {
        "context_package_id": ctx_id,
        "messages": optimized_messages,
        "included_sections": included_sections,
        "optimization": optimization,
    }
