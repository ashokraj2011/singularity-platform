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

from typing import Any, Optional

import httpx
from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from .config import settings
from .iam_service_token import get_iam_service_token, invalidate_iam_service_token


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
    args: dict[str, Any] = Field(default_factory=dict)


def _check_service_token(provided: Optional[str]) -> None:
    expected = settings.iam_service_token
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="IAM_SERVICE_TOKEN is not configured on context-fabric",
        )
    if not provided or provided != expected:
        raise HTTPException(status_code=401, detail="invalid service token")


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
        "arguments": body.args,
        "context_package_id": None,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await client.post(
                f"{settings.tool_service_url.rstrip('/')}/api/v1/tools/invoke",
                json=payload,
                headers={"X-Trace-Id": body.traceId or ""},
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
# fetch the MCP server credentials from IAM, then call MCP /resources/code-changes
# with the persisted ids. MCP is the source of truth — if MCP has restarted and
# dropped the ring, we still return the persisted ids with a `stale: true` flag
# so the UI can render a useful "diff content unavailable" notice.

async def _fetch_mcp_server(server_id: str) -> dict:
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
    cf_call_id: str = Query(..., description="CallLog row id; resolves which MCP server to query"),
    x_service_token: Optional[str] = Header(default=None, alias="X-Service-Token"),
):
    """Resolve all code-changes captured during a single execute call.

    Reads cf's local `call_log` row to find the `code_change_ids` and the
    `mcp_server_id`. Looks up the MCP server credentials from IAM, then
    calls MCP `/resources/code-changes?ids=…` to hydrate the full records.
    Returns `{items, stale:false}` on a hit; `{items: minimal_records,
    stale: true}` when MCP has dropped the records (eg restart).
    """
    _check_service_token(x_service_token)

    from . import call_log
    rec = call_log.get_by_id(cf_call_id)
    if not rec:
        raise HTTPException(status_code=404, detail=f"call_log {cf_call_id} not found")
    ids: list[str] = rec.get("code_change_ids") or []
    if not ids:
        return {"cfCallId": cf_call_id, "items": [], "stale": False}

    server_id = rec.get("mcp_server_id")
    if not server_id:
        # No MCP server recorded — return placeholders so the UI can still display ids.
        return {
            "cfCallId": cf_call_id,
            "items": [{"id": i, "stale": True, "tool_name": None, "paths_touched": []} for i in ids],
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
                f"{base}/resources/code-changes",
                params={"ids": ",".join(ids)},
                headers={"Authorization": f"Bearer {bearer}"},
            )
        except httpx.HTTPError as exc:
            # MCP unreachable — return persisted ids with stale flag.
            return {
                "cfCallId": cf_call_id,
                "items": [{"id": i, "stale": True, "tool_name": None, "paths_touched": []} for i in ids],
                "stale": True,
                "error": f"mcp unreachable: {exc}",
            }
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"MCP returned {resp.status_code}: {resp.text[:300]}")
    body = resp.json()
    items = (body.get("data") or {}).get("items") or []
    # MCP returns only the records it still has — fill gaps with stale placeholders so id ordering is preserved.
    by_id = {it["id"]: it for it in items if isinstance(it, dict) and "id" in it}
    full  = [by_id.get(i) or {"id": i, "stale": True, "tool_name": None, "paths_touched": []} for i in ids]
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
                f"{base}/resources/code-changes/{change_id}",
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
