"""Git credential broker (P0 #2).

Small, dependency-light module that brokers a short-lived, repo-scoped git
credential from IAM for a given operation. It is factored OUT of internal_mcp.py
so that governed.code_context can also broker a credential WITHOUT importing
internal_mcp — importing internal_mcp from governed.code_context creates a cycle
(internal_mcp -> governed.grant -> governed.__init__ -> governed.turn ->
governed.code_context). This module only depends on .config and
.iam_service_token, neither of which import the governed package, so it is safe
to import from both internal_mcp.py and governed/code_context.py.

Security: the brokered credential (which contains a token) is returned to the
caller for in-memory use only. This module NEVER logs the token.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

import httpx

from .config import settings
from .env_config import bounded_float_env
from .iam_service_token import get_iam_service_token
from .response_json import UpstreamJsonError, response_json_object

log = logging.getLogger(__name__)

GIT_BROKER_TIMEOUT_SEC = bounded_float_env(
    "CONTEXT_FABRIC_GIT_BROKER_TIMEOUT_SEC",
    default=20.0,
    min_value=1.0,
    max_value=300.0,
    logger=log,
)


def _git_broker_enabled() -> bool:
    return os.environ.get("GIT_CREDENTIAL_BROKER_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


async def broker_git_credential(
    run_context: dict[str, Any],
    operation: str,
    grant_nonce: str | None = None,
) -> Optional[dict[str, Any]]:
    """Broker a short-lived, repo-scoped git credential from IAM for `operation`.

    Reads repo/tenant/user/capability from run_context. Returns None (logged) on
    any miss so callers degrade gracefully. NEVER logs the token.
    """
    if not _git_broker_enabled():
        return None
    rc = run_context or {}
    # IMPORTANT: include sourceUri/source_uri — that's how the clone path names
    # the repo (the code-context / tool-run run_context carries the repo as
    # sourceUri, not `repo`).
    repo = (
        rc.get("repo")
        or rc.get("repoUrl")
        or rc.get("repository")
        or rc.get("sourceUri")
        or rc.get("source_uri")
    )
    tenant_id = rc.get("tenant_id") or rc.get("tenantId")
    if not (repo and tenant_id):
        log.info("git broker: repo/tenant missing in run_context for op=%s — skipping credential", operation)
        return None
    service_jwt = await get_iam_service_token()
    if not service_jwt:
        log.warning("git broker: no IAM service token — skipping credential for op=%s", operation)
        return None
    payload = {
        "tenantId": tenant_id,
        "userId": rc.get("user_id") or rc.get("userId"),
        "repo": repo,
        "operation": operation,
        "runId": rc.get("run_id") or rc.get("runId"),
        "nodeId": rc.get("node_id") or rc.get("nodeId"),
        "workflowInstanceId": rc.get("workflow_instance_id") or rc.get("workflowInstanceId"),
        "capabilityId": rc.get("capability_id") or rc.get("capabilityId"),
        "grantNonce": grant_nonce,
    }
    url = f"{settings.iam_base_url.rstrip('/')}/internal/git/credentials/issue"
    try:
        async with httpx.AsyncClient(timeout=GIT_BROKER_TIMEOUT_SEC) as client:
            resp = await client.post(url, json=payload, headers={"Authorization": f"Bearer {service_jwt}"})
    except httpx.HTTPError as exc:
        log.warning("git broker: IAM issue unreachable for op=%s: %s", operation, exc)
        return None
    if resp.status_code >= 300:
        log.warning("git broker: IAM issue failed (%s) for op=%s: %s", resp.status_code, operation, resp.text[:200])
        return None
    try:
        return response_json_object(resp, "IAM git credential issue")
    except UpstreamJsonError as exc:
        log.warning("git broker: IAM issue returned invalid JSON for op=%s: %s", operation, exc)
        return None


# Per-run memo for the clone (READ) credential. A run materializes its repo at
# most a couple of times (code-context build + maybe a tool-run-first clone), so
# without memoization every governed tool dispatch in a no-code-context workflow
# would mint a fresh IAM credential. Keyed by (run id, repo); shared across the
# code-context AND tool-run dispatch paths so a run issues ONE clone credential
# regardless of which path triggers first. Holds short-lived tokens in memory
# only, bounded by eviction of expired entries on write. TTL is a fixed, safely
# conservative window (well inside GitHub's ~1h installation-token lifetime); a
# longer run simply re-mints.
_CLONE_CRED_TTL_SEC = 300.0
_clone_cred_cache: dict[tuple[str, str], tuple[dict[str, Any], float]] = {}


def _clone_run_key(run_context: dict[str, Any]) -> Optional[tuple[str, str]]:
    rc = run_context or {}
    run_id = (
        rc.get("runId")
        or rc.get("run_id")
        or rc.get("workflow_instance_id")
        or rc.get("workflowInstanceId")
        or rc.get("traceId")
        or rc.get("trace_id")
    )
    repo = (
        rc.get("repo")
        or rc.get("repoUrl")
        or rc.get("repository")
        or rc.get("sourceUri")
        or rc.get("source_uri")
    )
    if not run_id or not repo:
        return None
    return (str(run_id), str(repo))


async def clone_credential_for_run(run_context: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Broker a clone (READ) credential ONCE per (run, repo), reused across the
    code-context and tool-run dispatch paths. Returns None when the broker is off,
    the repo/tenant is absent, or IAM declines. Never logs the token.
    """
    key = _clone_run_key(run_context)
    now = time.time()
    if key is not None:
        cached = _clone_cred_cache.get(key)
        if cached and cached[1] > now:
            return cached[0]
    cred = await broker_git_credential(run_context, "clone")
    if cred and key is not None:
        # Bounded growth: drop expired entries before inserting.
        for k in [k for k, (_, exp) in _clone_cred_cache.items() if exp <= now]:
            _clone_cred_cache.pop(k, None)
        _clone_cred_cache[key] = (cred, now + _CLONE_CRED_TTL_SEC)
    return cred
