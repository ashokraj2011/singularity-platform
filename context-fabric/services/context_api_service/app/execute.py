"""
POST /execute — the new orchestrator entry (M8).

Workgraph's AGENT_TASK executor calls this. We:
  1. Discover available tools once (call tool-service /tools/discover)
  2. Compose the prompt (call prompt-composer with previewOnly=true)
  3. Enrich with conversation history + rolling summary + relevant memory
  4. Resolve the per-capability MCP server (via IAM through /internal/mcp/servers)
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
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import AliasChoices, BaseModel, Field

from . import call_log, events_store
from .audit_gov_emit import emit_audit_event
from .config import is_production_class_env, settings
from .governed import placement as _placement
from .iam_service_token import (
    get_iam_service_token,
    invalidate_iam_service_token,
    configured_tenant_ids_for_service_token,
)
from .response_json import response_json_object

# M73 — refactor target modules. Helpers below are thin re-exports of the
# canonical implementations in execute_modules/. See execute_modules/__init__.py
# for the rationale + the deferred Tier 2 extraction plan.
from .execute_modules import (
    event_collector as _events_mod,
    governance as _gov_mod,
    laptop_dispatcher as _laptop_mod,
    mcp_dispatcher as _mcp_mod,
    memory_context as _memory_mod,
    prompt_context as _prompt_mod,
    response_mapper as _response_mod,
    runtime_resolver as _runtime_mod,
    stage_policy as _stage_mod,
    tool_policy as _tool_mod,
)


# M73 — thin re-exports: the canonical bodies live in execute_modules/*.
# Keeping the underscore-prefixed names here so call sites inside execute()
# continue to read `_governance_mode(...)` etc. without a sweeping rename.
_drain_mcp_events = _events_mod.drain_mcp_events
_live_subscribe = _events_mod.live_subscribe
_governance_mode = _stage_mod.governance_mode
_stage_policy_value = _stage_mod.stage_policy_value
_stage_repo_access = _stage_mod.stage_repo_access
_stage_is_story_only = _stage_mod.stage_is_story_only
_classify_stage_role = _stage_mod.classify_stage_role
_context_plan_status = _prompt_mod.context_plan_status
_context_plan_message = _prompt_mod.context_plan_message
_post = _prompt_mod._post
_build_code_context_package = _prompt_mod.build_code_context_package
_fetch_capability_world_model = _prompt_mod.fetch_capability_world_model
_composer_context_policy = _prompt_mod.composer_context_policy
_compile_execute_context = _prompt_mod.compile_execute_context
_int_limit = _response_mod.int_limit
_str_value = _response_mod.str_value
_trim_text = _response_mod.trim_text
_usage_metadata = _response_mod.usage_metadata
_normalize_tool_for_mcp = _tool_mod.normalize_tool_for_mcp
_local_tool = _tool_mod.local_tool
_mandatory_local_tools_for_request = _tool_mod.mandatory_local_tools_for_request
_merge_mandatory_local_tools = _tool_mod.merge_mandatory_local_tools
_filter_tools_by_effective_capabilities = _tool_mod.filter_tools_by_effective_capabilities
_default_mcp_record = _runtime_mod.default_mcp_record
_resolve_mcp_record = _runtime_mod.resolve_mcp_record
_mcp_record_by_id = _runtime_mod.mcp_record_by_id

router = APIRouter()


def check_execute_service_token(provided: Optional[str]) -> None:
    # SECURITY (review finding 7): enforce a service token whenever this is a
    # production-class env OR tenant isolation is on (REQUIRE_TENANT_ID=true).
    # "Dev" stacks frequently run tenant-isolated on shared hosts, where an
    # unauthenticated /execute lets any reachable caller run context code across
    # tenants. The ALLOW_UNAUTHENTICATED_DEV_EXECUTE escape hatch only relaxes
    # NON-production envs (local single-tenant demos); prod always enforces.
    enforce = is_production_class_env() or settings.require_tenant_id
    if not enforce:
        return
    if settings.allow_unauthenticated_dev_execute and not is_production_class_env():
        return
    expected = settings.iam_service_token
    if not expected:
        raise HTTPException(status_code=503, detail="IAM_SERVICE_TOKEN is not configured on context-fabric")
    if not provided or provided != expected:
        raise HTTPException(status_code=401, detail="invalid service token")


def _check_execute_read_service_token(provided: Optional[str]) -> None:
    check_execute_service_token(provided)


def _resolve_read_tenant_scope(requested_tenant_id: Optional[str]) -> Optional[str]:
    """Tenant filter a read query MUST apply, derived from this service token's
    configured tenant scope (IAM_SERVICE_TOKEN_TENANT_IDS).

    Safe by construction: a CF instance whose token is scoped to specific
    tenants can never return another tenant's rows, regardless of what the
    caller passes — or forgets to pass.

      • token scoped to tenant(s): force-filter to them. A requested tenant_id
        must be inside the set (else 403); a single configured tenant is
        applied automatically; multiple configured tenants with no requested
        tenant_id is ambiguous → 400 (caller must choose).
      • global/unrestricted token (no configured tenant ids — the default
        single-box deploy): unchanged — honour an explicit tenant_id when
        given, else no tenant filter.
    """
    allowed = configured_tenant_ids_for_service_token()
    if not allowed:
        return requested_tenant_id
    if requested_tenant_id:
        if requested_tenant_id not in allowed:
            raise HTTPException(status_code=403, detail="tenant_id is outside this service token's tenant scope")
        return requested_tenant_id
    if len(allowed) == 1:
        return allowed[0]
    raise HTTPException(status_code=400, detail="tenant_id is required (service token is scoped to multiple tenants)")


def _assert_row_tenant_visible(rec: Optional[dict]) -> None:
    """By-id reads: hide a row whose tenant is outside the token's scope. Raises
    404 (not 403) so the existence of another tenant's row isn't revealed."""
    if not rec:
        return
    allowed = configured_tenant_ids_for_service_token()
    if not allowed:
        return
    if rec.get("tenant_id") not in allowed:
        raise HTTPException(status_code=404, detail="not found")


# ── Request/Response models ───────────────────────────────────────────────

class RunContext(BaseModel):
    workflow_instance_id: Optional[str] = None
    workflow_node_id: Optional[str] = None
    agent_run_id: Optional[str] = None
    work_item_id: Optional[str] = None
    work_item_code: Optional[str] = None
    capability_id: Optional[str] = None
    tenant_id: Optional[str] = None
    agent_template_id: Optional[str] = None
    user_id: Optional[str] = None
    trace_id: Optional[str] = None
    branch_base: Optional[str] = None
    branch_name: Optional[str] = None
    source_type: Optional[str] = None
    source_uri: Optional[str] = None
    source_ref: Optional[str] = None
    effective_capabilities: list[dict[str, Any]] = Field(default_factory=list)
    profile_snapshot_hash: Optional[str] = None
    profile_provider_resolutions: list[dict[str, Any]] = Field(default_factory=list)
    # §13.4 — when "copilot", CF does NOT run the function-calling loop; it
    # dispatches the `copilot_execute` tool to mcp-server (laptop-routed) which
    # runs `copilot -p --allow-all` in the work-item workspace, and wraps the
    # {summary, diff, changedPaths} receipt as a FINALIZED stage result. Set by
    # the node/stage config (workgraph AGENT_TASK config.executor).
    executor: Optional[str] = None


class ExecuteRequest(BaseModel):
    trace_id: Optional[str] = None
    idempotency_key: Optional[str] = None
    run_context: RunContext = Field(default_factory=RunContext)
    task: str
    system_prompt: Optional[str] = None
    vars: dict[str, Any] = Field(default_factory=dict)
    globals: dict[str, Any] = Field(default_factory=dict)
    prior_outputs: dict[str, Any] = Field(default_factory=dict)
    # M66 — Receipts from prior stages in a multi-stage Blueprint Workbench
    # workflow. Each stage runs in its own /mcp/invoke session; without this
    # field the QA stage's run_test receipt is lost before the developer
    # stage's auto-finish reads state.verificationReceipts. Caller (workgraph-
    # studio blueprint router) is responsible for accumulating receipts across
    # stages and passing the union here.
    prior_verification_receipts: list[dict[str, Any]] = Field(default_factory=list)
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    overrides: dict[str, Any] = Field(default_factory=dict)
    model_overrides: dict[str, Any] = Field(default_factory=dict)
    context_policy: dict[str, Any] = Field(default_factory=dict)
    limits: dict[str, Any] = Field(default_factory=dict)
    preview_only: bool = False
    allow_autonomous_mutation: bool = False
    # M26 — route the /mcp/invoke to the user's laptop-resident mcp-server via
    # the WebSocket bridge instead of the shared HTTP mcp-server. Requires
    # run_context.user_id. Fails fast with MCP_NOT_CONNECTED if no live
    # laptop. When None, the bridge is used opportunistically (auto-prefer
    # if a connection exists for the user).
    prefer_laptop: Optional[bool] = None
    # Governance posture for this execution. When omitted, Context Fabric uses
    # DEFAULT_GOVERNANCE_MODE; production-class deploys require fail_closed.
    governance_mode: Optional[str] = None


GOVERNANCE_MODES = {"fail_open", "fail_closed", "degraded", "human_approval_required"}


# ── HTTP helpers ──────────────────────────────────────────────────────────

def _agent_runtime_api_base() -> str:
    base = settings.agent_runtime_url.rstrip("/")
    if not base:
        return ""
    return base if base.endswith("/api/v1") else f"{base}/api/v1"


async def _resolve_agent_profile_capabilities(
    agent_template_id: Optional[str],
    existing_capabilities: Any = None,
    existing_snapshot_hash: Optional[str] = None,
    existing_provider_resolutions: Any = None,
) -> tuple[list[dict[str, Any]], Optional[str], list[dict[str, Any]]]:
    if isinstance(existing_capabilities, list):
        provider_resolutions = [item for item in existing_provider_resolutions if isinstance(item, dict)] if isinstance(existing_provider_resolutions, list) else []
        return [item for item in existing_capabilities if isinstance(item, dict)], existing_snapshot_hash, provider_resolutions
    base = _agent_runtime_api_base()
    if not base or not agent_template_id:
        return [], existing_snapshot_hash, []
    service_token = await get_iam_service_token()
    resolved = await _post(
        f"{base}/agents/profiles/{agent_template_id}/resolve",
        {},
        timeout=10.0,
        headers={"Authorization": f"Bearer {service_token or ''}"},
    )
    data = resolved.get("data") if isinstance(resolved.get("data"), dict) else resolved
    raw_capabilities = data.get("effectiveCapabilities") if isinstance(data, dict) else []
    capabilities = [item for item in raw_capabilities if isinstance(item, dict)] if isinstance(raw_capabilities, list) else []
    snapshot_hash = data.get("snapshotHash") if isinstance(data, dict) and isinstance(data.get("snapshotHash"), str) else existing_snapshot_hash
    raw_provider_resolutions = data.get("providerResolutions") if isinstance(data, dict) else []
    provider_resolutions = [item for item in raw_provider_resolutions if isinstance(item, dict)] if isinstance(raw_provider_resolutions, list) else []
    return capabilities, snapshot_hash, provider_resolutions

async def _get(url: str, params: Optional[dict] = None, timeout: float = 30.0,
               headers: Optional[dict] = None) -> dict:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, params=params, headers=headers)
        resp.raise_for_status()
        return response_json_object(resp, "legacy execute GET")


async def _iam_get(url: str, params: Optional[dict] = None, timeout: float = 30.0) -> dict:
    token = await get_iam_service_token()
    try:
        return await _get(url, params=params, headers={"Authorization": f"Bearer {token or ''}"}, timeout=timeout)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code != 401:
            raise
        invalidate_iam_service_token()
        token = await get_iam_service_token()
        return await _get(url, params=params, headers={"Authorization": f"Bearer {token or ''}"}, timeout=timeout)

TOOL_EXECUTION_TARGETS = {"LOCAL", "SERVER"}
TOOL_RISK_LEVELS = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}


# ── Orchestrator ──────────────────────────────────────────────────────────

@router.post("/execute")
async def execute(req: ExecuteRequest, x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token")):
    check_execute_service_token(x_service_token)
    cf_call_id = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc).isoformat()
    trace_id = req.trace_id or req.run_context.trace_id or str(uuid.uuid4())
    governance_mode = _governance_mode(
        req.governance_mode or settings.default_governance_mode,
        fallback=settings.default_governance_mode,
    )
    session_id = (
        f"wf:{req.run_context.workflow_instance_id}:{req.run_context.workflow_node_id}"
        if req.run_context.workflow_instance_id and req.run_context.workflow_node_id
        else f"cf:{cf_call_id}"
    )

    # M73-followup Slice 1 — fail-closed pre-flight. When the caller
    # declares governance_mode=fail_closed, we MUST confirm audit-gov can
    # receive events before the run starts; otherwise un-governed work
    # silently happens. Body lives in execute_modules/governance.py;
    # raises HTTPException(503) on denial.
    await _gov_mod.fail_closed_precheck(governance_mode, req, cf_call_id, trace_id)

    # ── 1. Compose the prompt (preview mode → just assembled prompt) ────
    prompt_assembly_id: Optional[str] = None
    system_prompt: Optional[str] = req.system_prompt
    user_message = req.task
    composer_warnings: list[str] = []
    composer_budget_warnings: list[str] = []
    composer_retrieval_stats: dict[str, Any] = {}
    composer_estimated_input_tokens: Optional[int] = None
    composer_available = False
    context_plan: Optional[dict[str, Any]] = None
    context_plan_hash: Optional[str] = None
    required_context_status: dict[str, Any] = {
        "valid": False,
        "reason": "not_checked",
        "missingRequired": [],
        "contextPlanHash": None,
    }
    execution_posture = "full"

    if not req.run_context.capability_id:
        raise HTTPException(status_code=400, detail="run_context.capability_id is required")
    if settings.require_tenant_id and not req.run_context.tenant_id:
        raise HTTPException(status_code=400, detail="run_context.tenant_id is required when REQUIRE_TENANT_ID=true")

    effective_capabilities: list[dict[str, Any]] = []
    profile_snapshot_hash: Optional[str] = None
    profile_provider_resolutions: list[dict[str, Any]] = []
    effective_capabilities_provided = bool(req.run_context.effective_capabilities)
    effective_capabilities_required = bool(req.run_context.agent_template_id or effective_capabilities_provided)
    if req.run_context.effective_capabilities:
        effective_capabilities = req.run_context.effective_capabilities
        profile_snapshot_hash = req.run_context.profile_snapshot_hash
        profile_provider_resolutions = req.run_context.profile_provider_resolutions
    elif settings.agent_runtime_url and req.run_context.agent_template_id:
        try:
            effective_capabilities, profile_snapshot_hash, profile_provider_resolutions = await _resolve_agent_profile_capabilities(
                req.run_context.agent_template_id,
                req.run_context.effective_capabilities,
                req.run_context.profile_snapshot_hash,
                req.run_context.profile_provider_resolutions,
            )
            req.run_context.effective_capabilities = effective_capabilities
            req.run_context.profile_snapshot_hash = profile_snapshot_hash
            req.run_context.profile_provider_resolutions = profile_provider_resolutions
        except Exception as exc:
            if governance_mode == "fail_closed":
                raise HTTPException(status_code=502, detail=f"agent profile resolution failed: {exc!s}")
            composer_warnings.append(f"agent profile resolution unavailable: {exc!s}")

    # Context Fabric owns the run-level tool list. The same descriptors are
    # rendered into the prompt by Prompt Composer and sent to MCP for execution.
    tools_for_mcp: list[dict[str, Any]] = []
    if not _stage_is_story_only(req):
        try:
            discover = await _post(
                f"{settings.tool_service_url.rstrip('/')}/api/v1/tools/discover",
                {
                    "capability_id": req.run_context.capability_id,
                    "agent_uid": req.run_context.agent_template_id or "default-agent",
                    "query": req.task,
                    "risk_max": "high",
                    "limit": 8,
                    "effective_capabilities": effective_capabilities,
                },
                timeout=10.0,
            )
            for t in discover.get("tools", []):
                normalized_tool, tool_warnings = _normalize_tool_for_mcp(t)
                composer_warnings.extend(tool_warnings)
                if normalized_tool:
                    tools_for_mcp.append(normalized_tool)
        except Exception as exc:
            composer_warnings.append(f"tool discovery unavailable: {exc!s}")

    tools_for_mcp = _merge_mandatory_local_tools(tools_for_mcp, req)
    tools_for_mcp, tool_gate_warnings = _filter_tools_by_effective_capabilities(
        tools_for_mcp,
        effective_capabilities,
        require_effective_capabilities=effective_capabilities_required,
    )
    composer_warnings.extend(tool_gate_warnings)

    # M52 — Code Context Budgeter orchestration. For Developer-style stages,
    # call mcp-server's /mcp/code-context/build BEFORE prompt composition so
    # Prompt Composer can render 7 deterministic CODE_* layers in place of
    # the legacy semantic CODE_CONTEXT layer. Slice content stays in-flight
    # (this dict → prompt-composer → mcp-server → LLM gateway); only
    # metadata is recorded in the audit event mcp-server emits.
    code_context_package: Optional[dict] = None
    is_dev_stage, _is_qa_stage = _classify_stage_role(req)
    if is_dev_stage and not _stage_is_story_only(req) and req.task and req.task.strip():
        try:
            mcp_record, mcp_warnings = await _resolve_mcp_record(
                req.run_context.capability_id or "",
            )
            composer_warnings.extend(mcp_warnings)
            mcp_base = str(mcp_record.get("base_url") or "")
            mcp_tok = str(mcp_record.get("bearer_token") or "")
            if mcp_base:
                code_context_package, ccp_warning = await _build_code_context_package(
                    mcp_base, mcp_tok, req, trace_id,
                )
                if ccp_warning:
                    composer_warnings.append(ccp_warning)
        except Exception as exc:  # pylint: disable=broad-except
            composer_warnings.append(f"mcp.code_context.skipped: resolve_mcp_record error {exc!s}")

    # M61 Wire 2 — Fetch the capability's CapabilityWorldModel from
    # agent-runtime and pass it through to prompt-composer as
    # ComposeInput.worldModel. The Slice F renderers emit
    # CODE_AGENT_RULES + CODE_WORLD_MODEL layers above the M52
    # CODE_* layers so the agent sees CLAUDE.md / AGENTS.md, test
    # commands, README summary, and the top-level package map as
    # ambient context before any tool calls.
    #
    # Unlike the code-context budgeter (Dev stages only), the world
    # model is useful for every stage that touches the capability —
    # Story Intake reads agent rules, Plan reads the README summary,
    # etc. So we fetch unconditionally when agent_runtime_url is set
    # and we have a capability_id.
    world_model: Optional[dict] = None
    if settings.agent_runtime_url and req.run_context.capability_id and not _stage_is_story_only(req):
        try:
            world_model, wm_warning = await _fetch_capability_world_model(
                settings.agent_runtime_url,
                req.run_context.capability_id,
                settings.agent_runtime_world_model_timeout_sec,
            )
            if wm_warning:
                composer_warnings.append(wm_warning)
        except Exception as exc:  # pylint: disable=broad-except
            composer_warnings.append(f"world_model.skipped: unexpected error {exc!s}")

    if req.run_context.agent_template_id:
        try:
            compose_payload = {
                "agentTemplateId": req.run_context.agent_template_id,
                "capabilityId": req.run_context.capability_id,
                "task": req.task,
                "workflowContext": {
                    "instanceId": req.run_context.workflow_instance_id or session_id,
                    "nodeId": req.run_context.workflow_node_id or "single-shot",
                    # M28 spine-2 — propagate the trace_id so PromptAssembly
                    # rows are joinable against tool invocations, llm calls,
                    # audit events, and code changes by the same key.
                    "traceId": trace_id,
                    "vars": req.vars,
                    "globals": req.globals,
                    "priorOutputs": req.prior_outputs,
                },
                "artifacts": req.artifacts,
                "overrides": req.overrides,
                "modelOverrides": req.model_overrides,
                "contextPolicy": _composer_context_policy(req.context_policy, req.limits),
                "toolDescriptors": tools_for_mcp,
                "effectiveCapabilities": effective_capabilities,
                "effectiveCapabilitiesRequired": effective_capabilities_required,
                # M44 Slice C — Context Fabric always sends tools through the
                # structured channel (toolDescriptors → MCP → LLM provider's
                # `tools` parameter), so the schema dump duplicated inside
                # the TOOL_CONTRACT prompt-prose layer is pure waste.
                # Enable compact rendering: name + purpose + risk + required
                # args only. ~5-10K tokens saved per LLM call.
                "compactToolContracts": True,
                # M52 — When the budgeter ran successfully, attach the
                # package so Prompt Composer emits the 7 CODE_* layers
                # instead of the legacy monolithic CODE_CONTEXT layer.
                # Optional: absent → composer falls back to today's path.
                **({"codeContextPackage": code_context_package} if code_context_package else {}),
                # M61 Wire 2 — When agent-runtime returned a world model
                # for the capability, attach it so Prompt Composer emits
                # CODE_AGENT_RULES (priority 305) + CODE_WORLD_MODEL
                # (308) above the M52 CODE_* layers. Optional: absent →
                # composer skips those two layers and the agent reverts
                # to discovering CLAUDE.md / test commands per run.
                **({"worldModel": world_model} if world_model else {}),
                # M62 Slice E — Per-layer prompt compression. When
                # enabled (operator flag), prompt-composer POSTs
                # over-budget allowlisted layers (default
                # CODE_AGENT_RULES + RUNTIME_EVIDENCE) to the
                # prompt-compressor sidecar. Compressor sidecar default
                # strategy is stopword removal (~0ms latency, no ML
                # model). Set COMPRESSION_ENABLED=true in context-api
                # env to activate.
                **(
                    {
                        "compression": {
                            "enabled": True,
                            "perLayerBudgetTokens": settings.compression_per_layer_budget_tokens,
                            "compressorUrl": settings.compressor_url,
                        }
                    }
                    if settings.compression_enabled and settings.compressor_url
                    else {}
                ),
                "previewOnly": True,
            }
            composer_headers: dict[str, str] = {}
            composer_bearer = (
                req.bearer
                or await get_iam_service_token()
                or os.environ.get("PROMPT_COMPOSER_SERVICE_TOKEN")
                or os.environ.get("CONTEXT_FABRIC_SERVICE_TOKEN")
            )
            if composer_bearer:
                composer_headers["authorization"] = f"Bearer {composer_bearer}"
            composed = await _post(
                f"{settings.composer_url.rstrip('/')}/api/v1/compose-and-respond",
                compose_payload,
                timeout=60.0,
                headers=composer_headers or None,
            )
            data = composed.get("data") or composed
            composer_available = True
            prompt_assembly_id = data.get("promptAssemblyId")
            assembled = data.get("assembled") or {}
            system_prompt = assembled.get("systemPrompt")
            user_message = assembled.get("message") or req.task
            composer_warnings.extend(data.get("warnings") or [])
            composer_budget_warnings = data.get("budgetWarnings") or []
            composer_retrieval_stats = data.get("retrievalStats") or {}
            raw_context_plan = data.get("contextPlan")
            if isinstance(raw_context_plan, dict):
                context_plan = raw_context_plan
                context_plan_hash = str(raw_context_plan.get("contextPlanHash") or "") or None
            raw_estimated_tokens = data.get("estimatedInputTokens")
            if isinstance(raw_estimated_tokens, int):
                composer_estimated_input_tokens = raw_estimated_tokens
        except Exception as exc:
            composer_warnings.append(f"composer unreachable: {exc!s}")

    required_context_status = _context_plan_status(context_plan, composer_available if req.run_context.agent_template_id else bool(system_prompt))
    approved_context_plan_bypass = req.context_policy.get("approvedContextPlanBypass")
    if approved_context_plan_bypass and not required_context_status.get("valid"):
        bypassed_status = dict(required_context_status)
        required_context_status = {
            **bypassed_status,
            "valid": True,
            "reason": None,
            "approvedContextPlanBypass": approved_context_plan_bypass,
            "bypassedRequiredContextStatus": bypassed_status,
            "missingRequired": [],
        }
        composer_warnings.append(
            f"context plan approval {approved_context_plan_bypass} bypassed missing required prompt context"
        )
        emit_audit_event(
            kind="governance.context_approval.bypass_used",
            trace_id=trace_id,
            subject_type="CfCallLog",
            subject_id=cf_call_id,
            capability_id=req.run_context.capability_id,
            severity="warn",
            payload={
                "approved_context_plan_bypass": approved_context_plan_bypass,
                "governance_mode": governance_mode,
                "bypassed_required_context_status": bypassed_status,
            },
        )
    context_plan_hash = context_plan_hash or required_context_status.get("contextPlanHash")
    if required_context_status.get("valid"):
        emit_audit_event(
            kind="context_plan.validated",
            trace_id=trace_id,
            subject_type="PromptAssembly",
            subject_id=prompt_assembly_id,
            capability_id=req.run_context.capability_id,
            severity="info",
            payload={
                "cf_call_id": cf_call_id,
                "governance_mode": governance_mode,
                "context_plan_hash": context_plan_hash,
                "workflow_instance_id": req.run_context.workflow_instance_id,
                "workflow_node_id": req.run_context.workflow_node_id,
                "required_context_status": required_context_status,
            },
        )
    else:
        message = _context_plan_message(required_context_status)
        composer_warnings.append(message)
        emit_audit_event(
            kind="context_plan.invalid",
            trace_id=trace_id,
            subject_type="PromptAssembly",
            subject_id=prompt_assembly_id,
            capability_id=req.run_context.capability_id,
            severity="warn",
            payload={
                "cf_call_id": cf_call_id,
                "governance_mode": governance_mode,
                "context_plan_hash": context_plan_hash,
                "required_context_status": required_context_status,
            },
        )
        if governance_mode == "fail_closed":
            _persist_failure(cf_call_id, started_at, trace_id, req, prompt_assembly_id,
                             message, session_id)
            raise HTTPException(status_code=422, detail={
                "code": "CONTEXT_PLAN_INVALID",
                "message": message,
                "requiredContextStatus": required_context_status,
                "contextPlanHash": context_plan_hash,
                "governanceMode": governance_mode,
                "executionPosture": "blocked",
                "trace_id": trace_id,
            })
        if governance_mode == "degraded":
            execution_posture = "degraded"
            emit_audit_event(
                kind="governance.degraded_execution.allowed",
                trace_id=trace_id,
                subject_type="CfCallLog",
                subject_id=cf_call_id,
                capability_id=req.run_context.capability_id,
                severity="warn",
                payload={
                    "reason": message,
                    "context_plan_hash": context_plan_hash,
                    "required_context_status": required_context_status,
                    "degraded_actions_allowed": [] if _stage_is_story_only(req) else ["read_file", "search_code", "index_workspace", "find_symbol", "get_symbol", "get_ast_slice", "get_dependencies"],
                },
            )
        elif governance_mode == "human_approval_required":
            continuation_token = f"ctx-{uuid.uuid4()}"
            call_log.insert({
                "id": cf_call_id,
                "trace_id": trace_id,
                "workflow_run_id": req.run_context.workflow_instance_id,
                "workflow_node_id": req.run_context.workflow_node_id,
                "agent_run_id": req.run_context.agent_run_id,
                "capability_id": req.run_context.capability_id,
                "tenant_id": req.run_context.tenant_id,
                "agent_template_id": req.run_context.agent_template_id,
                "profile_snapshot_hash": profile_snapshot_hash,
                "profile_provider_resolutions": profile_provider_resolutions,
                "profile_effective_capabilities": effective_capabilities,
                "session_id": session_id,
                "prompt_assembly_id": prompt_assembly_id,
                "status": "WAITING_APPROVAL",
                "finish_reason": "context_plan_approval_required",
                "final_response": "",
                "started_at": started_at,
                "completed_at": None,
                "continuation_token": continuation_token,
                "pending_tool_name": "context_plan_approval",
                "pending_tool_args": {
                    "reason": message,
                    "requiredContextStatus": required_context_status,
                    "contextPlanHash": context_plan_hash,
                    "executeRequest": req.model_dump(mode="json"),
                },
            })
            emit_audit_event(
                kind="governance.context_approval.requested",
                trace_id=trace_id,
                subject_type="CfCallLog",
                subject_id=cf_call_id,
                capability_id=req.run_context.capability_id,
                severity="warn",
                payload={
                    "continuation_token": continuation_token,
                    "reason": message,
                    "context_plan_hash": context_plan_hash,
                    "required_context_status": required_context_status,
                },
            )
            return {
                "status": "WAITING_APPROVAL",
                "finalResponse": "",
                "correlation": {
                    "cfCallId": cf_call_id,
                    "traceId": trace_id,
                    "sessionId": session_id,
                    "promptAssemblyId": prompt_assembly_id,
                    "llmCallIds": [],
                    "toolInvocationIds": [],
                    "artifactIds": [],
                    "codeChangeIds": [],
                },
                "tokensUsed": {"input": 0, "output": 0, "total": 0},
                "usage": _usage_metadata(
                    tokens_used={},
                    model_overrides=req.model_overrides,
                    actual_model_usage={},
                    prompt_assembly_id=prompt_assembly_id,
                    cf_call_id=cf_call_id,
                    optimization_metrics={},
                ),
                "modelUsage": {},
                "prompt": {
                    "estimatedInputTokens": composer_estimated_input_tokens,
                    "budgetWarnings": composer_budget_warnings,
                    "retrievalStats": composer_retrieval_stats,
                    "contextPlan": context_plan,
                },
                "contextPlanHash": context_plan_hash,
                "requiredContextStatus": required_context_status,
                "governanceMode": governance_mode,
                "executionPosture": "approval_paused",
                "blockedReason": message,
                "finishReason": "context_plan_approval_required",
                "stepsTaken": 0,
                "metrics": {},
                "warnings": composer_warnings,
                "pendingApproval": {
                    "continuation_token": continuation_token,
                    "tool_name": "context_plan_approval",
                    "tool_args": {
                        "reason": message,
                        "missingRequired": required_context_status.get("missingRequired") or [],
                    },
                    "tool_descriptor": {
                        "name": "context_plan_approval",
                        "description": "Approve execution with missing required prompt context.",
                        "execution_target": "SERVER",
                        "source": "context_fabric",
                        "risk_level": "HIGH",
                    },
                },
            }
        else:
            execution_posture = "unverified"

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

    # ── 3. Resolve MCP runtime ──────────────────────────────────────────
    try:
        full, mcp_warnings = await _resolve_mcp_record(req.run_context.capability_id)
        composer_warnings.extend(mcp_warnings)
    except httpx.HTTPError as exc:
        _persist_failure(cf_call_id, started_at, trace_id, req, prompt_assembly_id,
                         f"IAM unreachable while resolving MCP servers: {exc!s}", session_id)
        raise HTTPException(status_code=502, detail=f"IAM unreachable: {exc!s}")
    mcp_server_id = full["id"]
    mcp_base_url = full["base_url"].rstrip("/")
    mcp_bearer = full["bearer_token"]

    # ── 4. Invoke the MCP server ────────────────────────────────────────
    # MCP-server uses Zod with `.optional()` which accepts undefined but
    # NOT null. Strip Nones so the JSON has no null fields.
    def _strip_nones(d: dict) -> dict:
        return {k: v for k, v in d.items() if v is not None}

    invoke_payload: dict[str, Any] = {
        "history": history,
        "message": mcp_message,
        "tools": tools_for_mcp,
        "governanceMode": governance_mode,
        "contextPlanHash": context_plan_hash,
        "degradedActionsAllowed": (
            ([] if _stage_is_story_only(req) else ["read_file", "search_code", "index_workspace", "find_symbol", "get_symbol", "get_ast_slice", "get_dependencies"])
            if execution_posture == "degraded" else []
        ),
        "modelConfig": _strip_nones({
            "modelAlias": req.model_overrides.get("modelAlias") or req.model_overrides.get("model_alias"),
            "temperature": req.model_overrides.get("temperature"),
            "maxTokens": (
                req.model_overrides.get("maxOutputTokens")
                or req.model_overrides.get("max_output_tokens")
                or req.limits.get("outputTokenBudget")
                or req.limits.get("output_token_budget")
            ),
            "promptCache": req.model_overrides.get("promptCache") or req.model_overrides.get("prompt_cache"),
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
            "workItemId": req.run_context.work_item_id or req.run_context.agent_run_id,
            "workItemCode": req.run_context.work_item_code,
            "branchBase": req.run_context.branch_base,
            "branchName": req.run_context.branch_name,
            "sourceType": req.run_context.source_type,
            "sourceUri": req.run_context.source_uri,
            "sourceRef": req.run_context.source_ref,
            "effectiveCapabilities": effective_capabilities,
            "effectiveCapabilitiesRequired": effective_capabilities_required,
            "profileSnapshotHash": profile_snapshot_hash,
            "profileProviderResolutions": profile_provider_resolutions,
            "traceId": trace_id,
        }),
        "limits": _strip_nones({
            "maxSteps": req.limits.get("maxSteps") or req.limits.get("max_steps") or 3,
            "timeoutSec": req.limits.get("timeoutSec") or req.limits.get("timeout_sec") or 240,
            "maxToolResultChars": req.limits.get("maxToolResultChars") or req.limits.get("max_tool_result_chars"),
            "maxHistoryMessages": req.limits.get("maxHistoryMessages") or req.limits.get("max_history_messages"),
            "maxHistoryTokens": req.limits.get("maxHistoryTokens") or req.limits.get("max_history_tokens"),
            "compressToolResults": req.limits.get("compressToolResults") if "compressToolResults" in req.limits else req.limits.get("compress_tool_results"),
            # M44 Slice B — default includeLocalTools=false for EVERY stage.
            # The canonical tool list emitted by _mandatory_local_tools_for_request
            # is now complete (covers every tool in mcp-server's REGISTRY that
            # any agent role should see; M43 audit). With auto-injection off,
            # mcp-server sends only the tools we explicitly authored — saves
            # ~4K tokens per LLM call (one local tool schema ~= 200 tokens,
            # ~20 redundant injections). Callers that genuinely need the full
            # registry (a debug harness, e.g.) can still pass includeLocalTools=true
            # explicitly. M43 Slice 2 already enforced false for QA stages;
            # this extends to Dev and non-code stages too.
            "includeLocalTools": (
                req.limits.get("includeLocalTools")
                if "includeLocalTools" in req.limits
                else req.limits.get("include_local_tools", False)
            ),
            # ── Phased Agent Reasoning Model (v4) ──────────────────────
            # Plumb caller-supplied phase mode + per-phase budgets through
            # to mcp-server's InvokeSchema.limits. Without these here, the
            # body keys would be unknown to context-fabric's pass-through
            # and silently dropped before reaching mcp-server. Both camelCase
            # and snake_case lookups so workgraph-api or external callers
            # using either convention are honored.
            "agentReasoningMode": (
                req.limits.get("agentReasoningMode")
                or req.limits.get("agent_reasoning_mode")
            ),
            "phaseBudgets": (
                req.limits.get("phaseBudgets")
                or req.limits.get("phase_budgets")
            ),
        }),
        "allowAutonomousMutation": req.allow_autonomous_mutation,
    }
    # M66 — Pass prior-stage receipts through to mcp-server's InvokeSchema so
    # state.verificationReceipts starts populated. Only add the key when
    # non-empty (mcp-server's Zod schema is optional + treats missing as []).
    if req.prior_verification_receipts:
        invoke_payload["priorVerificationReceipts"] = req.prior_verification_receipts
    if context_plan_hash is None:
        invoke_payload.pop("contextPlanHash", None)
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
    # M73-followup Slice 3 — resolve_laptop_target() in laptop_dispatcher.py
    # owns the "is a laptop bridge live for this user?" decision. It returns
    # (False, None, None) when nothing is connected; we still need to handle
    # the "required but missing" branch here because that error path also has
    # to write a FAILED call_log row (which is orchestrator state).
    use_laptop, laptop_device_id, laptop_device_name = await _laptop_mod.resolve_laptop_target(
        user_id=user_id,
        # Placement policy: enterprise mode forces the shared cloud mcp-server
        # (never the laptop), even when prefer_laptop is set. See placement.py.
        prefer_laptop=_placement.mcp_laptop_allowed(req.prefer_laptop),
    )
    if not use_laptop and req.prefer_laptop is True and user_id:
        _persist_failure(cf_call_id, started_at, trace_id, req, prompt_assembly_id,
                         "MCP_NOT_CONNECTED: laptop mcp-server is not online for this user",
                         session_id, mcp_server_id=mcp_server_id)
        raise HTTPException(status_code=503, detail={
            "code": "MCP_NOT_CONNECTED",
            "message": "Your laptop mcp-server is not connected. Run `singularity-mcp start` and retry.",
            "user_id": user_id,
        })
    if not use_laptop and os.getenv("RUNTIME_HTTP_FALLBACK_ENABLED", "false").strip().lower() not in {"1", "true", "yes", "on"}:
        _persist_failure(
            cf_call_id, started_at, trace_id, req, prompt_assembly_id,
            "RUNTIME_NOT_CONNECTED: MCP runtime bridge is not connected",
            session_id, mcp_server_id=mcp_server_id,
        )
        raise HTTPException(status_code=503, detail={
            "code": "RUNTIME_NOT_CONNECTED",
            "message": "No MCP runtime is connected through the Runtime Bridge. Start the MCP runtime dial-in or enable RUNTIME_HTTP_FALLBACK_ENABLED for debug HTTP.",
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
            from .laptop_registry import LaptopInvokeError, LaptopInvokeTimeout
            try:
                mcp_data = await _laptop_mod.dispatch_via_laptop(
                    user_id=user_id,  # type: ignore[arg-type]
                    payload=invoke_payload,
                    timeout_sec=float(req.limits.get("timeoutSec", 240)),
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
            # M64 — Default MCP-invoke timeout bumped from 240 → 480
            # via CONTEXT_FABRIC_MCP_INVOKE_TIMEOUT_SEC. Must exceed
            # mcp-server's own TIMEOUT_SEC (300) + the subscriber-drain
            # window (~1s) so context-fabric doesn't abort a healthy
            # mid-flight workflow. Caller can still override per-request
            # via req.limits.timeoutSec.
            _default_mcp_timeout = float(
                os.getenv("CONTEXT_FABRIC_MCP_INVOKE_TIMEOUT_SEC", "480"),
            )
            mcp_resp = await _mcp_mod.dispatch_invoke(
                mcp_base_url=mcp_base_url,
                mcp_bearer=mcp_bearer,
                payload=invoke_payload,
                timeout_sec=float(req.limits.get("timeoutSec", _default_mcp_timeout)),
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
            detail = response_json_object(exc.response, "MCP invoke error")
        except Exception:
            detail = {"message": exc.response.text[:500]}
        # M64 / M73-followup Slice 3 — classify_invoke_error() in
        # mcp_dispatcher.py decides whether to surface mcp-server's inner
        # LLM_* error code (so workbench can show specific retry copy) or
        # collapse to the generic MCP_INVOKE_FAILED.
        inner_code, inner_message = _mcp_mod.classify_invoke_error(detail)
        if inner_code:
            _persist_failure(cf_call_id, started_at, trace_id, req, prompt_assembly_id,
                             f"{inner_code}: {detail}", session_id, mcp_server_id=mcp_server_id)
            raise HTTPException(status_code=exc.response.status_code, detail={
                "code": inner_code,
                "message": inner_message,
                "details": detail,
            })
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
        err_msg = str(exc) if str(exc).strip() else f"Internal error: {type(exc).__name__}"
        _persist_failure(cf_call_id, started_at, trace_id, req, prompt_assembly_id,
                         f"MCP invoke failed: {err_msg}", session_id, mcp_server_id=mcp_server_id)
        raise HTTPException(status_code=502, detail=f"MCP invoke failed: {err_msg}")

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
    verification_receipts = mcp_data.get("verificationReceipts") or correlation.get("verificationReceipts") or []

    # ── 6. Persist memory turn + summary + metrics ──────────────────────
    # M73-followup Slice 2 — body lives in execute_modules/memory_context.py.
    # Best-effort: any context-memory failure is swallowed inside the helper.
    await _memory_mod.persist_turn_and_maybe_summarise(
        session_id=session_id,
        agent_id=req.run_context.agent_template_id,
        user_message=req.task,
        assistant_response=final_response,
        limits=req.limits,
    )

    # ── 7. Drain MCP events for this trace (M9.x safety net for the
    #       live WS subscriber from M9.y; idempotent on event id) ──────
    drained = await _drain_mcp_events(mcp_base_url, mcp_bearer, trace_id)

    # ── 8. CallLog row ──────────────────────────────────────────────────
    completed_at = datetime.now(timezone.utc).isoformat()
    is_paused = status == "WAITING_APPROVAL"
    usage = _usage_metadata(
        tokens_used=tokens_used,
        model_overrides=req.model_overrides,
        actual_model_usage=actual_model_usage,
        prompt_assembly_id=prompt_assembly_id,
        cf_call_id=cf_call_id,
        optimization_metrics=optimization_metrics,
    )
    call_log.insert({
        "id": cf_call_id,
        "trace_id": trace_id,
        "workflow_run_id": req.run_context.workflow_instance_id,
        "workflow_node_id": req.run_context.workflow_node_id,
        "agent_run_id": req.run_context.agent_run_id,
        "capability_id": req.run_context.capability_id,
        "tenant_id": req.run_context.tenant_id,
        "agent_template_id": req.run_context.agent_template_id,
        "profile_snapshot_hash": profile_snapshot_hash,
        "profile_provider_resolutions": profile_provider_resolutions,
        "profile_effective_capabilities": effective_capabilities,
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
        "estimated_cost": usage.get("estimatedCost"),
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
            "estimated_cost": usage.get("estimatedCost"),
            "model_alias": usage.get("modelAlias"),
            "provider": usage.get("provider"),
            "model": usage.get("model"),
            "tokens_saved": optimization_metrics.get("tokens_saved") or optimization_metrics.get("tokensSaved"),
            "prompt_cache": usage.get("promptCache"),
            "prompt_budget_warnings": composer_budget_warnings,
            "prompt_retrieval_stats": composer_retrieval_stats,
            "prompt_estimated_input_tokens": composer_estimated_input_tokens,
            "context_plan_hash": context_plan_hash,
            "required_context_status": required_context_status,
            "governance_mode": governance_mode,
            "execution_posture": execution_posture,
            "mcp_latency_ms": mcp_latency_ms,
            "agent_run_id": req.run_context.agent_run_id,
            "workflow_instance_id": req.run_context.workflow_instance_id,
        },
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
            "contextPlanHash": context_plan_hash,
            "governanceMode": governance_mode,
            "executionPosture": execution_posture,
            "llmCallIds": correlation.get("llmCallIds") or [],
            "toolInvocationIds": correlation.get("toolInvocationIds") or [],
            "artifactIds": correlation.get("artifactIds") or [],
            "codeChangeIds": correlation.get("codeChangeIds") or [],
            "verificationReceipts": verification_receipts,
            "workspaceRoot": workspace.get("workspaceRoot"),
            "workspaceBranch": workspace.get("workspaceBranch"),
            "workspaceCommitSha": workspace.get("workspaceCommitSha"),
            "changedPaths": workspace.get("changedPaths") or [],
            "astIndexStatus": workspace.get("astIndexStatus"),
            "astIndexedFiles": workspace.get("astIndexedFiles"),
            "astIndexedSymbols": workspace.get("astIndexedSymbols"),
            # M56 — per-phase token + cost rollup from mcp-server. Drop-through
            # so the workbench's PhaseTokensStrip can read it off the attempt's
            # correlation without re-walking the audit ring.
            "phaseTokens": correlation.get("phaseTokens"),
            "codeChangeCoverage": correlation.get("codeChangeCoverage"),
            "verificationCoverage": correlation.get("verificationCoverage"),
        },
        "workspace": workspace,
        "verificationReceipts": verification_receipts,
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
            "promptCache": usage.get("promptCache"),
        },
        "promptCache": usage.get("promptCache"),
        "prompt": {
            "estimatedInputTokens": composer_estimated_input_tokens,
            "budgetWarnings": composer_budget_warnings,
            "retrievalStats": composer_retrieval_stats,
            "contextPlan": context_plan,
            "promptCache": usage.get("promptCache"),
        },
        "contextPlanHash": context_plan_hash,
        "requiredContextStatus": required_context_status,
        "governanceMode": governance_mode,
        "executionPosture": execution_posture,
        "blockedReason": None if required_context_status.get("valid") else _context_plan_message(required_context_status),
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
            "profile_snapshot_hash": req.run_context.profile_snapshot_hash,
            "profile_provider_resolutions": req.run_context.profile_provider_resolutions,
            "profile_effective_capabilities": req.run_context.effective_capabilities,
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
async def get_call(call_id: str, x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token")):
    _check_execute_read_service_token(x_service_token)
    rec = call_log.get_by_id(call_id)
    if not rec:
        raise HTTPException(status_code=404, detail="call not found")
    _assert_row_tenant_visible(rec)
    return rec


@router.get("/execute/calls")
async def list_calls(trace_id: Optional[str] = None,
                     workflow_run_id: Optional[str] = None,
                     tenant_id: Optional[str] = None,
                     limit: int = 50,
                     x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token")):
    _check_execute_read_service_token(x_service_token)
    eff_tenant = _resolve_read_tenant_scope(tenant_id)
    if trace_id:
        return {"items": call_log.list_by_trace(trace_id, limit, tenant_id=eff_tenant)}
    if workflow_run_id:
        return {"items": call_log.list_by_workflow(workflow_run_id, limit, tenant_id=eff_tenant)}
    return {"items": call_log.list_recent(limit, tenant_id=eff_tenant)}


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
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
):
    _check_execute_read_service_token(x_service_token)
    """List persisted MCP events.

    One of `trace_id` or `run_id` must be provided. `since_id` /
    `since_timestamp` give incremental polling: callers pass the most-recent
    id/timestamp they've seen and receive newer rows only.
    """
    if not trace_id and not run_id:
        raise HTTPException(status_code=400, detail="trace_id or run_id is required")
    eff_tenant = _resolve_read_tenant_scope(tenant_id)
    if trace_id:
        items = events_store.list_by_trace(trace_id, since_id=since_id,
                                           since_timestamp=since_timestamp, limit=limit,
                                           tenant_id=eff_tenant)
    else:
        items = events_store.list_by_run(run_id, limit=limit, tenant_id=eff_tenant)
    return {
        "trace_id": trace_id,
        "run_id": run_id,
        "tenant_id": eff_tenant,
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
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
):
    _check_execute_read_service_token(x_service_token)
    """Server-Sent Events stream — long-poll the events table for `trace_id`.

    Sends:
      - one `event:` per new row (data is JSON envelope)
      - heartbeat comment every poll_interval to keep proxies open
      - final `event: done` after `max_idle_seconds` of no new events
    """
    poll_interval = max(0.1, poll_interval_ms / 1000.0)
    # Resolve (and authorize) the tenant scope up front so a 403/400 surfaces on
    # the handshake rather than being swallowed inside the streaming generator.
    eff_tenant = _resolve_read_tenant_scope(tenant_id)

    async def gen():
        cursor_id = since_id
        idle_since = time.time()
        # First flush: anything already there for this trace.
        try:
            initial = events_store.list_by_trace(trace_id, since_id=cursor_id, limit=1000, tenant_id=eff_tenant)
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
                    trace_id, since_id=cursor_id, limit=200, tenant_id=eff_tenant,
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
async def get_event(event_id: str, x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token")):
    _check_execute_read_service_token(x_service_token)
    rec = events_store.get_by_id(event_id)
    if not rec:
        raise HTTPException(status_code=404, detail="event not found")
    _assert_row_tenant_visible(rec)
    return rec


@router.post("/execute/calls/{call_id}/refresh-events")
async def refresh_events_for_call(call_id: str, x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token")):
    _check_execute_read_service_token(x_service_token)
    """Re-drain events from the MCP server for an existing CallLog row.

    Useful when the original drain at /execute time missed events (network
    blip) or when ops wants to back-fill a trace.
    """
    rec = call_log.get_by_id(call_id)
    if not rec:
        raise HTTPException(status_code=404, detail="call not found")
    _assert_row_tenant_visible(rec)
    if not rec.get("mcp_server_id"):
        raise HTTPException(status_code=409, detail="call has no mcp_server_id (failed before MCP)")
    if not rec.get("trace_id"):
        raise HTTPException(status_code=409, detail="call has no trace_id")

    full = await _mcp_record_by_id(rec["mcp_server_id"])
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
async def execute_resume(req: ResumeRequest, x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token")):
    check_execute_service_token(x_service_token)
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

    if rec.get("pending_tool_name") == "context_plan_approval":
        pending_args = rec.get("pending_tool_args") or {}
        reason = str((pending_args or {}).get("reason") or "context plan approval required")
        if req.decision == "rejected":
            call_log.update_after_resume(rec["id"], {
                "status": "REJECTED",
                "finish_reason": "context_plan_approval_rejected",
                "final_response": req.reason or reason,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "error": req.reason or reason,
                "continuation_token": None,
                "pending_tool_name": None,
                "pending_tool_args": None,
            })
            emit_audit_event(
                kind="governance.context_approval.rejected",
                trace_id=rec.get("trace_id"),
                subject_type="CfCallLog",
                subject_id=rec["id"],
                capability_id=rec.get("capability_id"),
                severity="warn",
                payload={
                    "reason": req.reason or reason,
                    "context_plan_hash": pending_args.get("contextPlanHash"),
                    "required_context_status": pending_args.get("requiredContextStatus"),
                },
            )
            return {
                "status": "REJECTED",
                "finalResponse": req.reason or reason,
                "decision": req.decision,
                "correlation": {
                    "cfCallId": rec["id"],
                    "traceId": rec.get("trace_id"),
                    "sessionId": rec.get("session_id"),
                    "promptAssemblyId": rec.get("prompt_assembly_id"),
                    "llmCallIds": [],
                    "toolInvocationIds": [],
                    "artifactIds": [],
                    "codeChangeIds": [],
                },
                "tokensUsed": {"input": 0, "output": 0, "total": 0},
                "usage": _usage_metadata(
                    tokens_used={},
                    model_overrides={},
                    prompt_assembly_id=rec.get("prompt_assembly_id"),
                    cf_call_id=rec["id"],
                    optimization_metrics={},
                ),
                "modelUsage": {},
                "contextPlanHash": pending_args.get("contextPlanHash"),
                "requiredContextStatus": pending_args.get("requiredContextStatus"),
                "governanceMode": "human_approval_required",
                "executionPosture": "blocked",
                "blockedReason": req.reason or reason,
                "finishReason": "context_plan_approval_rejected",
                "stepsTaken": 0,
                "metrics": {},
                "pendingApproval": None,
            }

        original = pending_args.get("executeRequest")
        if not isinstance(original, dict):
            raise HTTPException(status_code=409, detail="context_plan_approval row has no saved executeRequest")
        approved_request = dict(original)
        approved_request["governance_mode"] = _governance_mode(
            approved_request.get("governance_mode") or settings.default_governance_mode,
            fallback=settings.default_governance_mode,
        )
        context_policy = dict(approved_request.get("context_policy") or {})
        context_policy["approvedContextPlanBypass"] = rec["id"]
        approved_request["context_policy"] = context_policy
        emit_audit_event(
            kind="governance.context_approval.approved",
            trace_id=rec.get("trace_id"),
            subject_type="CfCallLog",
            subject_id=rec["id"],
            capability_id=rec.get("capability_id"),
            severity="info",
            payload={
                "reason": req.reason,
                "context_plan_hash": pending_args.get("contextPlanHash"),
                "required_context_status": pending_args.get("requiredContextStatus"),
            },
        )
        call_log.update_after_resume(rec["id"], {
            "status": "APPROVED_RESUBMITTED",
            "finish_reason": "context_plan_approval_approved",
            "final_response": "Context plan approval granted; execution resubmitted.",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "continuation_token": None,
            "pending_tool_name": None,
            "pending_tool_args": None,
        })
        resumed = await execute(ExecuteRequest.model_validate(approved_request), x_service_token=x_service_token)
        if isinstance(resumed, dict):
            resumed["decision"] = req.decision
            resumed["approvedContextPlanCfCallId"] = rec["id"]
            resumed.setdefault("warnings", [])
            if isinstance(resumed["warnings"], list):
                resumed["warnings"].append(f"context plan approval {rec['id']} bypassed the missing context plan once")
        return resumed

    mcp_server_id = rec.get("mcp_server_id")
    if not mcp_server_id:
        raise HTTPException(status_code=409, detail="call has no mcp_server_id")
    trace_id = rec.get("trace_id")

    # Fetch the MCP credentials from IAM (cached service token).
    full = await _mcp_record_by_id(mcp_server_id)
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
        # M73-followup Slice 3 — share dispatch plumbing with /mcp/invoke
        # via mcp_dispatcher.dispatch_resume.
        mcp_resp = await _mcp_mod.dispatch_resume(
            mcp_base_url=mcp_base_url,
            mcp_bearer=mcp_bearer,
            payload=resume_payload,
            timeout_sec=240.0,
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
    actual_model_usage = mcp_data.get("modelUsage") or {}
    finish_reason = mcp_data.get("finishReason")
    steps_taken = mcp_data.get("stepsTaken")
    new_pending = mcp_data.get("pendingApproval")  # could pause again
    verification_receipts = mcp_data.get("verificationReceipts") or correlation.get("verificationReceipts") or []

    is_still_paused = new_status == "WAITING_APPROVAL"
    completed_at = datetime.now(timezone.utc).isoformat()
    usage = _usage_metadata(
        tokens_used=tokens_used,
        model_overrides={},
        actual_model_usage=actual_model_usage,
        prompt_assembly_id=rec.get("prompt_assembly_id"),
        cf_call_id=rec["id"],
        optimization_metrics={},
    )

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
        "estimated_cost": usage.get("estimatedCost"),
        "completed_at": None if is_still_paused else completed_at,
        "continuation_token": (new_pending or {}).get("continuation_token"),
        "pending_tool_name": (new_pending or {}).get("tool_name"),
        "pending_tool_args": (new_pending or {}).get("tool_args"),
    })
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
            "verificationReceipts": verification_receipts,
            "workspaceRoot": workspace.get("workspaceRoot"),
            "workspaceBranch": workspace.get("workspaceBranch"),
            "workspaceCommitSha": workspace.get("workspaceCommitSha"),
            "changedPaths": workspace.get("changedPaths") or [],
            "astIndexStatus": workspace.get("astIndexStatus"),
            "astIndexedFiles": workspace.get("astIndexedFiles"),
            "astIndexedSymbols": workspace.get("astIndexedSymbols"),
            # M56 — per-phase token + cost rollup from mcp-server. Drop-through
            # so the workbench's PhaseTokensStrip can read it off the attempt's
            # correlation without re-walking the audit ring.
            "phaseTokens": correlation.get("phaseTokens"),
            "codeChangeCoverage": correlation.get("codeChangeCoverage"),
            "verificationCoverage": correlation.get("verificationCoverage"),
        },
        "workspace": workspace,
        "verificationReceipts": verification_receipts,
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
            "promptCache": usage.get("promptCache"),
        },
        "promptCache": usage.get("promptCache"),
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
    os.environ.setdefault("CALL_LOG_DB", cl_db)
    call_log.DB_PATH = cl_db
    call_log.init_db()

    es_db = os.environ.get("EVENTS_STORE_DB", "./data/call_log_events.db")
    os.environ.setdefault("EVENTS_STORE_DB", es_db)
    events_store.DB_PATH = es_db
    events_store.init_db()


# ─────────────────────────────────────────────────────────────────────────────
# M71 Slice C(a) — Governance oracle endpoint.
#
# POST /api/v1/execute-governed
#
# The governed-loop equivalent of /execute for a single turn. The caller
# (workgraph-api today, the LLM wrapper from Slice C(b) later) supplies:
#
#   - current PhaseState (or null on the first turn — we mint a fresh PLAN)
#   - stage_key + agent_role so we can look up the StagePolicy
#   - tool_calls the LLM produced this turn (we hard-refuse out-of-phase ones)
#   - phase_output the LLM produced (we validate against the receipt schema)
#   - next_phase the LLM declared (we run the transition rules; refused if illegal)
#
# Response includes the next PhaseState (caller persists it), per-tool
# outcomes, and the validated receipt. The old /execute endpoint is
# untouched during this slice; Slice F switches workgraph-api to call this
# new endpoint, and Slice I removes /execute.
# ─────────────────────────────────────────────────────────────────────────────

from .governed import (  # noqa: E402  — keep near the endpoint that uses them
    GovernedStepResult,
    PhaseState,
    Phase,
    PolicyNotFoundError,
    governed_step,
)


class GovernedStepRequest(BaseModel):
    """Wire shape for /api/v1/execute-governed. Mirrors the loop.governed_step
    signature with permissive types so older callers can omit fields safely."""

    stage_key: str = Field(..., min_length=1)
    agent_role: Optional[str] = None
    # Either supply the previous state for resumes, or omit for a fresh stage.
    phase_state: Optional[dict[str, Any]] = None
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    phase_output: Optional[dict[str, Any]] = None
    # Declared next phase — used only when phase_output is also present.
    next_phase: Optional[str] = None
    # Trace / correlation. Mirrors the existing /execute RunContext fields
    # but isn't restricted to that schema so the LLM wrapper can pass extras.
    run_context: dict[str, Any] = Field(default_factory=dict)
    # Optional bearer override for the upstream mcp-server / prompt-composer
    # calls (e.g. workgraph-api wants to forward a session JWT). Defaults to
    # the env-loaded service token.
    bearer: Optional[str] = None


@router.post("/api/v1/execute-governed")
async def execute_governed(req: GovernedStepRequest, x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token")) -> dict[str, Any]:
    """Run one governed turn.

    Returns the result of `governed_step`, with the next PhaseState the
    caller is expected to persist before the next turn.
    """
    check_execute_service_token(x_service_token)
    # Construct or rehydrate the phase state.
    if req.phase_state:
        try:
            state = PhaseState.from_dict(req.phase_state)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail={"code": "PHASE_STATE_INVALID", "message": str(exc)},
            )
    else:
        state = PhaseState.fresh(req.stage_key, req.agent_role)

    next_phase_enum: Optional[Phase] = None
    if req.next_phase:
        try:
            next_phase_enum = Phase(req.next_phase)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail={"code": "PHASE_NAME_UNKNOWN", "message": str(exc)},
            )

    try:
        outcome: GovernedStepResult = await governed_step(
            state=state,
            stage_key=req.stage_key,
            agent_role=req.agent_role,
            tool_calls=req.tool_calls,
            phase_output=req.phase_output,
            next_phase=next_phase_enum,
            run_context=req.run_context,
            bearer=req.bearer,
        )
    except PolicyNotFoundError as exc:
        # No StagePolicy seeded for this (stage_key, role). Caller must
        # provision one in prompt-composer before the stage can run.
        raise HTTPException(
            status_code=404,
            detail={
                "code": "STAGE_POLICY_NOT_FOUND",
                "stage_key": req.stage_key,
                "agent_role": req.agent_role,
                "message": str(exc),
            },
        )

    return {"success": True, "data": outcome.to_dict()}


# ─────────────────────────────────────────────────────────────────────────────
# M71 Slice C(b) — Single-turn LLM-driven governed endpoint.
#
# POST /api/v1/execute-governed-turn
#
# Same governance guarantees as /api/v1/execute-governed, except this version
# also drives the LLM call. Per turn:
#
#   1. Load StagePolicy from prompt-composer.
#   2. Resolve the per-phase prompt (StagePromptBinding ladder).
#   3. POST llm-gateway /v1/chat/completions with tools = phase allowlist
#      plus the synthetic `submit_phase_output` meta-tool.
#   4. Parse tool_calls; split out submit_phase_output.
#   5. governed_step() — hard-refuse out-of-phase tools, dispatch allowed
#      tools via /mcp/tool-run, validate the phase output, advance the
#      state machine when valid.
#   6. Return next_state + tool_outcomes + LLM meta + prompt meta + policy
#      summary.
#
# The caller (workgraph-api today, Slice F) persists `next_state` and calls
# again until `step.phase_advanced` lands on FINALIZE, or
# `step.next_state.approval_pending=true` indicates SELF_REVIEW asked for
# human approval.
# ─────────────────────────────────────────────────────────────────────────────

from .governed import (  # noqa: E402
    LLMGatewayError,
    PromptNotFoundError,
    run_turn,
)


class GovernedTurnRequest(BaseModel):
    """Wire shape for /api/v1/execute-governed-turn."""

    stage_key: str = Field(..., min_length=1)
    agent_role: Optional[str] = None
    phase_state: Optional[dict[str, Any]] = None
    # Mustache vars for the per-phase prompt (goal, stageLabel, captured
    # decisions, prior approved artifacts, etc.). Passed verbatim to
    # prompt-composer's /resolve.
    vars: dict[str, Any] = Field(default_factory=dict)
    # OpenAI-style message history from prior turns in this phase. Empty
    # on the first turn. Caller manages the history shape; we splice it
    # after the system + user messages we compose from the prompt.
    history: list[dict[str, Any]] = Field(default_factory=list)
    # Optional model override; otherwise llm-gateway picks based on its
    # rate-card default.
    model_alias: Optional[str] = None
    # Optional bearer override for upstream (prompt-composer / llm-gateway
    # / mcp-server) calls. Lets workgraph-api forward a user JWT.
    bearer: Optional[str] = None
    run_context: dict[str, Any] = Field(default_factory=dict)
    # Capability Governance Model (G3) — resolved governance overlay (from IAM via
    # workgraph), threaded inline so CF compiles its advisory guidance into the
    # prompt. Absent ⇒ no governance context (legacy behavior).
    governance_overlay: Optional[dict[str, Any]] = None


@router.post("/api/v1/execute-governed-turn")
async def execute_governed_turn(req: GovernedTurnRequest, x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token")) -> dict[str, Any]:
    """Run one governed LLM turn."""
    check_execute_service_token(x_service_token)
    if req.phase_state:
        try:
            state = PhaseState.from_dict(req.phase_state)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail={"code": "PHASE_STATE_INVALID", "message": str(exc)},
            )
    else:
        state = PhaseState.fresh(req.stage_key, req.agent_role)

    try:
        turn = await run_turn(
            state=state,
            stage_key=req.stage_key,
            agent_role=req.agent_role,
            vars=req.vars,
            history=req.history,
            model_alias=req.model_alias,
            run_context=req.run_context,
            bearer=req.bearer,
            governance_overlay=req.governance_overlay,
        )
    except PolicyNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "STAGE_POLICY_NOT_FOUND",
                "stage_key": req.stage_key,
                "agent_role": req.agent_role,
                "message": str(exc),
            },
        )
    except PromptNotFoundError as exc:
        # The composer ladder fell all the way through. Either the caller
        # is asking for a stage we haven't seeded (loop.stage.foo with no
        # generic loop.stage default) or the seed wasn't applied.
        raise HTTPException(
            status_code=404,
            detail={
                "code": "STAGE_PROMPT_NOT_FOUND",
                "stage_key": req.stage_key,
                "agent_role": req.agent_role,
                "phase": state.current_phase.value,
                "message": str(exc),
            },
        )
    except LLMGatewayError as exc:
        # Surface the gateway's error_code so the caller (workgraph-api) can
        # route specific recoveries: timeout → maybe retry with longer
        # budget; rate-limit → back off; bad request → don't retry.
        raise HTTPException(
            status_code=502,
            detail={
                "code": exc.error_code,
                "upstream_status": exc.upstream_status,
                "message": str(exc),
            },
        )

    return {"success": True, "data": turn.to_dict()}


# ─────────────────────────────────────────────────────────────────────────────
# Compose a Copilot stage prompt WITHOUT executing it (copilot-handoff export).
#
# workgraph-api's copilot-handoff export calls this once per not-yet-run phase so
# the exported YAML carries the SAME composed prompt (agent role + repo world
# model + work-item description + task) the governed run would feed `copilot -p`.
# A developer can then continue the SDLC on their own Copilot CLI, outside the
# platform, with identical grounding. Best-effort: the world model is omitted if
# the repo/MCP isn't reachable (mirrors run_stage_via_copilot).
# ─────────────────────────────────────────────────────────────────────────────
class ComposeCopilotPromptRequest(BaseModel):
    task: str
    stage_key: Optional[str] = None
    agent_role: Optional[str] = None
    capability_id: Optional[str] = None
    vars: Optional[dict[str, Any]] = None
    run_context: Optional[dict[str, Any]] = None


@router.post("/api/v1/compose-copilot-prompt")
async def compose_copilot_prompt_endpoint(
    req: ComposeCopilotPromptRequest,
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
):
    check_execute_service_token(x_service_token)
    # Authorize the requested tenant against the token's tenant scope BEFORE
    # grounding a prompt in (or dispatching a code-context build for) a
    # capability's repo. Mirrors the /execute read-endpoint hardening: a global
    # token (default deploy) is unchanged; a tenant-scoped token can only
    # compose within its own tenant(s) — raises 403/400 otherwise.
    run_context = dict(req.run_context or {})
    eff_tenant = _resolve_read_tenant_scope(run_context.get("tenant_id") or run_context.get("tenantId"))
    if eff_tenant:
        run_context["tenant_id"] = eff_tenant
    from .governed.copilot_executor import compose_copilot_prompt, interpolate_task
    resolved = interpolate_task(req.task, req.vars)
    degraded = False
    warning: Optional[str] = None
    try:
        prompt = await compose_copilot_prompt(
            stage_key=req.stage_key,
            agent_role=req.agent_role,
            capability_id=req.capability_id,
            resolved_task=resolved,
            vars=req.vars,
            run_context=run_context,
            bearer=None,
        )
    except Exception as exc:  # never fail the export — fall back to the raw task
        import logging
        logging.getLogger("context_api.compose_copilot").warning("compose-copilot-prompt failed: %s", exc)
        prompt = resolved
        # Finding #11 — report the fallback instead of returning it as a clean success, so
        # the caller can warn the user the handoff lacks composed context.
        degraded = True
        warning = f"prompt composition failed: {exc}"
    if not prompt or not str(prompt).strip():
        prompt = resolved
        degraded = True
        warning = warning or "composer produced an empty prompt; using raw task"
    return {"prompt": prompt or resolved, "resolved_task": resolved, "degraded": degraded, "warning": warning}


# ─────────────────────────────────────────────────────────────────────────────
# M71 Slice F — Multi-turn governed stage endpoint.
#
# POST /api/v1/execute-governed-stage
#
# workgraph-api calls this ONCE to run an entire stage from PLAN through to
# FINALIZE (or to the human-approval gate at SELF_REVIEW). context-fabric
# drives the LLM loop server-side, threading history forward, so workgraph-
# api doesn't need to keep state between turns.
#
# Halt conditions (see stage_driver.run_stage):
#   * FINALIZED          — phase reached FINALIZE
#   * APPROVAL_PENDING   — SELF_REVIEW set recommended_for_approval=true
#   * VALIDATION_BLOCKED — LLM submitted a malformed receipt
#   * POLICY_BLOCKED     — LLM stuck calling refused tools
#   * MAX_TURNS          — safety cap
#   * LLM_ERROR          — timeout / overloaded / etc.
#
# This is the endpoint Slice F switches workgraph-api to call instead of
# the legacy /execute → mcp-server /invoke chain.
# ─────────────────────────────────────────────────────────────────────────────

from .governed import (  # noqa: E402
    DEFAULT_MAX_TURNS,
    StageRunResult,
    run_stage,
)


class GovernedStageRequest(BaseModel):
    """Wire shape for /api/v1/execute-governed-stage."""

    stage_key: str = Field(..., min_length=1)
    agent_role: Optional[str] = None
    phase_state: Optional[dict[str, Any]] = None
    vars: dict[str, Any] = Field(default_factory=dict)
    initial_history: list[dict[str, Any]] = Field(default_factory=list)
    model_alias: Optional[str] = None
    # M100 — per-phase model override. Maps a governed Phase value
    # (PLAN/EXPLORE/ACT/VERIFY/REPAIR/SELF_REVIEW/FINALIZE) → model alias.
    # The current phase's entry wins over `model_alias`; unset/unknown
    # phases fall back to `model_alias`, then the gateway default. Omitted
    # (None) preserves the single-model-per-stage behavior (back-compat).
    phase_model_aliases: Optional[dict[str, str]] = None
    bearer: Optional[str] = None
    run_context: dict[str, Any] = Field(default_factory=dict)
    # Safety cap on the number of LLM turns this call may consume. Defaults
    # to the module constant; callers can pass a lower number for thin runs.
    max_turns: int = Field(default=DEFAULT_MAX_TURNS, ge=1, le=200)
    # M91.A — workflow-resolved policy. When the caller (workgraph-api)
    # has resolved the workflow's stage intent (tool_policy / repo_access /
    # context_policy / prompt_profile_key from workflow_design_nodes.config)
    # it ships them here as a structured field. CF uses this to override
    # the DB-seeded StagePolicy's per-phase allowed_tools. Optional —
    # legacy callers omitting this get the unfiltered base policy
    # (back-compat).
    stage_execution_policy: Optional[dict[str, Any]] = None
    # Capability Governance Model (G4) — resolved governance overlay (from IAM via
    # workgraph) + the active waiver control keys for this run. When the overlay is
    # BLOCKING/REQUIRED, the enforcement gate halts promotion with GOVERNANCE_BLOCKED
    # unless controls are satisfied or waived. Absent/ADVISORY ⇒ no enforcement.
    governance_overlay: Optional[dict[str, Any]] = None
    governance_waivers: Optional[list[str]] = None
    # Laptop bridge requirement (parity with legacy /execute). True ⇒ this stage
    # MUST run on the user's laptop mcp-server; if no live bridge, fail fast with
    # 503 MCP_NOT_CONNECTED instead of silently using the shared runtime. May also
    # be supplied via run_context["prefer_laptop"] (what loop.py dispatch reads).
    prefer_laptop: Optional[bool] = None
    # Correlation/dedup passthrough — shape parity with the legacy ExecuteRequest.
    # (Neither path performs hard dedup today; carried for tracing + so the
    # contracts replay path can thread it through after its Phase-4 migration.)
    idempotency_key: Optional[str] = None
    # Human-approval-gate resume. When resuming a stage paused at APPROVAL_PENDING
    # (SELF_REVIEW), the caller passes the persisted phase_state PLUS a decision:
    #   "approved"  → drive SELF_REVIEW → FINALIZE (the loop then runs the
    #                 FINALIZE turn: finish_work_branch / git push).
    #   "rejected"/"changes_requested" → drive SELF_REVIEW → REPAIR, with `reason`
    #                 surfaced to the agent as eval_feedback for the rework.
    # Omitted ⇒ plain continuation (back-compat). args_override is accepted for
    # legacy /execute/resume shape parity (governed pauses at a phase, not a tool,
    # so it is currently a no-op on this path).
    decision: Optional[str] = None
    reason: Optional[str] = None
    args_override: Optional[dict[str, Any]] = None


# In-process idempotency guard for governed stages. A duplicate request carrying
# the same idempotency_key (e.g. a workgraph retry after a transient client
# disconnect) awaits the in-flight run and returns its result instead of
# launching a SECOND governed loop — which would duplicate LLM cost and tool
# side effects. In-memory / single-instance by design (the POC runs one CF
# replica); a cross-replica guard (call_log lookup keyed on idempotency_key) is
# the multi-instance follow-up.
_inflight_governed_stages: dict[str, "asyncio.Future[dict[str, Any]]"] = {}


@router.post("/api/v1/execute-governed-stage")
async def execute_governed_stage(req: GovernedStageRequest, x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token")) -> dict[str, Any]:
    key = (req.idempotency_key or "").strip()
    if not key:
        return await _execute_governed_stage_impl(req, x_service_token)
    existing = _inflight_governed_stages.get(key)
    if existing is not None:
        logging.getLogger("context_api.governed").warning(
            "execute-governed-stage idempotency hit; awaiting in-flight run for key=%s", key,
        )
        return await existing
    fut: "asyncio.Future[dict[str, Any]]" = asyncio.get_event_loop().create_future()
    _inflight_governed_stages[key] = fut
    try:
        res = await _execute_governed_stage_impl(req, x_service_token)
        if not fut.done():
            fut.set_result(res)
        return res
    except BaseException as exc:
        if not fut.done():
            fut.set_exception(exc)
        raise
    finally:
        _inflight_governed_stages.pop(key, None)


async def _execute_governed_stage_impl(req: GovernedStageRequest, x_service_token: Optional[str] = None) -> dict[str, Any]:
    """Run a governed stage end-to-end (multi-turn)."""
    check_execute_service_token(x_service_token)
    # Laptop preflight — when the caller requires the user's laptop bridge but no
    # live bridge is connected, refuse rather than silently falling back to the
    # managed HTTP runtime (governed dispatch.py would otherwise do a silent
    # fallback, running governed tools on the shared runtime in hybrid mode).
    _gov_run_ctx = req.run_context or {}
    _gov_prefer_laptop = req.prefer_laptop
    if _gov_prefer_laptop is None:
        _gov_prefer_laptop = _gov_run_ctx.get("prefer_laptop")
    _gov_user_id = _gov_run_ctx.get("user_id") or _gov_run_ctx.get("userId")
    if _gov_prefer_laptop is True and _gov_user_id:
        _use_laptop, _, _ = await _laptop_mod.resolve_laptop_target(
            user_id=str(_gov_user_id),
            prefer_laptop=True,
        )
        if not _use_laptop:
            raise HTTPException(status_code=503, detail={
                "code": "MCP_NOT_CONNECTED",
                "message": "Your laptop mcp-server is not connected. Run `singularity-mcp start` and retry.",
                "user_id": str(_gov_user_id),
            })

    _agent_template_id = (
        _gov_run_ctx.get("agent_template_id")
        or _gov_run_ctx.get("agentTemplateId")
        or _gov_run_ctx.get("agentId")
    )
    try:
        _effective_caps, _profile_snapshot_hash, _profile_provider_resolutions = await _resolve_agent_profile_capabilities(
            str(_agent_template_id) if _agent_template_id else None,
            _gov_run_ctx.get("effective_capabilities") or _gov_run_ctx.get("effectiveCapabilities"),
            _gov_run_ctx.get("profile_snapshot_hash") or _gov_run_ctx.get("profileSnapshotHash"),
            _gov_run_ctx.get("profile_provider_resolutions") or _gov_run_ctx.get("profileProviderResolutions"),
        )
        if _agent_template_id or _effective_caps:
            req.run_context = {
                **_gov_run_ctx,
                "effective_capabilities": _effective_caps,
                "effectiveCapabilities": _effective_caps,
                "effective_capabilities_required": bool(_agent_template_id),
                "effectiveCapabilitiesRequired": bool(_agent_template_id),
                "profile_snapshot_hash": _profile_snapshot_hash,
                "profileSnapshotHash": _profile_snapshot_hash,
                "profile_provider_resolutions": _profile_provider_resolutions,
                "profileProviderResolutions": _profile_provider_resolutions,
            }
    except Exception as exc:
        if _agent_template_id:
            req.run_context = {
                **_gov_run_ctx,
                "effective_capabilities": [],
                "effectiveCapabilities": [],
                "effective_capabilities_required": True,
                "effectiveCapabilitiesRequired": True,
                "profile_resolution_warning": f"agent profile resolution unavailable: {exc!s}",
            }
        else:
            # Legacy governed stages without profile identity retain the
            # historical stage-policy gate.
            req.run_context = {
                **_gov_run_ctx,
                "profile_resolution_warning": f"agent profile resolution unavailable: {exc!s}",
            }

    if req.phase_state:
        try:
            state = PhaseState.from_dict(req.phase_state)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail={"code": "PHASE_STATE_INVALID", "message": str(exc)},
            )
    else:
        state = PhaseState.fresh(req.stage_key, req.agent_role)

    # Human-approval-gate resume — apply the operator's decision to a paused
    # (APPROVAL_PENDING) state before the loop runs. approved → SELF_REVIEW →
    # FINALIZE (loop then runs the FINALIZE turn); rejected/changes → SELF_REVIEW
    # → REPAIR with the reason as eval_feedback. If the REPAIR cap is exhausted,
    # leave the state paused (re-surfaces APPROVAL_PENDING) rather than erroring.
    if req.decision:
        from .governed.phase_state import apply_approval_decision as _apply_decision
        _was_paused = state.approval_pending and state.current_phase is Phase.SELF_REVIEW
        state = _apply_decision(state, req.decision)
        # On a rework decision that actually transitioned to REPAIR, surface the
        # operator's reason to the agent as eval_feedback for the next attempt.
        if _was_paused and req.reason and state.current_phase is Phase.REPAIR:
            req.vars = {**(req.vars or {}), "eval_feedback": str(req.reason)}

    # M83.r — Anthropic extended thinking ("deep reasoning"). Default
    # via env DEEP_REASONING_BUDGET_TOKENS (0 = off). Operators can
    # set 4096-8192 globally; per-stage tuning will land later via
    # StagePolicy.limits.thinking_budget. Today we apply the same
    # default to every stage so operators see the reasoning trail in
    # the workbench's LoopTrace overlay without per-stage config.
    import os as _os
    try:
        _thinking_budget = int(_os.environ.get("DEEP_REASONING_BUDGET_TOKENS", "0"))
    except ValueError:
        _thinking_budget = 0
    if _thinking_budget < 0:
        _thinking_budget = 0

    # M91.A — parse incoming StageExecutionPolicy (if provided) into
    # the Pydantic model.
    #
    # M93.E (2026-05-27) — Loud failure on malformed policy. Pre-M93.E
    # we swallowed the validation error, logged a warning, and silently
    # proceeded with the unfiltered DB-seeded policy. That made bad
    # policy look like it worked: the operator got a 200 from the
    # endpoint while the workflow's tool_policy / repo_access pinning
    # was ignored at runtime. Now we 400 with the per-field Pydantic
    # error so callers see the shape they got wrong. The check is
    # cheap (Pydantic validate of a small model) and runs before any
    # side-effect, so there's nothing to roll back.
    _exec_policy = None
    if req.stage_execution_policy is not None:
        from pydantic import ValidationError as _PydanticValidationError
        from .governed.stage_execution_policy import StageExecutionPolicy as _SEP
        try:
            _exec_policy = _SEP.model_validate(req.stage_execution_policy)
        except _PydanticValidationError as _exc:
            details = [
                {
                    "field": ".".join(str(p) for p in err.get("loc", [])) or "<root>",
                    "issue": err.get("msg", "invalid"),
                    "type": err.get("type", "value_error"),
                }
                for err in _exc.errors()
            ]
            raise HTTPException(
                status_code=400,
                detail={
                    "error_code": "STAGE_EXECUTION_POLICY_INVALID",
                    "message": (
                        "stage_execution_policy failed Pydantic validation. "
                        "Fix the listed fields and resend; CF will not silently "
                        "fall back to the DB-seeded policy because that hides "
                        "the workflow's tool/repo pinning from runtime."
                    ),
                    "details": details,
                },
            )

    # §13.4 — copilot-mode phase. CF dispatches the `copilot_execute` tool to
    # mcp-server (laptop-routed when run_context.user_id has a live bridge)
    # instead of running the function-calling loop: the Copilot CLI returns
    # text, not tool_calls, so there is no loop to run. mcp-server runs
    # `copilot -p --allow-all` in the work-item workspace and we wrap the
    # {summary, diff, changedPaths} receipt as a FINALIZED stage result.
    # NOTE: this route is /execute-governed-stage, whose run_context is a plain
    # dict (not the RunContext model) and which has no top-level `task`. The
    # workflow AGENT_TASK passes both `executor` and `task` THROUGH run_context
    # (governed-execute-adapter copies run_context verbatim), so read them as
    # dict keys here and interpolate {{instance.vars.*}} against req.vars.
    _rc = req.run_context if isinstance(req.run_context, dict) else {}
    if str(_rc.get("executor") or "").strip().lower() == "copilot":
        from .governed.copilot_executor import run_stage_via_copilot

        outcome = await run_stage_via_copilot(
            state,
            task=str(_rc.get("task") or ""),
            vars=req.vars,
            stage_key=req.stage_key,
            agent_role=req.agent_role,
            capability_id=_rc.get("capability_id"),
            work_item_id=_rc.get("work_item_id"),
            run_context=_rc,
            laptop_user_id=_rc.get("user_id"),
            bearer=req.bearer,
        )
        return {"success": True, "data": outcome.to_dict()}

    try:
        outcome: StageRunResult = await run_stage(
            state=state,
            stage_key=req.stage_key,
            agent_role=req.agent_role,
            vars=req.vars,
            initial_history=req.initial_history,
            model_alias=req.model_alias,
            phase_model_aliases=req.phase_model_aliases,
            run_context=req.run_context,
            bearer=req.bearer,
            max_turns=req.max_turns,
            thinking_budget=_thinking_budget or None,
            exec_policy=_exec_policy,
            governance_overlay=req.governance_overlay,
            governance_waivers=req.governance_waivers,
        )
    except PolicyNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "STAGE_POLICY_NOT_FOUND", "message": str(exc)},
        )
    except PromptNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "STAGE_PROMPT_NOT_FOUND", "message": str(exc)},
        )

    return {"success": True, "data": outcome.to_dict()}


# ──────────────────────────────────────────────────────────────────────────
# Governed SINGLE-TURN execution
# ──────────────────────────────────────────────────────────────────────────
# The governed STAGE loop (above) re-assembles the prompt per-phase via
# prompt-composer and runs PLAN→…→FINALIZE. That's correct for coding/agent
# stages, but WRONG for single-shot callers that already hold the exact prompt
# they want executed once:
#   • prompt-composer compose-and-respond — has the fully assembled prompt; the
#     stage loop would discard it (re-assemble) and create a composer↔CF cycle.
#   • contracts replay — needs the FROZEN bundle prompt executed verbatim for
#     determinism; per-phase re-assembly would invalidate the replay.
#   • event-horizon chat — a one-shot Q&A with a provided system prompt.
# This endpoint gives those callers the governed audit trail + governance-overlay
# record + 'governed' posture WITHOUT the multi-phase machine: one gateway turn
# with the caller's prompt verbatim. (A single LLM turn dispatches no tools, so
# there is no tool-policy/evidence gate to enforce — the overlay is recorded for
# the audit-gov trail; G4 hard-blocking remains a stage-loop concern.)
# NOTE: distinct from the older /api/v1/execute-governed-turn (phase-machine
# single turn — requires stage_key + resolves policy/prompt + run_turn). THIS is
# the verbatim-prompt single turn, so it lives at a SEPARATE path + class to
# avoid clobbering that route (and its request model).
class GovernedSingleTurnRequest(BaseModel):
    trace_id: Optional[str] = None
    idempotency_key: Optional[str] = None
    run_context: Optional[dict[str, Any]] = None
    # Caller-supplied prompt, used VERBATIM (the whole point — no re-assembly).
    system_prompt: str = ""
    task: str
    model_overrides: Optional[dict[str, Any]] = None  # {modelAlias, provider/model expectations, temperature, maxOutputTokens}
    limits: Optional[dict[str, Any]] = None
    governance_overlay: Optional[dict[str, Any]] = None
    governance_waivers: Optional[list[str]] = None
    governance_mode: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("governance_mode", "governanceMode"),
    )


@router.post("/api/v1/execute-governed-single-turn")
async def execute_governed_single_turn(req: GovernedSingleTurnRequest, x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token")) -> dict[str, Any]:
    check_execute_service_token(x_service_token)
    from .governed.llm_client import call_gateway_chat
    from .governed.placement import llm_laptop_target, runtime_capability_tags, runtime_tenant_target

    rc = req.run_context or {}
    trace_id = req.trace_id or rc.get("trace_id")
    cap = rc.get("capability_id") or rc.get("capabilityId")
    overlay = req.governance_overlay if isinstance(req.governance_overlay, dict) else None
    overlay_hash = overlay.get("overlayHash") if overlay else None
    mo = req.model_overrides or {}
    limits = req.limits or {}
    governance_mode = _governance_mode(
        req.governance_mode
        or rc.get("governance_mode")
        or rc.get("governanceMode")
        or settings.default_governance_mode,
        fallback=settings.default_governance_mode,
    )

    messages: list[dict[str, Any]] = []
    if req.system_prompt and req.system_prompt.strip():
        messages.append({"role": "system", "content": req.system_prompt})
    messages.append({"role": "user", "content": req.task})

    try:
        resp = await call_gateway_chat(
            messages=messages,
            model_alias=mo.get("modelAlias") or mo.get("model_alias"),
            expected_provider=mo.get("expectedProvider") or mo.get("expected_provider") or mo.get("provider"),
            expected_model=mo.get("expectedModel") or mo.get("expected_model") or mo.get("model"),
            temperature=mo.get("temperature"),
            max_output_tokens=(
                mo.get("maxOutputTokens")
                or mo.get("max_output_tokens")
                or limits.get("outputTokenBudget")
            ),
            # Placement: route this single turn to the launching user's laptop
            # when the run opted into laptop LLM and a laptop is serving model-run;
            # otherwise the cloud gateway. Mirrors turn.py:920. See placement.py.
            laptop_user_id=llm_laptop_target(rc),
            runtime_tenant_id=runtime_tenant_target(rc),
            runtime_capability_tags=runtime_capability_tags(rc),
        )
    except LLMGatewayError as exc:
        emit_audit_event(
            kind="governed.turn_failed", trace_id=trace_id, capability_id=cap,
            subject_type="governed_turn", severity="error",
            payload={"posture": "governed_turn", "overlayHash": overlay_hash, "error": str(exc)},
        )
        raise HTTPException(status_code=502, detail={"code": "LLM_ERROR", "message": str(exc)})

    emit_audit_event(
        kind="governed.turn_completed", trace_id=trace_id, capability_id=cap,
        subject_type="governed_turn",
        payload={
            "posture": "governed_turn",
            "overlayHash": overlay_hash,
            "governanceMode": governance_mode,
            "governanceOverlay": overlay,
            "governanceWaivers": req.governance_waivers,
            "provider": resp.provider, "model": resp.model, "modelAlias": resp.model_alias,
            "inputTokens": resp.input_tokens, "outputTokens": resp.output_tokens,
        },
    )

    total_tokens = resp.input_tokens + resp.output_tokens
    usage = {
        "modelAlias": resp.model_alias, "provider": resp.provider, "model": resp.model,
        "inputTokens": resp.input_tokens, "outputTokens": resp.output_tokens,
        "totalTokens": total_tokens, "estimatedCost": resp.estimated_cost or 0,
    }
    return {
        "status": "COMPLETED",
        "finalResponse": resp.content,
        "finishReason": resp.finish_reason,
        "correlation": {
            "cfCallId": f"governed-turn:{trace_id}",
            "traceId": trace_id,
            "modelAlias": resp.model_alias,
            "governanceMode": governance_mode,
            "executionPosture": "governed",
            "llmCallIds": [], "toolInvocationIds": [], "artifactIds": [], "codeChangeIds": [],
        },
        "tokensUsed": {"input": resp.input_tokens, "output": resp.output_tokens, "total": total_tokens},
        "usage": usage,
        "modelUsage": usage,
        "warnings": [],
        "pendingApproval": None,
    }
