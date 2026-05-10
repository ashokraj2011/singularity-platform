"""
M11.d — unified receipt endpoint for the context-fabric side.

Maps `call_log` rows + `events_store` rows into the canonical Receipt envelope
that workgraph's `/api/receipts` consolidates with its own AgentRun /
ToolRun / Approval rows. No central store — federate-live, same pattern as
M10/M11.b.

Envelope shape (kept identical across services):

  {
    "receipt_id":     str,
    "kind":           "agent_run" | "tool_invocation" | "model_call" |
                      "approval"  | "run_event"      | "artifact",
    "source_service": str,                # "context-api"
    "trace_id":       str | None,
    "subject":        { "kind": str, "id": str },
    "actor":          { "kind": str, "id": str | None } | None,
    "status":         str,                # started | completed | failed | paused | resolved
    "started_at":     str | None,         # ISO-8601
    "completed_at":   str | None,
    "correlation":    dict,               # 7-ID chain when known
    "metrics":        dict,               # tokens, latency, cost
    "payload":        dict,               # kind-specific
  }
"""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter, Query

from . import call_log, events_store


router = APIRouter()


# ── kind mapping for events_store rows ─────────────────────────────────────

_EVENT_KIND_MAP: dict[str, str] = {
    "llm.request":              "model_call",
    "llm.response":             "model_call",
    "llm.stream.delta":         "model_call",
    "tool.invocation.created":  "tool_invocation",
    "tool.invocation.updated":  "tool_invocation",
    "approval.wait.created":    "approval",
    "approval.wait.resolved":   "approval",
    "artifact.created":         "artifact",
    "artifact.updated":         "artifact",
    "run.event":                "run_event",
}

_EVENT_STATUS_MAP: dict[str, str] = {
    "llm.request":              "started",
    "llm.response":             "completed",
    "llm.stream.delta":         "streaming",
    "tool.invocation.created":  "started",
    "tool.invocation.updated":  "completed",
    "approval.wait.created":    "paused",
    "approval.wait.resolved":   "resolved",
    "artifact.created":         "completed",
    "artifact.updated":         "completed",
    "run.event":                "info",
}


def _envelope_from_call_log(row: dict[str, Any]) -> dict[str, Any]:
    """Each /execute call → one model_call receipt summarising the orchestration."""
    return {
        "receipt_id":     row.get("id"),
        "kind":           "model_call",
        "source_service": "context-api",
        "trace_id":       row.get("trace_id"),
        "subject":        {"kind": "cf_call", "id": str(row.get("id"))},
        "actor":          (
            {"kind": "agent_template", "id": row.get("agent_template_id")}
            if row.get("agent_template_id") else None
        ),
        "status":         (row.get("status") or "unknown").lower(),
        "started_at":     row.get("started_at"),
        "completed_at":   row.get("completed_at"),
        "correlation": {
            "cfCallId":          row.get("id"),
            "traceId":           row.get("trace_id"),
            "sessionId":         row.get("session_id"),
            "promptAssemblyId":  row.get("prompt_assembly_id"),
            "mcpServerId":       row.get("mcp_server_id"),
            "mcpInvocationId":   row.get("mcp_invocation_id"),
            "llmCallIds":        row.get("llm_call_ids") or [],
            "toolInvocationIds": row.get("tool_invocation_ids") or [],
            "artifactIds":       row.get("artifact_ids") or [],
            "workflowRunId":     row.get("workflow_run_id"),
            "workflowNodeId":    row.get("workflow_node_id"),
            "agentRunId":        row.get("agent_run_id"),
        },
        "metrics": {
            "input_tokens":  row.get("input_tokens"),
            "output_tokens": row.get("output_tokens"),
            "total_tokens":  row.get("total_tokens"),
            "steps_taken":   row.get("steps_taken"),
            "finish_reason": row.get("finish_reason"),
        },
        "payload": {
            "continuation_token":   row.get("continuation_token"),
            "pending_tool_name":    row.get("pending_tool_name"),
            "error":                row.get("error"),
            "final_response_chars": (
                len(row["final_response"]) if isinstance(row.get("final_response"), str) else None
            ),
        },
    }


def _envelope_from_event(row: dict[str, Any]) -> dict[str, Any]:
    kind  = _EVENT_KIND_MAP.get(row.get("kind") or "", "run_event")
    status = _EVENT_STATUS_MAP.get(row.get("kind") or "", "info")
    payload = row.get("payload") or {}
    return {
        "receipt_id":     row.get("id"),
        "kind":           kind,
        "source_service": "mcp-server",   # events_store rows are drained from MCP
        "trace_id":       row.get("trace_id"),
        "subject":        {"kind": kind, "id": (
            row.get("tool_invocation_id") or row.get("llm_call_id")
            or row.get("artifact_id") or row.get("id")
        )},
        "actor": (
            {"kind": "agent", "id": row.get("agent_id")}
            if row.get("agent_id") else None
        ),
        "status":         status,
        "started_at":     row.get("timestamp"),
        "completed_at":   row.get("timestamp") if status in ("completed", "resolved") else None,
        "correlation": {
            "traceId":            row.get("trace_id"),
            "runId":              row.get("run_id"),
            "runStepId":          row.get("run_step_id"),
            "workItemId":         row.get("work_item_id"),
            "agentId":            row.get("agent_id"),
            "capabilityId":       row.get("capability_id"),
            "mcpInvocationId":    row.get("mcp_invocation_id"),
            "toolInvocationId":   row.get("tool_invocation_id"),
            "artifactId":         row.get("artifact_id"),
            "llmCallId":          row.get("llm_call_id"),
        },
        "metrics": {
            "tokens_in":   payload.get("input_tokens"),
            "tokens_out":  payload.get("output_tokens"),
            "latency_ms":  payload.get("latency_ms"),
        },
        "payload":         payload,
    }


@router.get("/receipts")
def get_receipts(
    trace_id: str = Query(..., description="Required — joins events across services"),
    include_events: bool = Query(True, description="Include per-event receipts (LLM, tool, approval, artifact, run.event)"),
):
    call_rows = call_log.list_by_trace(trace_id, limit=200)
    receipts: list[dict[str, Any]] = [_envelope_from_call_log(r) for r in call_rows]
    if include_events:
        ev_rows = events_store.list_by_trace(trace_id, limit=2000)
        receipts.extend(_envelope_from_event(e) for e in ev_rows)

    # Sort newest-last so a UI can render a chronological timeline.
    def _ts(r: dict[str, Any]) -> str:
        return r.get("started_at") or r.get("completed_at") or ""
    receipts.sort(key=_ts)

    return {
        "trace_id":  trace_id,
        "total":     len(receipts),
        "receipts":  receipts,
    }
