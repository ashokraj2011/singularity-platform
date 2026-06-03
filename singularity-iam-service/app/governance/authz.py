"""Capability Governance Model — G7a authorization + contributions validation.

Pure, DB-free helpers (like resolver.py) so they unit-test without a database
or FastAPI app wiring. The route layer imports these for the mutate endpoints
(POST attach / PATCH / deactivate / reactivate).

Authority model (coarse, per the G7a plan):
  * ADVISORY authoring — any authenticated real user, OR a service principal
    carrying an explicit `governance:author` (or `governance:enforce`) scope.
  * Enforcing modes (REQUIRED / BLOCKING) — elevated authority: super-admin
    (real user) or the explicit `governance:enforce` scope. A service token's
    blanket M11 `is_super_admin` is NOT sufficient to set/raise/toggle an
    enforcing attachment.
Finer-grained *per-capability* governance permissions are a deliberate
follow-up; this is the coarse gate that closes the "anyone can flip BLOCKING"
hole called out in review.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from app.governance.resolver import MODE_RANK

# Modes at/above this rank are "enforcing" and require elevated authority.
ENFORCING_MIN_RANK = MODE_RANK["REQUIRED"]


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


def assert_governance_authority(u: Any, *, enforcing: bool) -> None:
    """Raise 403 unless the principal may author (enforcing=False) or enforce
    (enforcing=True) governance. See module docstring for the model."""
    scopes = principal_scopes(u)
    service = is_service_principal(u)
    if enforcing:
        if "governance:enforce" in scopes:
            return
        if service:
            raise HTTPException(
                403,
                "enforcing governance (REQUIRED/BLOCKING) requires the 'governance:enforce' "
                "scope on the service token; a service principal's blanket super-admin is not sufficient",
            )
        if not getattr(u, "is_super_admin", False):
            raise HTTPException(
                403,
                "enforcing governance (REQUIRED/BLOCKING) requires super-admin or the "
                "'governance:enforce' scope",
            )
        return
    # ADVISORY authoring.
    if service and not (scopes & {"governance:author", "governance:enforce"}):
        raise HTTPException(
            403, "service principals require the 'governance:author' scope to author governance"
        )
    # Any authenticated real user may author ADVISORY (per-capability perms TBD).


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
    for ev in contributions.get("requiredEvidence") or []:
        m = ev.get("mode")
        if m is not None and str(m).strip().upper() not in MODE_RANK:
            raise HTTPException(422, f"requiredEvidence mode {m!r} invalid; expected one of {sorted(MODE_RANK)}")
