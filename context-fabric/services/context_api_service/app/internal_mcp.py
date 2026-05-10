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

from typing import Optional

import httpx
from fastapi import APIRouter, Header, HTTPException, Query

from .config import settings
from .iam_service_token import get_iam_service_token


router = APIRouter(prefix="/internal/mcp", tags=["internal-mcp"])


def _check_service_token(provided: Optional[str]) -> None:
    expected = settings.iam_service_token
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="IAM_SERVICE_TOKEN is not configured on context-fabric",
        )
    if not provided or provided != expected:
        raise HTTPException(status_code=401, detail="invalid service token")


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

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(
                url,
                params=params,
                headers={"Authorization": f"Bearer {await get_iam_service_token() or ''}"},
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"IAM unreachable: {exc}")
    if resp.status_code != 200:
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"IAM returned {resp.status_code}: {resp.text[:300]}",
        )
    return {"capability_id": capability_id, "servers": resp.json()}


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
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(
                url,
                headers={"Authorization": f"Bearer {await get_iam_service_token() or ''}"},
            )
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
