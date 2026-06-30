"""
Internal MCP routes (M6).

Exposes a small, service-token-protected surface that the (future) MCP servers
and downstream services use to look up MCP-server registrations. Backed by
IAM's `mcp_servers` table — context-fabric is the only caller IAM has to
trust for cross-capability reads, so we centralise the lookup here.

Endpoints:
  GET /internal/mcp/servers?capability_id=<id>&status=active

Auth:
  All endpoints require `X-Service-Token: <iam-jwt>` matching the value in
  config.iam_service_token. v0 accepts a static admin JWT pasted into env;
  v1 should issue short-lived service tokens from IAM.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from .config import settings
from .git_broker import broker_git_credential
from .governed.grant import grant_enabled, mint_tool_grant
from .governed.phase_state import Phase
from .governed.policy_loader import PhasePolicy, StagePolicy
from .iam_service_token import get_iam_service_token, invalidate_iam_service_token

log = logging.getLogger(__name__)


router = APIRouter(prefix="/internal/mcp", tags=["internal-mcp"])


class ServerToolCallRequest(BaseModel):
    traceId: Optional[str] = None
    capabilityId: Optional[str] = None
    agentId: Optional[str] = None
    agentUid: Optional[str] = None
    sessionId: Optional[str] = None
    workflowInstanceId: Optional[str] = None
    nodeId: Optional[str] = None
    workItemId: Optional[str] = None
    toolName: Optional[str] = None
    toolVersion: Optional[str] = None
    approvalId: Optional[str] = None
    requestedCapabilityId: Optional[str] = None
    requestedPermission: Optional[str] = None
    effectiveCapabilities: list[dict[str, Any]] = Field(default_factory=list)
    args: dict[str, Any] = Field(default_factory=dict)


class OperationalToolGrantRequest(BaseModel):
    toolName: str
    args: dict[str, Any] = Field(default_factory=dict)
    runContext: dict[str, Any] = Field(default_factory=dict)
    workflowPolicy: dict[str, Any] = Field(default_factory=dict)


def _check_service_token(provided: Optional[str]) -> None:
    expected = settings.iam_service_token
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="IAM_SERVICE_TOKEN is not configured on context-fabric",
        )
    if not provided or provided != expected:
        raise HTTPException(status_code=401, detail="invalid service token")


_OPERATIONAL_TOOL_PHASES: dict[str, Phase] = {
    "finish_work_branch": Phase.FINALIZE,
    "run_python": Phase.ACT,
}

# Git tools that also get a brokered, repo-scoped credential alongside the grant
# (P0 #2, slice B). toolName → git operation.
_GIT_TOOL_OPERATIONS: dict[str, str] = {
    "finish_work_branch": "push",
}


async def _maybe_broker_git_credential(
    body: "OperationalToolGrantRequest", grant: Optional[dict[str, Any]]
) -> Optional[dict[str, Any]]:
    """When the Git broker is enabled and this is a git op with a resolvable repo,
    ask IAM to mint a short-lived, repo-scoped credential bound to the grant nonce.

    Best-effort during rollout: returns None (and logs) on any miss — the grant
    still flows. Slice C makes a SHARED mcp REQUIRE this credential for git ops;
    the repo/tenant/user come from run_context (Slice D wires Workgraph to supply
    them), so until then this stays dormant even with the flag on.

    The IAM-call logic now lives in git_broker.broker_git_credential so the
    code-context dispatch path (P0 #2 clone injection) can reuse it without an
    import cycle. This wrapper just maps the tool name → git operation.
    """
    operation = _GIT_TOOL_OPERATIONS.get(body.toolName)
    if not operation:
        return None
    return await broker_git_credential(body.runContext, operation, (grant or {}).get("nonce"))


def _require_nonempty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status_code=400, detail=f"{field} is required")
    return value.strip()


def _operational_policy_for(tool_name: str, body: OperationalToolGrantRequest) -> tuple[StagePolicy, Phase]:
    phase = _OPERATIONAL_TOOL_PHASES.get(tool_name)
    if phase is None:
        raise HTTPException(status_code=403, detail=f"operational grants are not available for tool {tool_name!r}")

    run_context = body.runContext or {}
    workflow_policy = body.workflowPolicy or {}
    workflow_instance_id = _require_nonempty_string(
        run_context.get("workflowInstanceId") or run_context.get("workflow_instance_id") or run_context.get("runId"),
        "runContext.workflowInstanceId",
    )
    node_id = _require_nonempty_string(
        run_context.get("nodeId") or run_context.get("node_id") or run_context.get("runStepId"),
        "runContext.nodeId",
    )
    _require_nonempty_string(run_context.get("traceId") or run_context.get("trace_id"), "runContext.traceId")

    if tool_name == "finish_work_branch":
        approval_status = str(workflow_policy.get("approvalStatus") or "")
        if approval_status not in {"APPROVED", "APPROVED_WITH_CONDITIONS"}:
            raise HTTPException(
                status_code=403,
                detail="finish_work_branch operational grant requires an approved workflow approval gate",
            )
        if body.args.get("push") is not True:
            raise HTTPException(status_code=403, detail="finish_work_branch operational grant is only issued for push=true")

    if tool_name == "run_python":
        _require_nonempty_string(body.args.get("code"), "args.code")
        if body.args.get("allow_network") is True and workflow_policy.get("allowNetwork") is not True:
            raise HTTPException(
                status_code=403,
                detail="run_python network access requires workflowPolicy.allowNetwork=true",
            )

    stage_key = str(
        workflow_policy.get("stageKey")
        or workflow_policy.get("nodeType")
        or f"workflow:{node_id}"
    )
    phase_policy = PhasePolicy(
        phase=phase,
        allowed_tools=frozenset({tool_name}),
        forbidden_tools=frozenset(),
        required_output_schema={},
        max_input_tokens=None,
        max_output_tokens=None,
        max_tool_calls=1,
    )
    policy = StagePolicy(
        policy_id=f"context-fabric.operational.{tool_name}",
        stage_key=stage_key,
        agent_role="workflow-runtime",
        version=1,
        status="ACTIVE",
        approval_model={
            "source": "workgraph-runtime",
            "approvalStatus": workflow_policy.get("approvalStatus"),
        },
        limits={"max_tool_calls": 1},
        context_policy={},
        edit_policy={},
        verification_policy={},
        risk_policy={
            "workflowInstanceId": workflow_instance_id,
            "nodeId": node_id,
            "source": "operational-mcp-grant",
        },
        phases={phase: phase_policy},
    )
    return policy, phase


async def _iam_get(url: str, params: Optional[dict[str, str]] = None, timeout: float = 10.0) -> httpx.Response:
    token = await get_iam_service_token()
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, params=params, headers={"Authorization": f"Bearer {token or ''}"})
        if resp.status_code != 401:
            return resp
    invalidate_iam_service_token()
    token = await get_iam_service_token()
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.get(url, params=params, headers={"Authorization": f"Bearer {token or ''}"})


@router.post("/tool-grants")
async def mint_operational_tool_grant(
    body: OperationalToolGrantRequest,
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
):
    """Mint a one-shot MCP ToolInvocationGrant for deterministic workflow tools.

    Workgraph owns workflow state and human approval records; Context Fabric owns
    the signing key and final grant policy. This endpoint is deliberately narrow:
    it only signs the deterministic MCP tools listed in `_OPERATIONAL_TOOL_PHASES`
    after the request presents enough workflow identity and policy evidence.
    """
    _check_service_token(x_service_token)
    policy, phase = _operational_policy_for(body.toolName, body)
    if not grant_enabled():
        return {
            "grant": None,
            "grantEnabled": False,
            "toolName": body.toolName,
            "policyId": policy.policy_id,
            "phase": phase.value,
        }
    grant = mint_tool_grant(
        policy=policy,
        phase=phase,
        tool_name=body.toolName,
        args=body.args,
        run_context=body.runContext,
    )
    if grant is None:
        raise HTTPException(status_code=503, detail="tool grant minting is enabled but no grant could be minted")
    git_credential = await _maybe_broker_git_credential(body, grant)
    return {
        "grant": grant,
        "grantEnabled": True,
        "toolName": body.toolName,
        "policyId": policy.policy_id,
        "phase": phase.value,
        "gitCredential": git_credential,
    }


@router.post("/tools/{tool_name}/call")
async def call_server_tool(
    tool_name: str,
    body: ServerToolCallRequest,
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
):
    """Execute a SERVER-target tool through tool-service.

    MCP owns the agent loop, but SERVER tools stay behind Context Fabric so
    tool-service policy, approvals, and receipts remain centralized.
    """
    _check_service_token(x_service_token)

    capability_id = body.capabilityId
    if not capability_id:
        raise HTTPException(status_code=400, detail="capabilityId is required for SERVER tools")
    agent_uid = body.agentUid or body.agentId or f"{capability_id}:mcp-agent"
    payload = {
        "capability_id": capability_id,
        "agent_uid": agent_uid,
        "agent_id": body.agentId,
        "session_id": body.sessionId,
        "workflow_id": body.workflowInstanceId,
        "task_id": body.workItemId or body.nodeId,
        "tool_name": body.toolName or tool_name,
        "tool_version": body.toolVersion,
        "approval_id": body.approvalId,
        "requested_capability_id": body.requestedCapabilityId,
        "requested_permission": body.requestedPermission,
        "effective_capabilities": body.effectiveCapabilities,
        "arguments": body.args,
        "context_package_id": None,
    }

    service_jwt = await get_iam_service_token()
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await client.post(
                f"{settings.tool_service_url.rstrip('/')}/api/v1/tools/invoke",
                json=payload,
                headers={
                    "X-Trace-Id": body.traceId or "",
                    "Authorization": f"Bearer {service_jwt or ''}",
                },
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"tool-service unreachable: {exc}")

    text = resp.text
    parsed: Any
    try:
        parsed = resp.json()
    except Exception:
        parsed = {"status": "error", "error": text[:1000]}
    if resp.status_code >= 500:
        raise HTTPException(status_code=502, detail=f"tool-service returned {resp.status_code}: {text[:500]}")
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=parsed)
    if isinstance(parsed, dict):
        parsed["receipt"] = {
            "kind": "delegation_receipt",
            "from": "context-fabric",
            "to": "tool-service",
            "toolName": body.toolName or tool_name,
            "toolVersion": body.toolVersion,
            "status": parsed.get("status"),
            "toolExecutionId": parsed.get("tool_execution_id"),
            "traceId": body.traceId,
        }
    return parsed


@router.get("/servers")
async def list_mcp_servers_for_capability(
    capability_id: str = Query(..., description="UUID of the capability (iam.capabilities.id)"),
    status: Optional[str] = Query(default="active"),
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
):
    """Resolve the MCP servers registered for a capability.

    Calls IAM `GET /capabilities/{cap_id}/mcp-servers` with the configured
    service bearer token, then optionally filters by status. Returns the
    redacted list (no bearer tokens). Use `/internal/mcp/servers/{id}` to
    fetch the full record including the bearer for the actual MCP call.
    """
    _check_service_token(x_service_token)

    url = f"{settings.iam_base_url.rstrip('/')}/capabilities/{capability_id}/mcp-servers"
    params: dict[str, str] = {}
    if status:
        params["status"] = status

    try:
        resp = await _iam_get(url, params=params, timeout=10.0)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"IAM unreachable: {exc}")
    if resp.status_code != 200:
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"IAM returned {resp.status_code}: {resp.text[:300]}",
        )
    return {"capability_id": capability_id, "servers": resp.json()}


# ── M13 — code-changes proxy ────────────────────────────────────────────────
#
# context-fabric's call_log rows carry `code_change_ids[]` and `mcp_server_id`.
# workgraph asks us to resolve a run's code-changes; we pull the call_log row,
# fetch the MCP server credentials from IAM, then call MCP /mcp/resources/code-changes
# with the persisted ids. MCP is the source of truth — if MCP has restarted and
# dropped the ring, we still return the persisted ids with a `stale: true` flag
# so the UI can render a useful "diff content unavailable" notice.

def _default_mcp_record() -> Optional[dict[str, Any]]:
    base_url = (settings.mcp_default_base_url or "").strip().rstrip("/")
    bearer = (settings.mcp_default_bearer_token or "").strip()
    if not base_url or not bearer:
        return None
    return {
        "id": (settings.mcp_default_server_id or "default-mcp").strip() or "default-mcp",
        "base_url": base_url,
        "bearer_token": bearer,
        "source": "default",
    }


def _mcp_resource_url(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    suffix = path if path.startswith("/") else f"/{path}"
    if base.endswith("/mcp"):
        return f"{base}{suffix}"
    return f"{base}/mcp{suffix}"


async def _fetch_mcp_server(server_id: str) -> dict[str, Any]:
    default_record = _default_mcp_record()
    if default_record and server_id == default_record["id"]:
        return default_record

    url = f"{settings.iam_base_url.rstrip('/')}/mcp-servers/{server_id}"
    resp = await _iam_get(url, timeout=10.0)
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="mcp server not found")
    if resp.status_code != 200:
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"IAM returned {resp.status_code}: {resp.text[:300]}",
        )
    return resp.json()


@router.get("/code-changes")
async def list_code_changes_for_call(
    cf_call_id: Optional[str] = Query(default=None, description="CallLog row id; resolves which MCP server to query"),
    ids: Optional[str] = Query(default=None, description="Comma-separated MCP code-change ids for call-log fallback"),
    mcp_server_id: Optional[str] = Query(default=None, description="MCP server id to use when ids are supplied directly"),
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
):
    """Resolve all code-changes captured during a single execute call.

    Reads cf's local `call_log` row to find the `code_change_ids` and the
    `mcp_server_id`. Looks up the MCP server credentials from IAM, then
    calls MCP `/mcp/resources/code-changes?ids=…` to hydrate the full records.
    Returns `{items, stale:false}` on a hit; `{items: minimal_records,
    stale: true}` when MCP has dropped the records (eg restart).
    """
    _check_service_token(x_service_token)

    supplied_ids = [item.strip() for item in (ids or "").split(",") if item.strip()]
    rec: Optional[dict[str, Any]] = None
    if cf_call_id:
        from . import call_log
        rec = call_log.get_by_id(cf_call_id)
        if not rec and not supplied_ids:
            raise HTTPException(status_code=404, detail=f"call_log {cf_call_id} not found")
    elif not supplied_ids:
        raise HTTPException(status_code=400, detail="cf_call_id or ids is required")

    code_change_ids: list[str] = rec.get("code_change_ids") if rec else []
    if not code_change_ids:
        code_change_ids = supplied_ids
    if not code_change_ids:
        return {"cfCallId": cf_call_id, "items": [], "stale": False}

    server_id = (rec.get("mcp_server_id") if rec else None) or mcp_server_id
    if not server_id and supplied_ids:
        default_record = _default_mcp_record()
        server_id = default_record["id"] if default_record else None
    if not server_id:
        # No MCP server recorded — return placeholders so the UI can still display ids.
        return {
            "cfCallId": cf_call_id,
            "items": [{"id": i, "stale": True, "tool_name": None, "paths_touched": []} for i in code_change_ids],
            "stale": True,
        }

    server = await _fetch_mcp_server(server_id)
    base   = (server.get("base_url") or "").rstrip("/")
    bearer = server.get("bearer_token")
    if not base or not bearer:
        raise HTTPException(status_code=502, detail="resolved MCP server is missing base_url or bearer_token")

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(
                _mcp_resource_url(base, "/resources/code-changes"),
                params={"ids": ",".join(code_change_ids)},
                headers={"Authorization": f"Bearer {bearer}"},
            )
        except httpx.HTTPError as exc:
            # MCP unreachable — return persisted ids with stale flag.
            return {
                "cfCallId": cf_call_id,
                "items": [{"id": i, "stale": True, "tool_name": None, "paths_touched": []} for i in code_change_ids],
                "stale": True,
                "error": f"mcp unreachable: {exc}",
            }
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"MCP returned {resp.status_code}: {resp.text[:300]}")
    body = resp.json()
    items = (body.get("data") or {}).get("items") or []
    # MCP returns only the records it still has — fill gaps with stale placeholders so id ordering is preserved.
    by_id = {it["id"]: it for it in items if isinstance(it, dict) and "id" in it}
    full  = [by_id.get(i) or {"id": i, "stale": True, "tool_name": None, "paths_touched": []} for i in code_change_ids]
    any_stale = any(it.get("stale") for it in full)
    return {"cfCallId": cf_call_id, "items": full, "stale": any_stale}


@router.get("/code-changes/{change_id}")
async def get_code_change(
    change_id: str,
    cf_call_id: str = Query(..., description="CallLog row id used to resolve which MCP server holds this change"),
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
):
    """Fetch a single code-change by id. Requires `cf_call_id` so we can
    resolve which MCP server holds the record (MCP is per-tenant)."""
    _check_service_token(x_service_token)

    from . import call_log
    rec = call_log.get_by_id(cf_call_id)
    if not rec:
        raise HTTPException(status_code=404, detail=f"call_log {cf_call_id} not found")
    server_id = rec.get("mcp_server_id")
    if not server_id:
        raise HTTPException(status_code=404, detail="no mcp_server_id on call_log row")
    server = await _fetch_mcp_server(server_id)
    base   = (server.get("base_url") or "").rstrip("/")
    bearer = server.get("bearer_token")
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(
                _mcp_resource_url(base, f"/resources/code-changes/{change_id}"),
                headers={"Authorization": f"Bearer {bearer}"},
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"mcp unreachable: {exc}")
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="code-change not found in MCP (may have been evicted from ring)")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"MCP returned {resp.status_code}: {resp.text[:300]}")
    return resp.json().get("data")


@router.get("/servers/{server_id}")
async def get_mcp_server(
    server_id: str,
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
):
    """Full MCP server record (includes bearer_token). For internal use only —
    callers must already have the service token. context-fabric uses this
    when about to dial an MCP server for a workflow execution."""
    _check_service_token(x_service_token)

    default_record = _default_mcp_record()
    if default_record and server_id == default_record["id"]:
        return default_record

    url = f"{settings.iam_base_url.rstrip('/')}/mcp-servers/{server_id}"
    try:
        resp = await _iam_get(url, timeout=10.0)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"IAM unreachable: {exc}")
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="mcp server not found")
    if resp.status_code != 200:
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"IAM returned {resp.status_code}: {resp.text[:300]}",
        )
    return resp.json()
