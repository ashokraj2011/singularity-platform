"""
M73 — MCP runtime resolution.

Picks the MCP server that should execute a given /execute request. Order:

  1. If the capability has registered MCP servers in IAM, use the first
     active one. Full server record is fetched by id.
  2. Otherwise fall back to the deployment-wide default
     (MCP_DEFAULT_BASE_URL + MCP_DEFAULT_BEARER_TOKEN env). This makes
     local/laptop runs work without manual IAM registration — the common
     mode for a single-MCP install.

Returns (record, warnings). Warnings flow into the call_log's
metadata.warnings so Workbench can show them without aborting the run.

Capability remains the SCOPE for prompts/knowledge/memory/tools/governance;
MCP is the execution endpoint. Those are intentionally decoupled.
"""
from __future__ import annotations

from typing import Any, Optional

import httpx
from fastapi import HTTPException

from ..config import settings
from ..iam_service_token import get_iam_service_token, invalidate_iam_service_token
from ..response_json import response_json


async def _iam_get(
    url: str,
    params: Optional[dict] = None,
    timeout: float = 30.0,
) -> dict:
    """GET an IAM endpoint with the service token; retry once on 401 after
    invalidating the cached token (covers token rotation)."""
    async def _do(token: str | None) -> dict:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(
                url,
                params=params,
                headers={"Authorization": f"Bearer {token or ''}"},
            )
            resp.raise_for_status()
            return response_json(resp, "IAM MCP runtime lookup")

    token = await get_iam_service_token()
    try:
        return await _do(token)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code != 401:
            raise
        invalidate_iam_service_token()
        return await _do(await get_iam_service_token())


def default_mcp_record() -> Optional[dict[str, Any]]:
    """Build the deployment-wide default MCP record from settings, or None
    when no default is configured."""
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


async def resolve_mcp_record(
    capability_id: str,
) -> tuple[dict[str, Any], list[str]]:
    """Resolve an MCP runtime without making capability registration mandatory.

    Capability remains the scope for prompts, knowledge, memory, tools, and
    governance. MCP is the execution/workspace endpoint, so a deployment-
    wide default is valid when there is no per-capability override.
    """
    warnings: list[str] = []
    default_record = default_mcp_record()
    try:
        servers_resp = await _iam_get(
            f"{settings.iam_base_url.rstrip('/')}/capabilities/{capability_id}/mcp-servers",
            params={"status": "active"},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        if default_record:
            # A capability-bound MCP registry is optional: the common
            # local/office-laptop mode uses one default MCP runtime.
            # IAM 404 / empty registry is an expected fallback, not an
            # execution warning that would make Workbench request rework.
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404:
                return default_record, warnings
            warnings.append(f"IAM MCP lookup failed; using default MCP runtime: {exc!s}")
            return default_record, warnings
        raise

    servers = servers_resp if isinstance(servers_resp, list) else servers_resp.get("servers", [])
    if not servers:
        if default_record:
            return default_record, warnings
        raise HTTPException(status_code=409, detail="no MCP runtime configured")

    chosen = servers[0]
    full = await _iam_get(
        f"{settings.iam_base_url.rstrip('/')}/mcp-servers/{chosen['id']}",
        timeout=10.0,
    )
    full["source"] = "capability"
    return full, warnings


async def mcp_record_by_id(mcp_server_id: str) -> dict[str, Any]:
    """Fetch a specific MCP record by id. Used by /execute/resume to re-target
    the SAME runtime that handled the original call (the continuation token
    binds to a server_id; we can't pick a different one mid-pause)."""
    default_record = default_mcp_record()
    if default_record and mcp_server_id == default_record["id"]:
        return default_record
    return await _iam_get(
        f"{settings.iam_base_url.rstrip('/')}/mcp-servers/{mcp_server_id}",
        timeout=10.0,
    )
