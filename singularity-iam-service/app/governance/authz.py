"""Capability Governance Model — G7a authorization + contributions validation.

The route layer imports these for the mutate endpoints (POST attach / PATCH /
deactivate / reactivate). Service-principal checks are pure; real-user checks
delegate to the DB-backed IAM authorization resolver so governance writes can
be capability-scoped.

Authority model:
  * Service principals need explicit JWT scopes: `governance:author` for
    ADVISORY writes and `governance:enforce` for REQUIRED/BLOCKING writes.
  * Real users need the matching permission through platform roles or active
    capability membership on both the governed capability and the governing
    capability. Super-admin remains the only global bypass.
This keeps governance authoring capability-scoped instead of letting any
authenticated user bind a security/compliance capability to arbitrary work.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.authz.resolver import check_authorization
from app.governance.resolver import MODE_RANK

# Modes at/above this rank are "enforcing" and require elevated authority.
ENFORCING_MIN_RANK = MODE_RANK["REQUIRED"]
GOVERNANCE_AUTHOR_PERMISSION = "governance:author"
GOVERNANCE_ENFORCE_PERMISSION = "governance:enforce"


def is_service_principal(u: Any) -> bool:
    """Service-token callers are _ServicePrincipal (carry .service_name); real
    users are User rows without it."""
    return hasattr(u, "service_name")


def principal_scopes(u: Any) -> set[str]:
    return set(getattr(u, "scopes", None) or [])


def actor_meta(u: Any) -> dict:
    """Identity captured into audit payloads (distinguishes user vs service)."""
    if is_service_principal(u):
        return {"actor_kind": "service", "service_name": getattr(u, "service_name", None),
                "actor_id": getattr(u, "id", None)}
    return {"actor_kind": "user", "actor_id": getattr(u, "id", None)}


def mode_is_enforcing(mode: str) -> bool:
    return MODE_RANK.get((mode or "ADVISORY").strip().upper(), 1) >= ENFORCING_MIN_RANK


def required_governance_permission(*, enforcing: bool) -> str:
    return GOVERNANCE_ENFORCE_PERMISSION if enforcing else GOVERNANCE_AUTHOR_PERMISSION


def assert_governance_service_scope(u: Any, *, enforcing: bool) -> bool:
    """Return True after handling service principals, False for real users.

    Service principals never fall through to user/capability membership checks.
    """
    scopes = principal_scopes(u)
    service = is_service_principal(u)
    if not service:
        return False
    if enforcing:
        if GOVERNANCE_ENFORCE_PERMISSION in scopes:
            return True
        raise HTTPException(
            403,
            "enforcing governance (REQUIRED/BLOCKING) requires the 'governance:enforce' "
            "scope on the service token; service principals cannot inherit super-admin",
        )
    # ADVISORY authoring.
    if not (scopes & {GOVERNANCE_AUTHOR_PERMISSION, GOVERNANCE_ENFORCE_PERMISSION}):
        raise HTTPException(
            403, "service principals require the 'governance:author' scope to author governance"
        )
    return True


async def assert_governance_authority(
    db: AsyncSession,
    u: Any,
    *,
    governed_capability_id: str,
    governing_capability_id: str,
    enforcing: bool,
) -> None:
    """Raise 403 unless the principal can write governance for this edge."""
    if assert_governance_service_scope(u, enforcing=enforcing):
        return
    if getattr(u, "is_super_admin", False):
        return

    required = required_governance_permission(enforcing=enforcing)
    missing: list[str] = []
    for cap_id in sorted({governed_capability_id, governing_capability_id}):
        result = await check_authorization(
            db=db,
            user_id=str(getattr(u, "id", "") or ""),
            capability_id=cap_id,
            action=required,
        )
        if not result.allowed:
            missing.append(cap_id)
    if missing:
        raise HTTPException(
            403,
            f"{required} permission required on capability/capabilities: {', '.join(missing)}",
        )


_CONTRIB_LIST_KEYS = {
    "promptLayers": "layerKey",
    "requiredEvidence": "evidenceKey",
    "verifierAgents": None,
    "approvalGates": "gateKey",
    "waiverRules": "controlKey",
    "blockingControls": "controlKey",
}


def validate_contributions(contributions: Any, mode: str) -> None:
    """Validate enforcement-relevant contribution shapes so a malformed
    REQUIRED/BLOCKING payload 422s here instead of being silently dropped by the
    resolver at run time. `mode` is accepted for future mode-specific strictness;
    today the shape checks apply to all modes. Never trust client validation."""
    if contributions is None:
        return
    if not isinstance(contributions, dict):
        raise HTTPException(422, "contributions must be an object")
    for key, item_key in _CONTRIB_LIST_KEYS.items():
        items = contributions.get(key)
        if items is None:
            continue
        if not isinstance(items, list):
            raise HTTPException(422, f"contributions.{key} must be a list")
        for i, it in enumerate(items):
            if not isinstance(it, dict):
                raise HTTPException(422, f"contributions.{key}[{i}] must be an object")
            if item_key and not it.get(item_key):
                raise HTTPException(422, f"contributions.{key}[{i}] missing required '{item_key}'")
    tp = contributions.get("toolPolicy")
    if tp is not None:
        if not isinstance(tp, dict):
            raise HTTPException(422, "contributions.toolPolicy must be an object")
        for k in ("blocked", "approvalRequired", "allowed"):
            v = tp.get(k)
            if v is not None and not (isinstance(v, list) and all(isinstance(x, str) for x in v)):
                raise HTTPException(422, f"contributions.toolPolicy.{k} must be a list of strings")
    # controlBindings: map controlKey -> { type, ... } (how the gate evidences each control).
    cb = contributions.get("controlBindings")
    if cb is not None:
        if not isinstance(cb, dict):
            raise HTTPException(422, "contributions.controlBindings must be an object (controlKey -> binding)")
        for ck, b in cb.items():
            if not isinstance(b, dict) or not b.get("type"):
                raise HTTPException(422, f"contributions.controlBindings.{ck} must be an object with a 'type'")
    for ev in contributions.get("requiredEvidence") or []:
        m = ev.get("mode")
        if m is not None and str(m).strip().upper() not in MODE_RANK:
            raise HTTPException(422, f"requiredEvidence mode {m!r} invalid; expected one of {sorted(MODE_RANK)}")
