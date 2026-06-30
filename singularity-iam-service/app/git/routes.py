"""Git credential broker routes (P0 #2).

Internal (service token, scope ``git:issue-credentials``):
  POST /api/v1/internal/git/credentials/issue
    Context Fabric calls this to mint a short-lived, repo-scoped GitHub App token
    bound to a verified repository grant. The token is returned but NEVER stored
    — only a fingerprint + expiry land on the issuance record.

Admin (super-admin):
  POST/GET /api/v1/git/connections          — manage GitHub App connections
  POST/GET /api/v1/git/repository-grants    — manage per-subject repo grants
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.service import record_event
from app.auth.deps import require_git_credential_issue, require_super_admin
from app.database import get_db
from app.git import github_app
from app.git.schemas import (
    ConnectionOut,
    CreateConnectionRequest,
    CreateRepositoryGrantRequest,
    IssueCredentialRequest,
    IssueCredentialResponse,
    RepositoryGrantOut,
)
from app.models import (
    GitCredentialIssuance,
    GitProviderConnection,
    GitRepositoryGrant,
    TeamMembership,
)

# Internal credential issuance lives under /internal/git/credentials; admin CRUD
# under /git. One router, both prefixed with /api/v1 at mount time.
router = APIRouter(tags=["git"])


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _normalize_repo(repo: str) -> str:
    """Reduce a repo URL or owner/name to a canonical ``owner/name``."""
    r = (repo or "").strip()
    r = r.removeprefix("https://github.com/").removeprefix("http://github.com/").removeprefix("git@github.com:")
    r = r.removesuffix(".git")
    return r.strip("/")


async def _user_team_ids(db: AsyncSession, user_id: str) -> list[str]:
    rows = await db.execute(select(TeamMembership.team_id).where(TeamMembership.user_id == user_id))
    return [str(t) for t in rows.scalars().all()]


def _conn_out(c: GitProviderConnection) -> ConnectionOut:
    return ConnectionOut(
        id=c.id, tenantId=c.tenant_id, provider=c.provider, appId=c.app_id,
        installationId=c.installation_id, accountLogin=c.account_login, status=c.status,
    )


def _grant_out(g: GitRepositoryGrant) -> RepositoryGrantOut:
    return RepositoryGrantOut(
        id=g.id, tenantId=g.tenant_id, subjectType=g.subject_type, subjectId=g.subject_id,
        repo=g.repo, operations=list(g.operations or []), status=g.status,
    )


# ── Internal: issue a short-lived git credential ───────────────────────────
@router.post("/internal/git/credentials/issue", response_model=IssueCredentialResponse)
async def issue_credential(
    body: IssueCredentialRequest,
    db: AsyncSession = Depends(get_db),
    principal=Depends(require_git_credential_issue),
) -> IssueCredentialResponse:
    github_app.assert_plaintext_storage_allowed()  # hard pre-prod gate

    # Tenant scoping: a service token may be limited to specific tenants.
    tenant_ids = getattr(principal, "tenant_ids", None) or []
    if tenant_ids and body.tenantId not in tenant_ids:
        raise HTTPException(status_code=403, detail="service token not authorized for this tenant")

    repo = _normalize_repo(body.repo)
    operation = (body.operation or "").strip().lower()
    if not repo or not operation:
        raise HTTPException(status_code=400, detail="repo and operation are required")

    # Authz — a matching active grant for (user ∪ user's teams ∪ capability) × repo × op.
    subjects: set[tuple[str, str]] = set()
    if body.userId:
        subjects.add(("user", body.userId))
        for tid in await _user_team_ids(db, body.userId):
            subjects.add(("team", tid))
    if body.capabilityId:
        subjects.add(("capability", body.capabilityId))
    if not subjects:
        raise HTTPException(status_code=403, detail="no subject (userId/capabilityId) to authorize")

    grant_rows = await db.execute(
        select(GitRepositoryGrant).where(
            GitRepositoryGrant.tenant_id == body.tenantId,
            GitRepositoryGrant.repo == repo,
            GitRepositoryGrant.status == "active",
        )
    )
    authorized = any(
        (g.subject_type, g.subject_id) in subjects
        and operation in [str(o).lower() for o in (g.operations or [])]
        for g in grant_rows.scalars().all()
    )
    if not authorized:
        raise HTTPException(status_code=403, detail=f"no git grant for {repo} operation={operation}")

    # Resolve the tenant's GitHub App connection (prefer one whose account_login
    # matches the repo owner; else any active connection for the tenant).
    owner = repo.split("/")[0] if "/" in repo else None
    conn_rows = await db.execute(
        select(GitProviderConnection).where(
            GitProviderConnection.tenant_id == body.tenantId,
            GitProviderConnection.status == "active",
        )
    )
    conns = list(conn_rows.scalars().all())
    conn = next((c for c in conns if owner and c.account_login == owner), None) or (conns[0] if conns else None)
    if conn is None:
        raise HTTPException(status_code=400, detail="no active GitHub App connection for tenant")

    try:
        minted = await github_app.mint_installation_token(
            app_id=conn.app_id,
            installation_id=conn.installation_id,
            private_key=conn.private_key,
            repo=repo,
            operation=operation,
        )
    except RuntimeError as err:
        raise HTTPException(status_code=502, detail=str(err)) from err

    issuance = GitCredentialIssuance(
        tenant_id=body.tenantId, user_id=body.userId, repo=repo, operation=operation,
        run_id=body.runId, node_id=body.nodeId, workflow_instance_id=body.workflowInstanceId,
        grant_nonce=body.grantNonce, provider=conn.provider,
        token_fingerprint=github_app.token_fingerprint(minted["token"]),
        expires_at=_parse_dt(minted.get("expires_at")),
    )
    db.add(issuance)
    await db.flush()
    await record_event(
        db, event_type="git_credential_issued", actor_user_id=body.userId,
        capability_id=body.capabilityId, target_type="git_credential", target_id=issuance.id,
        payload={
            "repo": repo, "operation": operation, "provider": conn.provider,
            "expires_at": minted.get("expires_at"), "grant_nonce": body.grantNonce,
            "token_fingerprint": issuance.token_fingerprint,
        },
    )
    await db.commit()

    return IssueCredentialResponse(
        issuanceId=issuance.id, provider=conn.provider, token=minted["token"],
        expiresAt=minted.get("expires_at"), repo=repo, allowedOperation=operation,
    )


# ── Admin: GitHub App connections ──────────────────────────────────────────
@router.post("/git/connections", response_model=ConnectionOut, status_code=201)
async def create_connection(
    body: CreateConnectionRequest,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_super_admin),
) -> ConnectionOut:
    github_app.assert_plaintext_storage_allowed()
    conn = GitProviderConnection(
        tenant_id=body.tenantId, provider=body.provider, app_id=body.appId,
        installation_id=body.installationId, account_login=body.accountLogin,
        private_key=body.privateKey,
    )
    db.add(conn)
    await db.flush()
    await record_event(
        db, event_type="git_connection_created", actor_user_id=current_user.id,
        target_type="git_connection", target_id=conn.id,
        payload={"tenant_id": body.tenantId, "app_id": body.appId, "account_login": body.accountLogin},
    )
    await db.commit()
    await db.refresh(conn)
    return _conn_out(conn)


@router.get("/git/connections", response_model=list[ConnectionOut])
async def list_connections(
    tenantId: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_super_admin),
) -> list[ConnectionOut]:
    q = select(GitProviderConnection)
    if tenantId:
        q = q.where(GitProviderConnection.tenant_id == tenantId)
    rows = await db.execute(q)
    return [_conn_out(c) for c in rows.scalars().all()]


# ── Admin: repository grants ───────────────────────────────────────────────
@router.post("/git/repository-grants", response_model=RepositoryGrantOut, status_code=201)
async def create_repository_grant(
    body: CreateRepositoryGrantRequest,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_super_admin),
) -> RepositoryGrantOut:
    if body.subjectType not in ("user", "team", "capability"):
        raise HTTPException(status_code=400, detail="subjectType must be user|team|capability")
    grant = GitRepositoryGrant(
        tenant_id=body.tenantId, subject_type=body.subjectType, subject_id=body.subjectId,
        repo=_normalize_repo(body.repo), operations=[str(o).lower() for o in body.operations],
        approved_by=current_user.id, approved_at=_now_dt(),
    )
    db.add(grant)
    await db.flush()
    await record_event(
        db, event_type="git_repository_grant_created", actor_user_id=current_user.id,
        target_type="git_repository_grant", target_id=grant.id,
        payload={
            "tenant_id": body.tenantId, "subject": f"{body.subjectType}:{body.subjectId}",
            "repo": grant.repo, "operations": grant.operations,
        },
    )
    await db.commit()
    await db.refresh(grant)
    return _grant_out(grant)


@router.get("/git/repository-grants", response_model=list[RepositoryGrantOut])
async def list_repository_grants(
    tenantId: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(require_super_admin),
) -> list[RepositoryGrantOut]:
    q = select(GitRepositoryGrant)
    if tenantId:
        q = q.where(GitRepositoryGrant.tenant_id == tenantId)
    rows = await db.execute(q)
    return [_grant_out(g) for g in rows.scalars().all()]
