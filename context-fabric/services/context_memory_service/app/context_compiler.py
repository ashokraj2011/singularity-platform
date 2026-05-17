from __future__ import annotations

import asyncio
import logging
from typing import Any
from context_fabric_shared.token_counter import count_message_tokens, count_text_tokens
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
    tokens = count_text_tokens(text)
    if tokens <= max_tokens:
        return text
    max_chars = max(500, max_tokens * 4)
    return text[:max_chars] + "\n...[trimmed to fit token budget]"


def build_optimized_context(session_id: str, agent_id: str | None, user_message: str, mode: str, max_context_tokens: int,
                            system_prompt: str | None = None) -> tuple[list[dict], list[str]]:
    mode = mode if mode in MODE_SETTINGS else "medium"
    settings = MODE_SETTINGS[mode]
    included_sections = ["system_prompt", "current_user_message"]

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

    recent_text = "\n".join([f"{m['role']}: {m['content']}" for m in recent_messages]) or "No recent messages."
    context_block = f"""
[CONTEXT FABRIC OPTIMIZED CONTEXT]
Optimization mode: {mode}

[ROLLING SESSION SUMMARY]
{summary_text or 'No rolling summary yet.'}

[RELEVANT MEMORY]
{memory_text}

[RECENT MESSAGES]
{recent_text}

[CURRENT USER MESSAGE]
{user_message}
""".strip()

    reserve = max(1000, int(max_context_tokens * 0.15))
    usable = max(1000, max_context_tokens - reserve - count_text_tokens(system_prompt or _get_default_system_prompt_sync()))
    context_block = _fit_text_to_budget(context_block, usable)

    return [
        {"role": "system", "content": system_prompt or _get_default_system_prompt_sync()},
        {"role": "user", "content": context_block},
    ], included_sections


def compile_context(session_id: str, agent_id: str | None, user_message: str, mode: str, max_context_tokens: int,
                    provider: str = "mock", model: str = "mock-fast", system_prompt: str | None = None) -> dict[str, Any]:
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

    raw_cost = estimate_input_cost(provider, model, raw_tokens)
    opt_cost = estimate_input_cost(provider, model, optimized_tokens)

    ctx_id = insert_context_package({
        "session_id": session_id,
        "agent_id": agent_id,
        "optimization_mode": mode,
        "compiled_context": optimized_messages,
        "raw_context_hash": sha256_json(raw_messages),
        "optimized_context_hash": sha256_json(optimized_messages),
        "raw_input_tokens": raw_tokens,
        "optimized_input_tokens": optimized_tokens,
        "tokens_saved": tokens_saved,
        "percent_saved": percent_saved,
        "included_sections": included_sections,
    })

    return {
        "context_package_id": ctx_id,
        "messages": optimized_messages,
        "included_sections": included_sections,
        "optimization": {
            "mode": mode,
            "raw_input_tokens": raw_tokens,
            "optimized_input_tokens": optimized_tokens,
            "tokens_saved": tokens_saved,
            "percent_saved": percent_saved,
            "estimated_raw_cost": raw_cost,
            "estimated_optimized_cost": opt_cost,
            "estimated_cost_saved": round(max(0.0, raw_cost - opt_cost), 8),
        },
    }
