"""
M73 — response envelope assembly.

Pure functions that shape the /execute response (success + failure paths)
and the supporting token/cost/usage metadata block. No network I/O; no
side-effects beyond the persistence helper at the bottom that writes the
failure row to call_log.

Why a dedicated module: the response shape is consumed by workgraph-api's
context-fabric/client.ts AND by orchestrator.ts's adapter — they parse
specific keys (cfCallId, tokensUsed.{input,output,total}, modelUsage.*,
pendingApproval) so the SHAPE is a public contract. Centralising it
makes refactors safer.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from .. import call_log


def trim_text(text: str, max_chars: Optional[int]) -> str:
    """Truncate `text` to `max_chars`, appending a marker so the consumer
    can see something got cut. Used everywhere we honour a prompt-character
    budget."""
    if not max_chars or len(text) <= max_chars:
        return text
    return text[: max(0, max_chars - 80)].rstrip() + f"\n...[trimmed to {max_chars} chars by token budget]"


def int_limit(
    obj: dict[str, Any],
    *keys: str,
    default: Optional[int] = None,
) -> Optional[int]:
    """First positive numeric value found at any of `keys`, or `default`.
    Accepts both int and float (truncated). Returns None when nothing matches."""
    for key in keys:
        value = obj.get(key)
        if isinstance(value, int) and value > 0:
            return value
        if isinstance(value, float) and value > 0:
            return int(value)
    return default


def str_value(
    obj: dict[str, Any],
    *keys: str,
    default: Optional[str] = None,
) -> Optional[str]:
    """First non-empty string value found at any of `keys`, or `default`."""
    for key in keys:
        value = obj.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return default


def usage_metadata(
    *,
    tokens_used: dict[str, Any],
    model_overrides: dict[str, Any],
    prompt_assembly_id: Optional[str],
    cf_call_id: str,
    optimization_metrics: Optional[dict[str, Any]] = None,
    actual_model_usage: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Assemble the response.modelUsage + tokensUsed block.

    Pulls from three sources in priority order:
      1. `actual_model_usage` from the LLM gateway response.
      2. `model_overrides` from the caller (for the alias / provider hint).
      3. `tokens_used` totals from the agent loop (input/output/total/cost).

    The returned shape is what workgraph-api persists on AgentRunOutput
    and what Workbench renders in the "Tokens / cost" chip. Keep it stable.
    """
    input_tokens = tokens_used.get("input")
    output_tokens = tokens_used.get("output")
    total_tokens = tokens_used.get("total")
    actual_model_usage = actual_model_usage or {}
    model_alias = (
        str_value(actual_model_usage, "modelAlias", "model_alias")
        or str_value(model_overrides, "modelAlias", "model_alias")
    )
    provider = (
        str_value(actual_model_usage, "provider")
        or str_value(model_overrides, "provider", default="mcp-default")
    )
    model = (
        str_value(actual_model_usage, "model")
        or str_value(model_overrides, "model", default="mcp-default")
    )
    estimated_cost = (
        tokens_used.get("estimatedCost")
        or tokens_used.get("estimated_cost")
        or actual_model_usage.get("estimatedCost")
        or actual_model_usage.get("estimated_cost")
    )
    tokens_saved = None
    if isinstance(optimization_metrics, dict):
        tokens_saved = (
            optimization_metrics.get("tokens_saved")
            or optimization_metrics.get("tokensSaved")
        )
    prompt_cache = (
        actual_model_usage.get("promptCache")
        or actual_model_usage.get("prompt_cache")
        or tokens_used.get("promptCache")
        or tokens_used.get("prompt_cache")
    )
    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": total_tokens,
        "estimatedCost": estimated_cost,
        "modelAlias": model_alias,
        "provider": provider,
        "model": model,
        "tokensSaved": tokens_saved,
        "promptCache": prompt_cache,
        "promptAssemblyId": prompt_assembly_id,
        "cfCallId": cf_call_id,
    }


def persist_failure(
    *,
    cf_call_id: str,
    trace_id: str,
    started_at: str,
    capability_id: Optional[str],
    error_code: str,
    error_message: str,
    error_detail: Optional[dict[str, Any]] = None,
) -> None:
    """Write a FAILED row to call_log so the operator UI can render the
    failure with the same correlation surface (cf_call_id, trace_id) the
    success path uses. Best-effort: a store write failure doesn't shadow
    the original error."""
    try:
        call_log.persist({
            "cf_call_id": cf_call_id,
            "trace_id": trace_id,
            "capability_id": capability_id,
            "status": "FAILED",
            "started_at": started_at,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "error_code": error_code,
            "error_message": error_message,
            "error_detail": error_detail or {},
        })
    except Exception:
        # Failure-on-failure shouldn't escalate to the caller — they
        # already know the run failed. The store write loss is
        # recoverable via the audit-gov trail anyway.
        pass
