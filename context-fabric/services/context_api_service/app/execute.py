"""
POST /execute — the new orchestrator entry (M8).

Workgraph's AGENT_TASK executor calls this. We:
  1. Compose the prompt (call prompt-composer with previewOnly=true)
  2. Enrich with conversation history + rolling summary + relevant memory
  3. Resolve the per-capability MCP server (via IAM through /internal/mcp/servers)
  4. Discover available tools (call tool-service /tools/discover)
  5. Invoke MCP /mcp/invoke — runs the LLM↔tool loop, returns final answer
  6. Persist: assistant turn → memory; rolling summary update; metrics; CallLog
  7. Return unified response with all correlation IDs

If composer or memory aren't reachable we fail soft and continue with a
minimal prompt; if MCP isn't reachable we surface FAILED with the cf_call_id
already persisted so workgraph can show a real audit row.
"""
from __future__ import annotations

import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import asyncio
import json

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import call_log, events_store
from .audit_gov_emit import emit_audit_event
from .config import settings
from .iam_service_token import get_iam_service_token


router = APIRouter()


async def _drain_mcp_events(
    mcp_base_url: str, mcp_bearer: str, trace_id: str,
) -> int:
    """Pull events for this trace from the MCP server's ring and persist to
    our events_store. Best-effort: failures here don't fail the /execute
    response (the call already succeeded by the time we drain)."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{mcp_base_url.rstrip('/')}/mcp/events",
                params={"trace_id": trace_id, "limit": 1000},
                headers={"Authorization": f"Bearer {mcp_bearer}"},
            )
            resp.raise_for_status()
            payload = resp.json()
        items = (payload.get("data") or {}).get("items") or []
        if not items:
            return 0
        # MCP returns reverse-chrono; we want chronological for the store
        items_chrono = list(reversed(items))
        return events_store.upsert_many(items_chrono)
    except Exception:
        return 0


async def _live_subscribe(
    mcp_base_url: str, mcp_bearer: str, trace_id: str, stop_event: asyncio.Event,
) -> int:
    """Open a WS to MCP, subscribe to this trace, persist events as they
    arrive — until /mcp/invoke returns and stop_event is set.

    Best-effort. If the WS fails (no library, MCP doesn't speak WS, network
    blip), the post-invoke HTTP drain still picks up everything from the
    MCP ring. Returns the count of live-persisted events."""
    import websockets  # imported lazily so absence doesn't break imports

    persisted = 0
    # http(s):// → ws(s):// (preserve port + path = /mcp/ws)
    ws_url = mcp_base_url.rstrip("/")
    if ws_url.startswith("https://"):
        ws_url = "wss://" + ws_url[len("https://"):]
    elif ws_url.startswith("http://"):
        ws_url = "ws://" + ws_url[len("http://"):]
    ws_url += "/mcp/ws"

    try:
        # Some clients send Authorization on handshake; the MCP also accepts
        # the subprotocol form which is the only option from a browser.
        async with websockets.connect(
            ws_url,
            subprotocols=[f"bearer.{mcp_bearer}"],
            additional_headers={"Authorization": f"Bearer {mcp_bearer}"},
            close_timeout=2.0,
        ) as ws:
            await ws.send(json.dumps({
                "type": "subscribe.events",
                "filter": {"trace_id": trace_id},
            }))
            while not stop_event.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                except Exception:
                    break
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if msg.get("type") == "event":
                    ev = msg.get("event")
                    if ev:
                        events_store.upsert_many([ev])
                        persisted += 1
    except Exception:
        # Subscriber failed; the post-invoke drain will fill in the gaps.
        pass
    return persisted


# ── Request/Response models ───────────────────────────────────────────────

class RunContext(BaseModel):
    workflow_instance_id: Optional[str] = None
    workflow_node_id: Optional[str] = None
    agent_run_id: Optional[str] = None
    capability_id: Optional[str] = None
    tenant_id: Optional[str] = None
    agent_template_id: Optional[str] = None
    user_id: Optional[str] = None
    trace_id: Optional[str] = None
    branch_base: Optional[str] = None
    branch_name: Optional[str] = None


class ExecuteRequest(BaseModel):
    trace_id: Optional[str] = None
    idempotency_key: Optional[str] = None
    run_context: RunContext = Field(default_factory=RunContext)
    task: str
    system_prompt: Optional[str] = None
    vars: dict[str, Any] = Field(default_factory=dict)
    globals: dict[str, Any] = Field(default_factory=dict)
    prior_outputs: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    overrides: dict[str, Any] = Field(default_factory=dict)
    model_overrides: dict[str, Any] = Field(default_factory=dict)
    context_policy: dict[str, Any] = Field(default_factory=dict)
    limits: dict[str, Any] = Field(default_factory=dict)
    preview_only: bool = False
    # M26 — route the /mcp/invoke to the user's laptop-resident mcp-server via
    # the WebSocket bridge instead of the shared HTTP mcp-server. Requires
    # run_context.user_id. Fails fast with MCP_NOT_CONNECTED if no live
    # laptop. When None, the bridge is used opportunistically (auto-prefer
    # if a connection exists for the user).
    prefer_laptop: Optional[bool] = None


# ── HTTP helpers ──────────────────────────────────────────────────────────

async def _post(url: str, payload: dict, timeout: float = 60.0,
                headers: Optional[dict] = None) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        return resp.json()


async def _get(url: str, params: Optional[dict] = None, timeout: float = 30.0,
               headers: Optional[dict] = None) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, params=params, headers=headers)
        resp.raise_for_status()
        return resp.json()

def _int_limit(obj: dict[str, Any], *keys: str, default: Optional[int] = None) -> Optional[int]:
    for key in keys:
        value = obj.get(key)
        if isinstance(value, int) and value > 0:
            return value
        if isinstance(value, float) and value > 0:
            return int(value)
    return default


def _str_value(obj: dict[str, Any], *keys: str, default: Optional[str] = None) -> Optional[str]:
    for key in keys:
        value = obj.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return default


def _trim_text(text: str, max_chars: Optional[int]) -> str:
    if not max_chars or len(text) <= max_chars:
        return text
    return text[: max(0, max_chars - 80)].rstrip() + f"\n...[trimmed to {max_chars} chars by token budget]"


def _usage_metadata(
    *,
    tokens_used: dict[str, Any],
    model_overrides: dict[str, Any],
    prompt_assembly_id: Optional[str],
    cf_call_id: str,
    optimization_metrics: Optional[dict[str, Any]] = None,
    actual_model_usage: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    input_tokens = tokens_used.get("input")
    output_tokens = tokens_used.get("output")
    total_tokens = tokens_used.get("total")
    actual_model_usage = actual_model_usage or {}
    model_alias = _str_value(model_overrides, "modelAlias", "model_alias") or _str_value(actual_model_usage, "modelAlias", "model_alias")
    provider = _str_value(model_overrides, "provider") or _str_value(actual_model_usage, "provider", default="mcp-default")
    model = _str_value(model_overrides, "model") or _str_value(actual_model_usage, "model", default="mcp-default")
    estimated_cost = tokens_used.get("estimatedCost") or tokens_used.get("estimated_cost")
    tokens_saved = None
    if isinstance(optimization_metrics, dict):
        tokens_saved = optimization_metrics.get("tokens_saved") or optimization_metrics.get("tokensSaved")
    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": total_tokens,
        "estimatedCost": estimated_cost,
        "modelAlias": model_alias,
        "provider": provider,
        "model": model,
        "tokensSaved": tokens_saved,
        "promptAssemblyId": prompt_assembly_id,
        "cfCallId": cf_call_id,
    }


def _composer_context_policy(policy: dict[str, Any], limits: dict[str, Any]) -> dict[str, Any]:
    input_budget = _int_limit(limits, "inputTokenBudget", "input_token_budget")
    max_context = _int_limit(policy, "maxContextTokens", "max_context_tokens", default=input_budget or 8_000)
    if input_budget:
        max_context = min(max_context or input_budget, input_budget)
    out = {
        "optimizationMode": _str_value(policy, "optimizationMode", "optimization_mode", default="medium"),
        "maxContextTokens": max_context,
        "compareWithRaw": bool(policy.get("compareWithRaw", policy.get("compare_with_raw", False))),
    }
    for snake, camel in [
        ("knowledge_top_k", "knowledgeTopK"),
        ("memory_top_k", "memoryTopK"),
        ("code_top_k", "codeTopK"),
        ("max_layer_chars", "maxLayerChars"),
        ("max_prompt_chars", "maxPromptChars"),
    ]:
        value = _int_limit(policy, camel, snake)
        if value is not None:
            out[camel] = value
    return out


async def _compile_execute_context(
    session_id: str,
    agent_id: Optional[str],
    user_message: str,
    system_prompt: Optional[str],
    context_policy: dict[str, Any],
    model_overrides: dict[str, Any],
    limits: dict[str, Any],
) -> tuple[list[dict], str, Optional[str], dict[str, Any], list[str]]:
    """Return MCP history/message/systemPrompt from context-memory compile.

    The MCP invoke endpoint appends `message` after `history`, so we pass all
    compiled messages except the final user message as history. The compiled
    system prompt stays inside history; `systemPrompt` is set to None to avoid
    duplicating the assembled prompt.
    """
    max_chars = _int_limit(limits, "maxPromptChars", "max_prompt_chars")
    input_budget = _int_limit(limits, "inputTokenBudget", "input_token_budget")
    max_context = _int_limit(context_policy, "maxContextTokens", "max_context_tokens", default=input_budget or 8_000)
    if input_budget:
        max_context = min(max_context or input_budget, input_budget)

    payload = {
        "session_id": session_id,
        "agent_id": agent_id,
        "user_message": user_message,
        "optimization_mode": _str_value(context_policy, "optimizationMode", "optimization_mode", default="medium"),
        "compare_with_raw": bool(context_policy.get("compareWithRaw", context_policy.get("compare_with_raw", False))),
        "max_context_tokens": max_context,
        "provider": _str_value(model_overrides, "provider", default="mock"),
        "model": _str_value(model_overrides, "model", default="mock-fast"),
        "system_prompt": _trim_text(system_prompt or "", max_chars) if system_prompt else None,
    }
    compiled = await _post(
        f"{settings.context_memory_url.rstrip('/')}/context/compile",
        payload,
        timeout=20.0,
    )
    messages = [
        {"role": m.get("role"), "content": _trim_text(str(m.get("content") or ""), max_chars)}
        for m in compiled.get("messages", [])
        if m.get("role") in ("system", "user", "assistant", "tool")
    ]
    max_history = _int_limit(limits, "maxHistoryMessages", "max_history_messages")
    if max_history:
        system_messages = [m for m in messages if m["role"] == "system"]
        other_messages = [m for m in messages if m["role"] != "system"]
        if len(other_messages) > max_history:
            messages = system_messages + other_messages[-max_history:]
    if not messages:
        return [], _trim_text(user_message, max_chars), system_prompt, {}, ["context compiler returned no messages"]
    last = messages[-1]
    if last["role"] == "user":
        return messages[:-1], last["content"], None, compiled.get("optimization") or {}, []
    return messages, _trim_text(user_message, max_chars), None, compiled.get("optimization") or {}, []


# ── Orchestrator ──────────────────────────────────────────────────────────

@router.post("/execute")
async def execute(req: ExecuteRequest):
    cf_call_id = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc).isoformat()
    trace_id = req.trace_id or req.run_context.trace_id or str(uuid.uuid4())
    session_id = (
        f"wf:{req.run_context.workflow_instance_id}:{req.run_context.workflow_node_id}"
        if req.run_context.workflow_instance_id and req.run_context.workflow_node_id
        else f"cf:{cf_call_id}"
    )

    # ── 1. Compose the prompt (preview mode → just assembled prompt) ────
    prompt_assembly_id: Optional[str] = None
    system_prompt: Optional[str] = req.system_prompt
    user_message = req.task
    composer_warnings: list[str] = []
    composer_budget_warnings: list[str] = []
    composer_retrieval_stats: dict[str, Any] = {}
    composer_estimated_input_tokens: Optional[int] = None

    if req.run_context.agent_template_id:
        try:
            compose_payload = {
                "agentTemplateId": req.run_context.agent_template_id,
                "capabilityId": req.run_context.capability_id,
                "task": req.task,
                "workflowContext": {
                    "instanceId": req.run_context.workflow_instance_id or session_id,
                    "nodeId": req.run_context.workflow_node_id or "single-shot",
                    "vars": req.vars,
                    "globals": req.globals,
                    "priorOutputs": req.prior_outputs,
                },
                "artifacts": req.artifacts,
                "overrides": req.overrides,
                "modelOverrides": req.model_overrides,
                "contextPolicy": _composer_context_policy(req.context_policy, req.limits),
                "previewOnly": True,
            }
            composed = await _post(
                f"{settings.composer_url.rstrip('/')}/api/v1/compose-and-respond",
                compose_payload,
                timeout=60.0,
            )
            data = composed.get("data") or composed
            prompt_assembly_id = data.get("promptAssemblyId")
            assembled = data.get("assembled") or {}
            system_prompt = assembled.get("systemPrompt")
            user_message = assembled.get("message") or req.task
            composer_warnings = data.get("warnings") or []
            composer_budget_warnings = data.get("budgetWarnings") or []
            composer_retrieval_stats = data.get("retrievalStats") or {}
            raw_estimated_tokens = data.get("estimatedInputTokens")
            if isinstance(raw_estimated_tokens, int):
                composer_estimated_input_tokens = raw_estimated_tokens
        except Exception as exc:
            composer_warnings.append(f"composer unreachable: {exc!s}")

    # ── 2. Enrich: conversation history + rolling summary ───────────────
    history: list[dict] = []
    mcp_message = user_message
    compiled_system_prompt = system_prompt
    optimization_metrics: dict[str, Any] = {}
    try:
        history, mcp_message, compiled_system_prompt, optimization_metrics, compile_warnings = await _compile_execute_context(
            session_id=session_id,
            agent_id=req.run_context.agent_template_id,
            user_message=user_message,
            system_prompt=system_prompt,
            context_policy=req.context_policy,
            model_overrides=req.model_overrides,
            limits=req.limits,
        )
        composer_warnings.extend(compile_warnings)
    except Exception as exc:
        composer_warnings.append(f"context compiler unavailable: {exc!s}")
    if not history and mcp_message == user_message:
        try:
            max_history = _int_limit(req.limits, "maxHistoryMessages", "max_history_messages", default=6) or 6
            msgs = await _get(
                f"{settings.context_memory_url.rstrip('/')}/memory/messages/{session_id}",
                params={"limit": max_history},
                timeout=10.0,
            )
            history = [
                {"role": m["role"], "content": m["content"]}
                for m in msgs.get("messages", [])
                if m.get("role") in ("user", "assistant", "tool")
            ]
            compiled_system_prompt = system_prompt
        except Exception:
            pass  # fresh session; ignore

    # ── 3. Resolve MCP server for this capability ───────────────────────
    if not req.run_context.capability_id:
        raise HTTPException(status_code=400, detail="run_context.capability_id is required")
    if settings.require_tenant_id and not req.run_context.tenant_id:
        raise HTTPException(status_code=400, detail="run_context.tenant_id is required when REQUIRE_TENANT_ID=true")

    try:
        servers_resp = await _get(
            f"{settings.iam_base_url.rstrip('/')}/capabilities/{req.run_context.capability_id}/mcp-servers",
            params={"status": "active"},
            headers={"Authorization": f"Bearer {await get_iam_service_token() or ''}"},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        _persist_failure(cf_call_id, started_at, trace_id, req, prompt_assembly_id,
                         f"IAM unreachable while resolving MCP servers: {exc!s}", session_id)
        raise HTTPException(status_code=502, detail=f"IAM unreachable: {exc!s}")

    servers = servers_resp if isinstance(servers_resp, list) else servers_resp.get("servers", [])
    if not servers:
        _persist_failure(cf_call_id, started_at, trace_id, req, prompt_assembly_id,
                         f"no active MCP server registered for capability {req.run_context.capability_id}",
                         session_id)
        raise HTTPException(status_code=409, detail="no active MCP server for this capability")

    chosen = servers[0]  # v0: just pick the first; v1 can do health/affinity scoring
    mcp_server_id = chosen["id"]
    # `chosen` from /capabilities/{id}/mcp-servers is the redacted shape (no bearer).
    # Fetch the full record (incl bearer) via the per-id endpoint.
    full = await _get(
        f"{settings.iam_base_url.rstrip('/')}/mcp-servers/{mcp_server_id}",
        headers={"Authorization": f"Bearer {await get_iam_service_token() or ''}"},
        timeout=10.0,
    )
    mcp_base_url = full["base_url"].rstrip("/")
    mcp_bearer = full["bearer_token"]

    # ── 4. Tool discovery ───────────────────────────────────────────────
    tools_for_mcp: list[dict] = []
    try:
        discover = await _post(
            f"{settings.tool_service_url.rstrip('/')}/api/v1/tools/discover",
            {
                "capability_id": req.run_context.capability_id,
                "agent_uid": req.run_context.agent_template_id or "default-agent",
                "query": req.task,
                "risk_max": "high",
                "limit": 8,
            },
            timeout=10.0,
        )
        for t in discover.get("tools", []):
            tools_for_mcp.append({
                "name": t.get("tool_name") or t.get("name"),
                "description": t.get("description", ""),
                "input_schema": t.get("input_schema") or {"type": "object"},
                "execution_target": (t.get("execution_target") or "LOCAL").upper(),
                "requires_approval": bool(t.get("requires_approval", False)),
                "risk_level": (t.get("risk_level") or "low").upper(),
            })
    except Exception:
        pass  # tool discovery is optional; MCP may have its own local registry

    # ── 5. Invoke the MCP server ────────────────────────────────────────
    # MCP-server uses Zod with `.optional()` which accepts undefined but
    # NOT null. Strip Nones so the JSON has no null fields.
    def _strip_nones(d: dict) -> dict:
        return {k: v for k, v in d.items() if v is not None}

    invoke_payload: dict[str, Any] = {
        "history": history,
        "message": mcp_message,
        "tools": tools_for_mcp,
        "modelConfig": _strip_nones({
            "modelAlias": req.model_overrides.get("modelAlias") or req.model_overrides.get("model_alias"),
            "provider": req.model_overrides.get("provider"),
            "model": req.model_overrides.get("model"),
            "temperature": req.model_overrides.get("temperature"),
            "maxTokens": (
                req.model_overrides.get("maxOutputTokens")
                or req.model_overrides.get("max_output_tokens")
                or req.limits.get("outputTokenBudget")
                or req.limits.get("output_token_budget")
            ),
        }),
        "runContext": _strip_nones({
            "sessionId": session_id,
            "capabilityId": req.run_context.capability_id,
            "tenantId": req.run_context.tenant_id,
            "agentId": req.run_context.agent_template_id,
            "runId": req.run_context.workflow_instance_id,
            "runStepId": req.run_context.workflow_node_id,
            "workflowInstanceId": req.run_context.workflow_instance_id,
            "nodeId": req.run_context.workflow_node_id,
            "workItemId": req.run_context.agent_run_id,
            "branchBase": req.run_context.branch_base,
            "branchName": req.run_context.branch_name,
            "traceId": trace_id,
        }),
        "limits": _strip_nones({
            "maxSteps": req.limits.get("maxSteps") or req.limits.get("max_steps") or 3,
            "timeoutSec": req.limits.get("timeoutSec") or req.limits.get("timeout_sec") or 240,
            "maxToolResultChars": req.limits.get("maxToolResultChars") or req.limits.get("max_tool_result_chars"),
        }),
    }
    if compiled_system_prompt is not None:
        invoke_payload["systemPrompt"] = compiled_system_prompt
    # Start the live subscriber BEFORE invoking, so events are persisted
    # as they happen (M9.y). The post-invoke HTTP drain (step 7) acts as a
    # safety net for anything the WS missed (race at the tail end).
    stop_subscriber = asyncio.Event()
    subscriber_task = asyncio.create_task(
        _live_subscribe(mcp_base_url, mcp_bearer, trace_id, stop_subscriber)
    )

    # ── M26 — laptop-bridge dispatch ───────────────────────────────────────
    # When a laptop mcp-server is connected for run_context.user_id, route
    # the invoke through the WebSocket bridge instead of the shared HTTP
    # mcp-server. Behaviour:
    #   • req.prefer_laptop == True  → require laptop, fail with MCP_NOT_CONNECTED
    #   • req.prefer_laptop == False → never use laptop (force HTTP path)
    #   • req.prefer_laptop is None  → auto-prefer laptop when one is connected
    user_id = req.run_context.user_id
    use_laptop = False
    laptop_device_id: Optional[str] = None
    laptop_device_name: Optional[str] = None
    if user_id and req.prefer_laptop is not False:
        from .laptop_registry import REGISTRY as _LAPTOP_REGISTRY
        conn = await _LAPTOP_REGISTRY.any_for_user(user_id)
        if conn is not None:
            use_laptop = True
            laptop_device_id = conn.device_id
            laptop_device_name = conn.device_name
        elif req.prefer_laptop is True:
            # Required but missing — fail fast (decision #2).
            _persist_failure(cf_call_id, started_at, trace_id, req, prompt_assembly_id,
                             "MCP_NOT_CONNECTED: laptop mcp-server is not online for this user",
                             session_id, mcp_server_id=mcp_server_id)
            raise HTTPException(status_code=503, detail={
                "code": "MCP_NOT_CONNECTED",
                "message": "Your laptop mcp-server is not connected. Run `singularity-mcp start` and retry.",
                "user_id": user_id,
            })

    # M26 — emit a per-invoke event tying this run to the specific laptop
    # device. Workgraph Run Insights buckets these by trace_id to render the
    # "🖥 served by your laptop" badge with the device name.
    if use_laptop and laptop_device_id:
        emit_audit_event(
            kind="cf.invoke.via_laptop",
            trace_id=trace_id,
            subject_type="LaptopDevice",
            subject_id=laptop_device_id,
            actor_id=user_id,
            capability_id=req.run_context.capability_id,
            severity="info",
            payload={
                "user_id":      user_id,
                "device_id":    laptop_device_id,
                "device_name":  laptop_device_name,
                "workflow_instance_id": req.run_context.workflow_instance_id,
                "workflow_node_id":     req.run_context.workflow_node_id,
            },
        )

    try:
        mcp_started = time.time()
        if use_laptop:
            from .laptop_registry import REGISTRY as _LAPTOP_REGISTRY, LaptopInvokeError, LaptopInvokeTimeout
            try:
                mcp_data = await _LAPTOP_REGISTRY.invoke(
                    user_id=user_id,  # type: ignore[arg-type]
                    payload=invoke_payload,
                    timeout=float(req.limits.get("timeoutSec", 240)),
                )
                # Wrap in mcp-server's standard envelope so downstream code
                # treats this identically to an HTTP response.
                mcp_resp = {"success": True, "data": mcp_data}
            except LaptopInvokeTimeout as t_exc:
                raise HTTPException(status_code=504, detail={
                    "code": "MCP_LAPTOP_TIMEOUT", "message": str(t_exc),
                })
            except LaptopInvokeError as l_exc:
                raise HTTPException(status_code=502, detail={
                    "code": l_exc.code, "message": l_exc.message,
                    "details": l_exc.details,
                })
        else:
            mcp_resp = await _post(
                f"{mcp_base_url}/mcp/invoke",
                invoke_payload,
                timeout=float(req.limits.get("timeoutSec", 240)),
                headers={"Authorization": f"Bearer {mcp_bearer}"},
            )
        mcp_latency_ms = int((time.time() - mcp_started) * 1000)
    except HTTPException:
        # Stop the live subscriber and clean up before bubbling the structured
        # error up to the caller (don't masquerade as a 502 below).
        stop_subscriber.set()
        try:
            await asyncio.wait_for(subscriber_task, timeout=1.0)
        except Exception:
            pass
        raise
    except httpx.HTTPStatusError as exc:
        stop_subscriber.set()
        try:
            await asyncio.wait_for(subscriber_task, timeout=1.0)
        except Exception:
            pass
        try:
            detail = exc.response.json()
        except Exception:
            detail = {"message": exc.response.text[:500]}
        _persist_failure(cf_call_id, started_at, trace_id, req, prompt_assembly_id,
                         f"MCP invoke failed: {detail}", session_id, mcp_server_id=mcp_server_id)
        raise HTTPException(status_code=exc.response.status_code, detail={
            "code": "MCP_INVOKE_FAILED",
            "message": "MCP invoke failed",
            "details": detail,
        })
    except Exception as exc:
        # Stop the subscriber and discard its result; failure path goes to drain.
        stop_subscriber.set()
        try:
            await asyncio.wait_for(subscriber_task, timeout=1.0)
        except Exception:
            pass
        _persist_failure(cf_call_id, started_at, trace_id, req, prompt_assembly_id,
                         f"MCP invoke failed: {exc!s}", session_id, mcp_server_id=mcp_server_id)
        raise HTTPException(status_code=502, detail=f"MCP invoke failed: {exc!s}")

    # Give the subscriber up to 500ms to drain trailing events that may
    # arrive AFTER /mcp/invoke returns (the run.event marker often lands
    # microseconds after the HTTP response goes out).
    await asyncio.sleep(0.5)
    stop_subscriber.set()
    live_persisted = 0
    try:
        live_persisted = await asyncio.wait_for(subscriber_task, timeout=2.0)
    except Exception:
        pass

    mcp_data = mcp_resp.get("data") or {}
    final_response = mcp_data.get("finalResponse", "")
    correlation = mcp_data.get("correlation") or {}
    workspace = mcp_data.get("workspace") or {}
    tokens_used = mcp_data.get("tokensUsed") or {}
    actual_model_usage = mcp_data.get("modelUsage") or {}
    finish_reason = mcp_data.get("finishReason")
    steps_taken = mcp_data.get("stepsTaken")
    status = mcp_data.get("status", "UNKNOWN")
    pending_approval = mcp_data.get("pendingApproval")  # M9.z — present when MCP paused

    # ── 6. Persist memory turn + summary + metrics ──────────────────────
    try:
        await _post(
            f"{settings.context_memory_url.rstrip('/')}/memory/messages",
            {
                "session_id": session_id,
                "agent_id": req.run_context.agent_template_id,
                "role": "user",
                "content": req.task,
            },
            timeout=10.0,
        )
        if final_response:
            await _post(
                f"{settings.context_memory_url.rstrip('/')}/memory/messages",
                {
                    "session_id": session_id,
                    "agent_id": req.run_context.agent_template_id,
                    "role": "assistant",
                    "content": final_response,
                },
                timeout=10.0,
            )
    except Exception:
        pass  # best-effort

    # ── 7. Drain MCP events for this trace (M9.x safety net for the
    #       live WS subscriber from M9.y; idempotent on event id) ──────
    drained = await _drain_mcp_events(mcp_base_url, mcp_bearer, trace_id)

    # ── 8. CallLog row ──────────────────────────────────────────────────
    completed_at = datetime.now(timezone.utc).isoformat()
    is_paused = status == "WAITING_APPROVAL"
    call_log.insert({
        "id": cf_call_id,
        "trace_id": trace_id,
        "workflow_run_id": req.run_context.workflow_instance_id,
        "workflow_node_id": req.run_context.workflow_node_id,
        "agent_run_id": req.run_context.agent_run_id,
        "capability_id": req.run_context.capability_id,
        "tenant_id": req.run_context.tenant_id,
        "agent_template_id": req.run_context.agent_template_id,
        "session_id": session_id,
        "prompt_assembly_id": prompt_assembly_id,
        "mcp_server_id": mcp_server_id,
        "mcp_invocation_id": correlation.get("mcpInvocationId"),
        "llm_call_ids": correlation.get("llmCallIds") or [],
        "tool_invocation_ids": correlation.get("toolInvocationIds") or [],
        "artifact_ids": correlation.get("artifactIds") or [],
        "code_change_ids": correlation.get("codeChangeIds") or [],
        "status": status,
        "finish_reason": finish_reason,
        "final_response": final_response,
        "steps_taken": steps_taken,
        "input_tokens": tokens_used.get("input"),
        "output_tokens": tokens_used.get("output"),
        "total_tokens": tokens_used.get("total"),
        "estimated_cost": None,  # M8.x: derive from llm-gateway records
        "started_at": started_at,
        # WAITING_APPROVAL means the run is paused — completed_at stays NULL
        # until /execute/resume finishes it.
        "completed_at": None if is_paused else completed_at,
        "continuation_token": (pending_approval or {}).get("continuation_token"),
        "pending_tool_name": (pending_approval or {}).get("tool_name"),
        "pending_tool_args": (pending_approval or {}).get("tool_args"),
    })

    # M22 — central audit-governance ledger (fire-and-forget). One event per
    # /execute completion with the full correlation tail.
    emit_audit_event(
        kind="cf.execute.completed",
        trace_id=trace_id,
        subject_type="CfCallLog",
        subject_id=cf_call_id,
        capability_id=req.run_context.capability_id,
        severity="warn" if status == "FAILED" else "info",
        payload={
            "status": status,
            "finish_reason": finish_reason,
            "steps_taken": steps_taken,
            "input_tokens": tokens_used.get("input"),
            "output_tokens": tokens_used.get("output"),
            "total_tokens": tokens_used.get("total"),
            "estimated_cost": tokens_used.get("estimatedCost") or tokens_used.get("estimated_cost"),
            "model_alias": _str_value(req.model_overrides, "modelAlias", "model_alias") or _str_value(actual_model_usage, "modelAlias", "model_alias"),
            "provider": _str_value(req.model_overrides, "provider") or _str_value(actual_model_usage, "provider", default="mcp-default"),
            "model": _str_value(req.model_overrides, "model") or _str_value(actual_model_usage, "model", default="mcp-default"),
            "tokens_saved": optimization_metrics.get("tokens_saved") or optimization_metrics.get("tokensSaved"),
            "prompt_budget_warnings": composer_budget_warnings,
            "prompt_retrieval_stats": composer_retrieval_stats,
            "prompt_estimated_input_tokens": composer_estimated_input_tokens,
            "mcp_latency_ms": mcp_latency_ms,
            "agent_run_id": req.run_context.agent_run_id,
            "workflow_instance_id": req.run_context.workflow_instance_id,
        },
    )
    usage = _usage_metadata(
        tokens_used=tokens_used,
        model_overrides=req.model_overrides,
        actual_model_usage=actual_model_usage,
        prompt_assembly_id=prompt_assembly_id,
        cf_call_id=cf_call_id,
        optimization_metrics=optimization_metrics,
    )

    return {
        "status": status,
        "finalResponse": final_response,
        "correlation": {
            "cfCallId": cf_call_id,
            "traceId": trace_id,
            "sessionId": session_id,
            "promptAssemblyId": prompt_assembly_id,
            "mcpServerId": mcp_server_id,
            "mcpInvocationId": correlation.get("mcpInvocationId"),
            "modelAlias": usage["modelAlias"],
            "llmCallIds": correlation.get("llmCallIds") or [],
            "toolInvocationIds": correlation.get("toolInvocationIds") or [],
            "artifactIds": correlation.get("artifactIds") or [],
            "codeChangeIds": correlation.get("codeChangeIds") or [],
            "workspaceBranch": workspace.get("workspaceBranch"),
            "workspaceCommitSha": workspace.get("workspaceCommitSha"),
            "changedPaths": workspace.get("changedPaths") or [],
            "astIndexStatus": workspace.get("astIndexStatus"),
            "astIndexedFiles": workspace.get("astIndexedFiles"),
            "astIndexedSymbols": workspace.get("astIndexedSymbols"),
        },
        "workspace": workspace,
        "tokensUsed": tokens_used,
        "usage": usage,
        "modelUsage": {
            "modelAlias": usage["modelAlias"],
            "provider": usage["provider"],
            "model": usage["model"],
            "inputTokens": usage["inputTokens"],
            "outputTokens": usage["outputTokens"],
            "totalTokens": usage["totalTokens"],
            "estimatedCost": usage["estimatedCost"],
        },
        "prompt": {
            "estimatedInputTokens": composer_estimated_input_tokens,
            "budgetWarnings": composer_budget_warnings,
            "retrievalStats": composer_retrieval_stats,
        },
        "finishReason": finish_reason,
        "stepsTaken": steps_taken,
        "metrics": {
            "mcpLatencyMs": mcp_latency_ms,
            "eventsPersistedLive": live_persisted,
            "eventsPersistedFinalDrain": drained,
            "contextOptimization": optimization_metrics,
        },
        "warnings": composer_warnings,
        # M9.z — present when status == WAITING_APPROVAL
        "pendingApproval": pending_approval,
    }


def _persist_failure(
    cf_call_id: str, started_at: str, trace_id: str, req: ExecuteRequest,
    prompt_assembly_id: Optional[str], error: str, session_id: str,
    mcp_server_id: Optional[str] = None,
):
    """Best-effort durable record of a failed execute call so workgraph has audit."""
    try:
        call_log.insert({
            "id": cf_call_id,
            "trace_id": trace_id,
            "workflow_run_id": req.run_context.workflow_instance_id,
            "workflow_node_id": req.run_context.workflow_node_id,
            "agent_run_id": req.run_context.agent_run_id,
            "capability_id": req.run_context.capability_id,
            "tenant_id": req.run_context.tenant_id,
            "agent_template_id": req.run_context.agent_template_id,
            "session_id": session_id,
            "prompt_assembly_id": prompt_assembly_id,
            "mcp_server_id": mcp_server_id,
            "status": "FAILED",
            "error": error[:1000],
            "started_at": started_at,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception:
        pass


# ── CallLog read endpoints ────────────────────────────────────────────────

@router.get("/execute/calls/{call_id}")
async def get_call(call_id: str):
    rec = call_log.get_by_id(call_id)
    if not rec:
        raise HTTPException(status_code=404, detail="call not found")
    return rec


@router.get("/execute/calls")
async def list_calls(trace_id: Optional[str] = None,
                     workflow_run_id: Optional[str] = None,
                     tenant_id: Optional[str] = None,
                     limit: int = 50):
    if trace_id:
        return {"items": call_log.list_by_trace(trace_id, limit)}
    if workflow_run_id:
        return {"items": call_log.list_by_workflow(workflow_run_id, limit, tenant_id=tenant_id)}
    return {"items": call_log.list_recent(limit)}


# ── Persisted MCP events (M9.x) ────────────────────────────────────────────
#
# Drained from each tenant's MCP server at the end of /execute (best-effort).
# Outlives the MCP ring buffer so post-mortem audit + UI replay work after
# the customer's MCP container has restarted.

@router.get("/execute/events")
async def list_events(
    trace_id: Optional[str] = None,
    run_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
    since_id: Optional[str] = None,
    since_timestamp: Optional[str] = None,
    limit: int = 500,
):
    """List persisted MCP events.

    One of `trace_id` or `run_id` must be provided. `since_id` /
    `since_timestamp` give incremental polling: callers pass the most-recent
    id/timestamp they've seen and receive newer rows only.
    """
    if not trace_id and not run_id:
        raise HTTPException(status_code=400, detail="trace_id or run_id is required")
    if trace_id:
        items = events_store.list_by_trace(trace_id, since_id=since_id,
                                           since_timestamp=since_timestamp, limit=limit,
                                           tenant_id=tenant_id)
    else:
        items = events_store.list_by_run(run_id, limit=limit, tenant_id=tenant_id)
    return {
        "trace_id": trace_id,
        "run_id": run_id,
        "tenant_id": tenant_id,
        "count": len(items),
        "events": items,
        "tail_id": items[-1]["id"] if items else None,
        "tail_timestamp": items[-1]["timestamp"] if items else None,
    }


# NOTE: order matters — /events/stream MUST be declared before
# /events/{event_id}, otherwise FastAPI matches "stream" as an event_id
# parameter and 404s every SSE request.
@router.get("/execute/events/stream")
async def stream_events(
    trace_id: str,
    tenant_id: Optional[str] = None,
    since_id: Optional[str] = None,
    poll_interval_ms: int = 800,
    max_idle_seconds: int = 60,
):
    """Server-Sent Events stream — long-poll the events table for `trace_id`.

    Sends:
      - one `event:` per new row (data is JSON envelope)
      - heartbeat comment every poll_interval to keep proxies open
      - final `event: done` after `max_idle_seconds` of no new events
    """
    poll_interval = max(0.1, poll_interval_ms / 1000.0)

    async def gen():
        cursor_id = since_id
        idle_since = time.time()
        # First flush: anything already there for this trace.
        try:
            initial = events_store.list_by_trace(trace_id, since_id=cursor_id, limit=1000, tenant_id=tenant_id)
        except Exception:
            initial = []
        for ev in initial:
            cursor_id = ev["id"]
            idle_since = time.time()
            yield f"data: {json.dumps(ev)}\n\n"

        # Long-poll loop.
        while True:
            await asyncio.sleep(poll_interval)
            try:
                new_rows = events_store.list_by_trace(
                    trace_id, since_id=cursor_id, limit=200, tenant_id=tenant_id,
                )
            except Exception:
                yield ": db-error\n\n"
                continue
            if new_rows:
                idle_since = time.time()
                for ev in new_rows:
                    cursor_id = ev["id"]
                    yield f"data: {json.dumps(ev)}\n\n"
            else:
                # Heartbeat keeps the connection alive through proxies.
                yield ": heartbeat\n\n"
                if time.time() - idle_since > max_idle_seconds:
                    yield "event: done\ndata: {\"reason\": \"idle\"}\n\n"
                    return

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.get("/execute/events/{event_id}")
async def get_event(event_id: str):
    rec = events_store.get_by_id(event_id)
    if not rec:
        raise HTTPException(status_code=404, detail="event not found")
    return rec


@router.post("/execute/calls/{call_id}/refresh-events")
async def refresh_events_for_call(call_id: str):
    """Re-drain events from the MCP server for an existing CallLog row.

    Useful when the original drain at /execute time missed events (network
    blip) or when ops wants to back-fill a trace.
    """
    rec = call_log.get_by_id(call_id)
    if not rec:
        raise HTTPException(status_code=404, detail="call not found")
    if not rec.get("mcp_server_id"):
        raise HTTPException(status_code=409, detail="call has no mcp_server_id (failed before MCP)")
    if not rec.get("trace_id"):
        raise HTTPException(status_code=409, detail="call has no trace_id")

    full = await _get(
        f"{settings.iam_base_url.rstrip('/')}/mcp-servers/{rec['mcp_server_id']}",
        headers={"Authorization": f"Bearer {await get_iam_service_token() or ''}"},
    )
    persisted = await _drain_mcp_events(
        full["base_url"].rstrip("/"), full["bearer_token"], rec["trace_id"],
    )
    return {
        "call_id": call_id,
        "trace_id": rec["trace_id"],
        "events_persisted": persisted,
        "events_total": events_store.count_for_trace(rec["trace_id"]),
    }


# ── /execute/resume — operator approves/rejects a paused agent run (M9.z) ──

class ResumeRequest(BaseModel):
    cf_call_id: Optional[str] = None
    continuation_token: Optional[str] = None
    decision: str  # "approved" | "rejected"
    reason: Optional[str] = None
    args_override: Optional[dict[str, Any]] = None


@router.post("/execute/resume")
async def execute_resume(req: ResumeRequest):
    if req.decision not in ("approved", "rejected"):
        raise HTTPException(status_code=400, detail="decision must be 'approved' or 'rejected'")

    # Locate the call_log row either way the operator addresses it.
    rec: Optional[dict] = None
    if req.cf_call_id:
        rec = call_log.get_by_id(req.cf_call_id)
    elif req.continuation_token:
        rec = call_log.get_by_continuation_token(req.continuation_token)
    else:
        raise HTTPException(status_code=400, detail="cf_call_id or continuation_token required")
    if not rec:
        raise HTTPException(status_code=404, detail="call not found")
    if rec.get("status") != "WAITING_APPROVAL":
        raise HTTPException(
            status_code=409,
            detail=f"call is in status {rec.get('status')!r}, not WAITING_APPROVAL",
        )
    cont = rec.get("continuation_token") or req.continuation_token
    if not cont:
        raise HTTPException(status_code=409, detail="call has no continuation_token")

    mcp_server_id = rec.get("mcp_server_id")
    if not mcp_server_id:
        raise HTTPException(status_code=409, detail="call has no mcp_server_id")
    trace_id = rec.get("trace_id")

    # Fetch the MCP credentials from IAM (cached service token).
    full = await _get(
        f"{settings.iam_base_url.rstrip('/')}/mcp-servers/{mcp_server_id}",
        headers={"Authorization": f"Bearer {await get_iam_service_token() or ''}"},
    )
    mcp_base_url = full["base_url"].rstrip("/")
    mcp_bearer = full["bearer_token"]

    # Live subscriber for the resumed loop too — same pattern as /execute.
    stop_subscriber = asyncio.Event()
    subscriber_task = (
        asyncio.create_task(_live_subscribe(mcp_base_url, mcp_bearer, trace_id, stop_subscriber))
        if trace_id else None
    )

    resume_payload = {
        "continuation_token": cont,
        "decision": req.decision,
    }
    if req.reason:
        resume_payload["reason"] = req.reason
    if req.args_override is not None:
        resume_payload["args_override"] = req.args_override  # type: ignore[assignment]

    try:
        mcp_started = time.time()
        mcp_resp = await _post(
            f"{mcp_base_url}/mcp/resume",
            resume_payload,
            timeout=240.0,
            headers={"Authorization": f"Bearer {mcp_bearer}"},
        )
        mcp_latency_ms = int((time.time() - mcp_started) * 1000)
    except Exception as exc:
        if subscriber_task:
            stop_subscriber.set()
            try:
                await asyncio.wait_for(subscriber_task, timeout=1.0)
            except Exception:
                pass
        raise HTTPException(status_code=502, detail=f"MCP resume failed: {exc!s}")

    # Grace + drain.
    await asyncio.sleep(0.5)
    live_persisted = 0
    if subscriber_task:
        stop_subscriber.set()
        try:
            live_persisted = await asyncio.wait_for(subscriber_task, timeout=2.0)
        except Exception:
            pass
    drained = 0
    if trace_id:
        drained = await _drain_mcp_events(mcp_base_url, mcp_bearer, trace_id)

    mcp_data = mcp_resp.get("data") or {}
    new_status = mcp_data.get("status", "UNKNOWN")
    final_response = mcp_data.get("finalResponse", "")
    correlation = mcp_data.get("correlation") or {}
    workspace = mcp_data.get("workspace") or {}
    tokens_used = mcp_data.get("tokensUsed") or {}
    finish_reason = mcp_data.get("finishReason")
    steps_taken = mcp_data.get("stepsTaken")
    new_pending = mcp_data.get("pendingApproval")  # could pause again

    is_still_paused = new_status == "WAITING_APPROVAL"
    completed_at = datetime.now(timezone.utc).isoformat()

    call_log.update_after_resume(rec["id"], {
        "mcp_invocation_id": correlation.get("mcpInvocationId"),
        "llm_call_ids": correlation.get("llmCallIds") or [],
        "tool_invocation_ids": correlation.get("toolInvocationIds") or [],
        "artifact_ids": correlation.get("artifactIds") or [],
        "code_change_ids": correlation.get("codeChangeIds") or [],
        "status": new_status,
        "finish_reason": finish_reason,
        "final_response": final_response,
        "steps_taken": steps_taken,
        "input_tokens": tokens_used.get("input"),
        "output_tokens": tokens_used.get("output"),
        "total_tokens": tokens_used.get("total"),
        "completed_at": None if is_still_paused else completed_at,
        "continuation_token": (new_pending or {}).get("continuation_token"),
        "pending_tool_name": (new_pending or {}).get("tool_name"),
        "pending_tool_args": (new_pending or {}).get("tool_args"),
    })
    usage = _usage_metadata(
        tokens_used=tokens_used,
        model_overrides={},
        prompt_assembly_id=rec.get("prompt_assembly_id"),
        cf_call_id=rec["id"],
        optimization_metrics={},
    )

    return {
        "status": new_status,
        "finalResponse": final_response,
        "decision": req.decision,
        "correlation": {
            "cfCallId": rec["id"],
            "traceId": trace_id,
            "sessionId": rec.get("session_id"),
            "promptAssemblyId": rec.get("prompt_assembly_id"),
            "mcpServerId": mcp_server_id,
            "mcpInvocationId": correlation.get("mcpInvocationId"),
            "llmCallIds": correlation.get("llmCallIds") or [],
            "toolInvocationIds": correlation.get("toolInvocationIds") or [],
            "artifactIds": correlation.get("artifactIds") or [],
            "codeChangeIds": correlation.get("codeChangeIds") or [],
            "workspaceBranch": workspace.get("workspaceBranch"),
            "workspaceCommitSha": workspace.get("workspaceCommitSha"),
            "changedPaths": workspace.get("changedPaths") or [],
            "astIndexStatus": workspace.get("astIndexStatus"),
            "astIndexedFiles": workspace.get("astIndexedFiles"),
            "astIndexedSymbols": workspace.get("astIndexedSymbols"),
        },
        "workspace": workspace,
        "tokensUsed": tokens_used,
        "usage": usage,
        "modelUsage": {
            "provider": usage["provider"],
            "model": usage["model"],
            "inputTokens": usage["inputTokens"],
            "outputTokens": usage["outputTokens"],
            "totalTokens": usage["totalTokens"],
            "estimatedCost": usage["estimatedCost"],
        },
        "finishReason": finish_reason,
        "stepsTaken": steps_taken,
        "metrics": {
            "mcpLatencyMs": mcp_latency_ms,
            "eventsPersistedLive": live_persisted,
            "eventsPersistedFinalDrain": drained,
        },
        "pendingApproval": new_pending,
    }


@router.on_event("startup")
def _on_startup() -> None:
    # Honour DB env vars set by docker-compose; fall back to settings defaults.
    cl_db = os.environ.get("CALL_LOG_DB", settings.call_log_db)
    call_log.DB_PATH = cl_db
    call_log.init_db()

    es_db = os.environ.get("EVENTS_STORE_DB", "/data/call_log_events.db")
    events_store.DB_PATH = es_db
    events_store.init_db()
