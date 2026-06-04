import uuid
from datetime import datetime, timezone
from uuid import UUID as _UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Capability, CapabilityRelationship, GovernanceAttachment, User
from app.auth.deps import get_current_user
from app.audit.service import record_event
from app.audit_gov_emit import emit_audit_event
from app.governance.schemas import (
    CreateGovernedByRequest, GovernanceAttachmentOut, GovernanceResolveRequest,
    UpdateGovernedByRequest,
)
from app.governance.resolver import resolve_overlay, MODE_RANK, SCOPE_RANK
from app.governance.policy_docs import enrich_overlay_prompt_layers
from app.governance.authz import (
    assert_governance_authority as _assert_governance_authority,
    validate_contributions as _validate_contributions,
    actor_meta as _actor_meta,
    ENFORCING_MIN_RANK as _ENFORCING_MIN_RANK,
)

router = APIRouter(tags=["governance"])

GOVERNED_BY = "governed_by"


def _actor(u) -> str | None:
    """created_by FK references iam.users.id (UUID); service principals have a
    non-UUID id, so return None for them rather than violating the FK."""
    raw = str(getattr(u, "id", "") or "")
    try:
        _UUID(raw)
        return raw
    except ValueError:
        return None


def _att_out(a: GovernanceAttachment) -> GovernanceAttachmentOut:
    return GovernanceAttachmentOut(
        id=a.id, relationship_id=a.relationship_id, capability_id=a.capability_id,
        governing_capability_id=a.governing_capability_id, mode=a.mode, scope=a.scope,
        target_kind=a.target_kind, target_key=a.target_key, priority=a.priority,
        is_active=a.is_active, effective_from=a.effective_from, effective_to=a.effective_to,
        waiver_allowed=a.waiver_allowed, version=a.version, contributions=a.contributions or {},
        created_at=a.created_at, updated_at=getattr(a, "updated_at", None),
    )


async def _get_cap(db: AsyncSession, cap_id: str) -> Capability | None:
    return (await db.execute(
        select(Capability).where(Capability.capability_id == cap_id)
    )).scalar_one_or_none()


@router.post("/capabilities/{capability_id}/governed-by",
             response_model=GovernanceAttachmentOut, status_code=201)
async def attach_governance(
    capability_id: str, body: CreateGovernedByRequest,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    mode = body.mode.strip().upper()
    scope = body.scope.strip().upper()
    if mode not in MODE_RANK:
        raise HTTPException(422, f"invalid mode {body.mode!r}; expected one of {sorted(MODE_RANK)}")
    if scope not in SCOPE_RANK:
        raise HTTPException(422, f"invalid scope {body.scope!r}; expected one of {sorted(SCOPE_RANK)}")
    if capability_id == body.governing_capability_id:
        raise HTTPException(422, "a capability cannot govern itself")
    _assert_governance_authority(current_user, enforcing=MODE_RANK[mode] >= _ENFORCING_MIN_RANK)
    _validate_contributions(body.contributions, mode)

    governed = await _get_cap(db, capability_id)
    if governed is None:
        raise HTTPException(404, f"capability {capability_id!r} not found")
    governing = await _get_cap(db, body.governing_capability_id)
    if governing is None:
        raise HTTPException(404, f"governing capability {body.governing_capability_id!r} not found")

    # Reuse the governed_by edge if it exists; else create it.
    rel = (await db.execute(select(CapabilityRelationship).where(
        CapabilityRelationship.source_capability_id == capability_id,
        CapabilityRelationship.target_capability_id == body.governing_capability_id,
        CapabilityRelationship.relationship_type == GOVERNED_BY,
    ))).scalar_one_or_none()
    if rel is None:
        rel = CapabilityRelationship(
            source_capability_id=capability_id,
            target_capability_id=body.governing_capability_id,
            relationship_type=GOVERNED_BY,
            inheritance_policy=body.inheritance_policy,
            metadata_={}, created_by=_actor(current_user),
        )
        db.add(rel)
        await db.flush()

    att = GovernanceAttachment(
        relationship_id=rel.id, capability_id=capability_id,
        governing_capability_id=body.governing_capability_id,
        mode=mode, scope=scope, target_kind=body.target_kind, target_key=body.target_key,
        priority=body.priority, effective_from=body.effective_from, effective_to=body.effective_to,
        waiver_allowed=body.waiver_allowed, contributions=body.contributions or {},
        created_by=_actor(current_user),
    )
    db.add(att)
    # Role marker: the target is now (at least) a governing capability.
    if not governing.is_governing:
        governing.is_governing = True
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            409,
            "an active governance attachment already exists for this governing capability + "
            "scope + target; PATCH the existing attachment instead of creating a duplicate",
        )
    await record_event(
        db, actor_user_id=_actor(current_user), event_type="governance_attachment_created",
        capability_id=capability_id, target_type="governance_attachment", target_id=att.id,
        payload={"governing_capability_id": body.governing_capability_id, "mode": mode,
                 "scope": scope, "target_key": body.target_key, "version": att.version,
                 **_actor_meta(current_user)},
    )
    await db.commit()
    await db.refresh(att)
    emit_audit_event(
        kind="governance.attachment.created",
        actor_id=str(getattr(current_user, "id", "") or "") or None,
        capability_id=capability_id, subject_type="governance_attachment", subject_id=att.id,
        payload={"governing_capability_id": body.governing_capability_id, "mode": mode,
                 "scope": scope, "target_kind": att.target_kind, "target_key": att.target_key,
                 **_actor_meta(current_user)},
    )
    return _att_out(att)


@router.get("/capabilities/{capability_id}/governed-by",
            response_model=list[GovernanceAttachmentOut])
async def list_governed_by(
    capability_id: str, include_inactive: bool = False,
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    q = select(GovernanceAttachment).where(GovernanceAttachment.capability_id == capability_id)
    if not include_inactive:
        q = q.where(GovernanceAttachment.is_active.is_(True))
    rows = (await db.execute(q)).scalars().all()
    return [_att_out(a) for a in rows]


@router.get("/capabilities/{capability_id}/governs",
            response_model=list[GovernanceAttachmentOut])
async def list_governs(
    capability_id: str,
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    rows = (await db.execute(select(GovernanceAttachment).where(
        GovernanceAttachment.governing_capability_id == capability_id
    ))).scalars().all()
    return [_att_out(a) for a in rows]


@router.patch("/capabilities/{capability_id}/governed-by/{attachment_id}",
              response_model=GovernanceAttachmentOut)
async def update_governance(
    capability_id: str, attachment_id: str, body: UpdateGovernedByRequest,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    att = (await db.execute(select(GovernanceAttachment).where(
        GovernanceAttachment.id == attachment_id,
        GovernanceAttachment.capability_id == capability_id,
    ))).scalar_one_or_none()
    if att is None:
        raise HTTPException(404, f"attachment {attachment_id!r} not found on capability {capability_id!r}")

    new_mode = att.mode
    if body.mode is not None:
        new_mode = body.mode.strip().upper()
        if new_mode not in MODE_RANK:
            raise HTTPException(422, f"invalid mode {body.mode!r}; expected one of {sorted(MODE_RANK)}")
    new_scope = att.scope
    if body.scope is not None:
        new_scope = body.scope.strip().upper()
        if new_scope not in SCOPE_RANK:
            raise HTTPException(422, f"invalid scope {body.scope!r}; expected one of {sorted(SCOPE_RANK)}")
    # Authority is checked against the RESULTING mode — can't escalate
    # ADVISORY -> REQUIRED/BLOCKING without enforcing authority.
    _assert_governance_authority(current_user, enforcing=MODE_RANK[new_mode] >= _ENFORCING_MIN_RANK)
    if body.contributions is not None:
        _validate_contributions(body.contributions, new_mode)

    before = {"mode": att.mode, "scope": att.scope, "target_kind": att.target_kind,
              "target_key": att.target_key, "priority": att.priority,
              "waiver_allowed": att.waiver_allowed, "is_active": att.is_active}
    changed = False
    if body.mode is not None and att.mode != new_mode:
        att.mode = new_mode; changed = True
    if body.scope is not None and att.scope != new_scope:
        att.scope = new_scope; changed = True
    if body.target_kind is not None and att.target_kind != body.target_kind:
        att.target_kind = body.target_kind; changed = True
    if body.target_key is not None and att.target_key != body.target_key:
        att.target_key = body.target_key; changed = True
    if body.priority is not None and att.priority != body.priority:
        att.priority = body.priority; changed = True
    if body.effective_from is not None and att.effective_from != body.effective_from:
        att.effective_from = body.effective_from; changed = True
    if body.effective_to is not None and att.effective_to != body.effective_to:
        att.effective_to = body.effective_to; changed = True
    if body.waiver_allowed is not None and att.waiver_allowed != body.waiver_allowed:
        att.waiver_allowed = body.waiver_allowed; changed = True
    if body.contributions is not None and att.contributions != body.contributions:
        att.contributions = body.contributions; changed = True

    if not changed:
        # No governance-relevant field differs — skip the version bump (which
        # would perturb overlayHash + spawn redundant snapshot rows downstream).
        return _att_out(att)

    att.version = (att.version or 1) + 1
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "the requested scope/target collides with another active attachment on this edge")
    await record_event(
        db, actor_user_id=_actor(current_user), event_type="governance_attachment_updated",
        capability_id=capability_id, target_type="governance_attachment", target_id=att.id,
        payload={"before": before,
                 "after": {"mode": att.mode, "scope": att.scope, "target_kind": att.target_kind,
                           "target_key": att.target_key, "priority": att.priority,
                           "waiver_allowed": att.waiver_allowed},
                 "version": att.version, **_actor_meta(current_user)},
    )
    await db.commit()
    await db.refresh(att)
    emit_audit_event(
        kind="governance.attachment.updated",
        actor_id=str(getattr(current_user, "id", "") or "") or None,
        capability_id=capability_id, subject_type="governance_attachment", subject_id=att.id,
        severity="warning" if MODE_RANK[att.mode] >= _ENFORCING_MIN_RANK else "info",
        payload={"before": before, "after": {"mode": att.mode, "scope": att.scope},
                 **_actor_meta(current_user)},
    )
    return _att_out(att)


async def _set_active(db, capability_id: str, attachment_id: str, current_user, *, active: bool):
    att = (await db.execute(select(GovernanceAttachment).where(
        GovernanceAttachment.id == attachment_id,
        GovernanceAttachment.capability_id == capability_id,
    ))).scalar_one_or_none()
    if att is None:
        raise HTTPException(404, f"attachment {attachment_id!r} not found on capability {capability_id!r}")
    # Touching an enforcing attachment (either direction) needs enforcing
    # authority — you can't silently disable a BLOCKING control with mere
    # ADVISORY-authoring rights, nor re-arm one.
    _assert_governance_authority(current_user, enforcing=MODE_RANK[att.mode] >= _ENFORCING_MIN_RANK)
    if att.is_active == active:
        return att  # idempotent no-op (no version bump)
    att.is_active = active
    att.version = (att.version or 1) + 1
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            409, "reactivating collides with another active attachment for this scope/target; "
                 "deactivate the other first or PATCH its scope",
        )
    verb = "reactivated" if active else "deactivated"
    await record_event(
        db, actor_user_id=_actor(current_user), event_type=f"governance_attachment_{verb}",
        capability_id=capability_id, target_type="governance_attachment", target_id=att.id,
        payload={"mode": att.mode, "scope": att.scope, "target_key": att.target_key,
                 "version": att.version, **_actor_meta(current_user)},
    )
    await db.commit()
    await db.refresh(att)
    emit_audit_event(
        kind=f"governance.attachment.{verb}",
        actor_id=str(getattr(current_user, "id", "") or "") or None,
        capability_id=capability_id, subject_type="governance_attachment", subject_id=att.id,
        severity="warning" if MODE_RANK[att.mode] >= _ENFORCING_MIN_RANK else "info",
        payload={"mode": att.mode, "scope": att.scope, **_actor_meta(current_user)},
    )
    return att


@router.post("/capabilities/{capability_id}/governed-by/{attachment_id}/deactivate",
             response_model=GovernanceAttachmentOut)
async def deactivate_governance(
    capability_id: str, attachment_id: str,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    return _att_out(await _set_active(db, capability_id, attachment_id, current_user, active=False))


@router.post("/capabilities/{capability_id}/governed-by/{attachment_id}/reactivate",
             response_model=GovernanceAttachmentOut)
async def reactivate_governance(
    capability_id: str, attachment_id: str,
    db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user),
):
    return _att_out(await _set_active(db, capability_id, attachment_id, current_user, active=True))


@router.post("/governance/resolve")
async def resolve_governance(
    body: GovernanceResolveRequest,
    db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user),
):
    rows = (await db.execute(select(GovernanceAttachment).where(
        GovernanceAttachment.capability_id == body.capability_id,
        GovernanceAttachment.is_active.is_(True),
    ))).scalars().all()

    gids = {r.governing_capability_id for r in rows}
    names: dict[str, str] = {}
    if gids:
        caps = (await db.execute(
            select(Capability).where(Capability.capability_id.in_(gids))
        )).scalars().all()
        names = {c.capability_id: c.name for c in caps}

    attachments = [{
        "id": r.id,
        "governing_capability_id": r.governing_capability_id,
        "governing_name": names.get(r.governing_capability_id),
        "mode": r.mode, "scope": r.scope,
        "target_kind": r.target_kind, "target_key": r.target_key,
        "priority": r.priority, "is_active": r.is_active,
        "effective_from": r.effective_from, "effective_to": r.effective_to,
        "waiver_allowed": r.waiver_allowed, "version": r.version,
        "contributions": r.contributions or {},
    } for r in rows]

    ctx = {
        "governedCapabilityId": body.capability_id,
        "workItemType": body.work_item_type, "workflowType": body.workflow_type,
        "workflowId": body.workflow_id, "stageKey": body.stage_key,
        "agentRole": body.agent_role, "nodeId": body.node_id, "riskLevel": body.risk_level,
    }
    overlay = resolve_overlay(ctx, attachments, datetime.now(timezone.utc))
    # G9 — live-fetch any promptLayer that links to a markdown doc (sourceUrl).
    await enrich_overlay_prompt_layers(overlay)
    overlay["overlayId"] = "gov_overlay_" + uuid.uuid4().hex[:16]
    overlay["resolvedAt"] = datetime.now(timezone.utc).isoformat()
    return {"success": True, "data": overlay}
