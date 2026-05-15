from __future__ import annotations

import json
import re
from typing import Any
import httpx

from context_fabric_shared.token_counter import count_text_tokens
from .config import settings

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


def fallback_summary(messages: list[dict]) -> dict[str, Any]:
    text = "\n".join([f"{m['role']}: {m['content']}" for m in messages])
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    bullets = []
    for ln in lines[-20:]:
        if len(ln) > 220:
            ln = ln[:220] + "..."
        bullets.append(ln)
    decisions = [ln for ln in bullets if re.search(r"\b(decided|decision|use|split|build|should|must)\b", ln, re.I)][:8]
    open_q = [ln for ln in bullets if "?" in ln][:8]
    return {
        "current_goal": last_user[:500] if last_user else "Continue the session.",
        "important_context": bullets[-10:],
        "decisions_made": decisions,
        "requirements": [],
        "constraints": [],
        "open_questions": open_q,
        "user_preferences": [],
        "technical_design": [],
        "changes_done": [],
        "next_best_actions": [],
        "durable_learning": decisions[:5],
    }


def _extract_json(text: str) -> dict | None:
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    match = re.search(r"\{.*\}", text, re.S)
    if match:
        try:
            data = json.loads(match.group(0))
            if isinstance(data, dict):
                return data
        except Exception:
            return None
    return None


def normalize_summary(data: dict) -> dict:
    normalized = {k: data.get(k, [] if k != "current_goal" else "") for k in SUMMARY_SCHEMA_KEYS}
    for k in SUMMARY_SCHEMA_KEYS:
        if k == "current_goal":
            normalized[k] = str(normalized[k])[:1000]
        elif not isinstance(normalized[k], list):
            normalized[k] = [str(normalized[k])]
        else:
            normalized[k] = [str(x) for x in normalized[k]][:20]
    return normalized


async def summarize_with_llm(messages: list[dict], agent_id: str | None = None) -> dict:
    """M33 — Routes through the central LLM gateway. The only fallback is the
    deterministic in-process string-parsing summary (no provider fallback)."""
    compact = "\n".join([f"{m['role']}: {m['content']}" for m in messages[-40:]])
    prompt = f"""
You are Context Fabric's summarization engine.
Create a compact structured JSON summary of this session.
Return only valid JSON with these keys:
{SUMMARY_SCHEMA_KEYS}

Rules:
- Preserve decisions, requirements, constraints, open questions, and durable learning.
- Do not invent details.
- Keep each list concise.

Conversation:
{compact}
""".strip()
    payload = {
        "model_alias": settings.summarizer_model_alias,
        "messages": [
            {"role": "system", "content": "You are Context Fabric's summarization engine. Return only valid JSON."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_output_tokens": 1500,
        "trace_id": f"summarize-{agent_id or 'anon'}",
    }
    try:
        headers = {"content-type": "application/json"}
        if settings.llm_gateway_bearer:
            headers["authorization"] = f"Bearer {settings.llm_gateway_bearer}"
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                settings.llm_gateway_url.rstrip("/") + "/v1/chat/completions",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            result = resp.json()
        data = _extract_json(result.get("content", "") or "")
        if data:
            return normalize_summary(data)
    except Exception:
        pass
    return fallback_summary(messages)


def summary_to_text(summary: dict) -> str:
    lines = []
    if summary.get("current_goal"):
        lines.append(f"Current goal: {summary['current_goal']}")
    for key in SUMMARY_SCHEMA_KEYS:
        if key == "current_goal":
            continue
        vals = summary.get(key) or []
        if vals:
            title = key.replace("_", " ").title()
            lines.append(f"\n{title}:")
            for item in vals[:12]:
                lines.append(f"- {item}")
    return "\n".join(lines).strip()


def summary_token_count(summary: dict) -> int:
    return count_text_tokens(summary_to_text(summary))
