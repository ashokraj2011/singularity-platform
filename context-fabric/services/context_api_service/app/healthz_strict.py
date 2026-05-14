"""M28 boot-1 — strict health invariants for context-api-service.

Asserts at boot:
  - IAM_BASE_URL reachable AND bootstrap creds mint a real JWT (the
    fix for the `Bearer ` empty-token 502 that bit us in demo prep)
  - CALL_LOG_DB / EVENTS_STORE_DB paths are writable (the `/data` Read-only
    file system error that 503-ed every request)
  - audit-gov reachable (it's the silent dependency of every emit)

Returns ok=True if all pass; ok=False with failing check names otherwise.
"""
from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import httpx

from .config import settings


@dataclass
class InvariantResult:
    name: str
    ok: bool
    reason: Optional[str] = None
    details: Optional[dict] = None

    def to_dict(self) -> dict:
        out: dict = {"name": self.name, "ok": self.ok}
        if self.reason is not None:
            out["reason"] = self.reason
        if self.details is not None:
            out["details"] = self.details
        return out


async def _check_db_writable(env_var: str, default: str) -> InvariantResult:
    path = Path(os.environ.get(env_var, default))
    parent = path.parent
    try:
        parent.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return InvariantResult(
            name=f"sqlite_writable_{env_var.lower()}",
            ok=False,
            reason=f"cannot create {parent}: {e}",
            details={"path": str(path)},
        )
    if not os.access(parent, os.W_OK):
        return InvariantResult(
            name=f"sqlite_writable_{env_var.lower()}",
            ok=False,
            reason=f"{parent} not writable (try setting {env_var}=/tmp/cf-data/…)",
            details={"path": str(path)},
        )
    return InvariantResult(name=f"sqlite_writable_{env_var.lower()}", ok=True, details={"path": str(path)})


async def _check_iam_reachable() -> InvariantResult:
    base = (settings.iam_base_url or "").rstrip("/")
    if not base:
        return InvariantResult(name="iam_base_reachable", ok=False, reason="IAM_BASE_URL is unset")
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{base}/health")
        if r.status_code != 200:
            return InvariantResult(name="iam_base_reachable", ok=False, reason=f"IAM /health returned {r.status_code}", details={"url": base})
        return InvariantResult(name="iam_base_reachable", ok=True, details={"url": base})
    except Exception as e:
        return InvariantResult(name="iam_base_reachable", ok=False, reason=f"IAM unreachable: {e}", details={"url": base})


async def _check_iam_bootstrap_works() -> InvariantResult:
    """M28 — the specific failure mode from demo prep: cf started without
    IAM_BOOTSTRAP_USERNAME/PASSWORD, so every /execute sent `Bearer ` (empty)
    to IAM. We probe the mint path here so that misconfig fails boot, not
    every request."""
    user = os.environ.get("IAM_BOOTSTRAP_USERNAME")
    pw = os.environ.get("IAM_BOOTSTRAP_PASSWORD")
    if not user or not pw:
        return InvariantResult(
            name="iam_bootstrap_creds_set",
            ok=False,
            reason="IAM_BOOTSTRAP_USERNAME / IAM_BOOTSTRAP_PASSWORD unset — service-token mint will fail with `Bearer ` empty-token 502",
        )
    base = (settings.iam_base_url or "").rstrip("/")
    if not base:
        return InvariantResult(name="iam_bootstrap_creds_set", ok=False, reason="IAM_BASE_URL unset")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(f"{base}/auth/local/login", json={"email": user, "password": pw})
        if r.status_code != 200:
            return InvariantResult(name="iam_bootstrap_creds_set", ok=False, reason=f"login failed: {r.status_code} {r.text[:200]}")
        token = (r.json() or {}).get("access_token")
        if not token:
            return InvariantResult(name="iam_bootstrap_creds_set", ok=False, reason="login returned no access_token")
        return InvariantResult(name="iam_bootstrap_creds_set", ok=True)
    except Exception as e:
        return InvariantResult(name="iam_bootstrap_creds_set", ok=False, reason=f"login failed: {e}")


async def _check_audit_gov_reachable() -> InvariantResult:
    base = os.environ.get("AUDIT_GOV_URL", "").rstrip("/")
    if not base:
        return InvariantResult(name="audit_gov_reachable", ok=True, details={"note": "AUDIT_GOV_URL unset — emits become no-ops"})
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{base}/health")
        if r.status_code != 200:
            return InvariantResult(name="audit_gov_reachable", ok=False, reason=f"audit-gov /health returned {r.status_code}", details={"url": base})
        return InvariantResult(name="audit_gov_reachable", ok=True, details={"url": base})
    except Exception as e:
        return InvariantResult(name="audit_gov_reachable", ok=False, reason=f"audit-gov unreachable: {e}", details={"url": base})


async def run_invariant_checks() -> dict:
    """Run all checks in parallel. Returns {ok: bool, checks: [..]}."""
    results: List[InvariantResult] = await asyncio.gather(
        _check_db_writable("CALL_LOG_DB", "/data/call_log.db"),
        _check_db_writable("EVENTS_STORE_DB", "/data/call_log_events.db"),
        _check_iam_reachable(),
        _check_iam_bootstrap_works(),
        _check_audit_gov_reachable(),
    )
    ok = all(r.ok for r in results)
    return {"ok": ok, "checks": [r.to_dict() for r in results]}
