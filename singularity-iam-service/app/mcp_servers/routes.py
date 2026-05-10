"""
MCP-server registry routes (M6).

Two mount points are exposed via the same router:
  - /capabilities/{capability_uuid}/mcp-servers          (scoped CRUD)
  - /mcp-servers/{id}                                    (lookup + update + test)

A registered MCP server points at a customer-deployed Node container that:
  - holds its own provider/tool secrets (we never see them)
  - exposes the MCP protocol (HTTP today, WebSocket optional)
  - context-fabric authenticates to it with the per-server bearer token we
    store here.

Auth: every endpoint requires a valid IAM JWT. context-fabric reads from this
table using a service-token Bearer (same flow as other internal IAM reads).
"""
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.service import record_event
from app.auth.deps import get_current_user
from app.database import get_db
from app.mcp_servers.schemas import (
    CreateMcpServerRequest, HealthCheckOut, McpServerOut, McpServerSummary,
    UpdateMcpServerRequest,
)
from app.models import Capability, McpServer, User

router = APIRouter(tags=["mcp-servers"])


# ── helpers ───────────────────────────────────────────────────────────────

def _full(s: McpServer) -> McpServerOut:
    return McpServerOut(
        id=s.id, capability_id=s.capability_id, name=s.name, description=s.description,
        base_url=s.base_url, auth_method=s.auth_method, bearer_token=s.bearer_token,
        protocol=s.protocol, protocol_version=s.protocol_version, status=s.status,
        last_health_check_at=s.last_health_check_at,
        last_health_check_status=s.last_health_check_status,
        metadata=s.metadata_ or {}, tags=s.tags or [], created_by=s.created_by,
        created_at=s.created_at, updated_at=s.updated_at,
    )


def _summary(s: McpServer) -> McpServerSummary:
    return McpServerSummary(
        id=s.id, capability_id=s.capability_id, name=s.name, description=s.description,
        base_url=s.base_url, auth_method=s.auth_method,
        has_token=bool(s.bearer_token), protocol=s.protocol,
        protocol_version=s.protocol_version, status=s.status,
        last_health_check_at=s.last_health_check_at,
        last_health_check_status=s.last_health_check_status,
        metadata=s.metadata_ or {}, tags=s.tags or [],
        created_at=s.created_at, updated_at=s.updated_at,
    )


async def _load_capability(db: AsyncSession, cap_uuid: str) -> Capability:
    cap = (await db.execute(select(Capability).where(Capability.id == cap_uuid))).scalar_one_or_none()
    if not cap:
        raise HTTPException(status_code=404, detail="Capability not found")
    return cap


async def _load_server(db: AsyncSession, server_id: str) -> McpServer:
    srv = (await db.execute(select(McpServer).where(McpServer.id == server_id))).scalar_one_or_none()
    if not srv:
        raise HTTPException(status_code=404, detail="MCP server not found")
    return srv


# ── capability-scoped endpoints ───────────────────────────────────────────

@router.post(
    "/capabilities/{cap_uuid}/mcp-servers",
    response_model=McpServerOut,
    status_code=201,
)
async def register_mcp_server(
    cap_uuid: str,
    body: CreateMcpServerRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cap = await _load_capability(db, cap_uuid)
    srv = McpServer(
        capability_id=cap.id, name=body.name, description=body.description,
        base_url=str(body.base_url), auth_method=body.auth_method,
        bearer_token=body.bearer_token, protocol=body.protocol,
        protocol_version=body.protocol_version, status="active",
        metadata_=body.metadata or {}, tags=body.tags or [],
        created_by=current_user.id,
    )
    db.add(srv)
    await db.flush()
    await record_event(
        db, actor_user_id=current_user.id,
        event_type="mcp_server.registered",
        capability_id=cap.capability_id, target_type="mcp_server", target_id=srv.id,
        payload={"name": srv.name, "base_url": srv.base_url, "protocol": srv.protocol},
    )
    await db.commit()
    await db.refresh(srv)
    return _full(srv)


@router.get(
    "/capabilities/{cap_uuid}/mcp-servers",
    response_model=list[McpServerSummary],
)
async def list_mcp_servers_for_capability(
    cap_uuid: str,
    status: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    await _load_capability(db, cap_uuid)
    q = select(McpServer).where(McpServer.capability_id == cap_uuid)
    if status:
        q = q.where(McpServer.status == status)
    rows = (await db.execute(q.order_by(McpServer.created_at.desc()))).scalars().all()
    return [_summary(r) for r in rows]


# ── server-id-scoped endpoints ────────────────────────────────────────────

@router.get("/mcp-servers/{server_id}", response_model=McpServerOut)
async def get_mcp_server(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    srv = await _load_server(db, server_id)
    return _full(srv)


@router.patch("/mcp-servers/{server_id}", response_model=McpServerOut)
async def update_mcp_server(
    server_id: str,
    body: UpdateMcpServerRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    srv = await _load_server(db, server_id)
    fields = body.model_dump(exclude_unset=True)
    if "base_url" in fields and fields["base_url"] is not None:
        fields["base_url"] = str(fields["base_url"])
    if "metadata" in fields:
        fields["metadata_"] = fields.pop("metadata") or {}
    for k, v in fields.items():
        setattr(srv, k, v)
    await db.flush()
    await record_event(
        db, actor_user_id=current_user.id,
        event_type="mcp_server.updated",
        target_type="mcp_server", target_id=srv.id,
        payload={"changes": list(fields.keys())},
    )
    await db.commit()
    await db.refresh(srv)
    return _full(srv)


@router.delete("/mcp-servers/{server_id}", status_code=204)
async def delete_mcp_server(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    srv = await _load_server(db, server_id)
    cap_id = srv.capability_id
    name = srv.name
    await db.delete(srv)
    await db.flush()
    await record_event(
        db, actor_user_id=current_user.id,
        event_type="mcp_server.deleted",
        target_type="mcp_server", target_id=server_id,
        payload={"name": name, "capability_id": cap_id},
    )
    await db.commit()
    return None


@router.post("/mcp-servers/{server_id}/test", response_model=HealthCheckOut)
async def test_mcp_server(
    server_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Probe an MCP server's health endpoint with the stored bearer token.
    Updates `last_health_check_at` + `last_health_check_status`. Returns the
    probe result without committing the bearer token to the response."""
    srv = await _load_server(db, server_id)
    started = datetime.now(timezone.utc)
    http_status: Optional[int] = None
    error: Optional[str] = None
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{srv.base_url.rstrip('/')}/health",
                headers={"Authorization": f"Bearer {srv.bearer_token}"},
            )
            http_status = resp.status_code
            new_status = "active" if 200 <= resp.status_code < 300 else "failed"
    except Exception as exc:  # connection error, timeout, etc.
        error = str(exc)
        new_status = "failed"

    latency_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    srv.last_health_check_at = started
    srv.last_health_check_status = new_status
    if srv.status not in ("suspended",):  # don't auto-revive a manually-suspended server
        srv.status = new_status
    await db.flush()
    await record_event(
        db, actor_user_id=current_user.id,
        event_type="mcp_server.health_checked",
        target_type="mcp_server", target_id=srv.id,
        payload={"http_status": http_status, "status": new_status, "latency_ms": latency_ms},
    )
    await db.commit()
    return HealthCheckOut(
        server_id=srv.id, base_url=srv.base_url, status=new_status,
        http_status=http_status, latency_ms=latency_ms, error=error,
        checked_at=started,
    )
