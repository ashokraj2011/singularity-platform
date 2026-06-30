"""Pydantic wire models for the Git credential broker (P0 #2)."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


# ── Internal: credential issuance (called by Context Fabric) ────────────────
class IssueCredentialRequest(BaseModel):
    tenantId: str
    userId: Optional[str] = None
    repo: str
    operation: str
    runId: Optional[str] = None
    nodeId: Optional[str] = None
    workflowInstanceId: Optional[str] = None
    capabilityId: Optional[str] = None
    grantNonce: Optional[str] = None


class IssueCredentialResponse(BaseModel):
    issuanceId: str
    provider: str
    token: str
    expiresAt: Optional[str] = None
    repo: str
    allowedOperation: str


# ── Admin: GitHub App connections ──────────────────────────────────────────
class CreateConnectionRequest(BaseModel):
    tenantId: str
    appId: str
    installationId: str
    accountLogin: Optional[str] = None
    privateKey: str
    provider: str = "github_app"


class ConnectionOut(BaseModel):
    # NB: privateKey is intentionally never serialized back.
    id: str
    tenantId: str
    provider: str
    appId: str
    installationId: str
    accountLogin: Optional[str] = None
    status: str


# ── Admin: repository grants ───────────────────────────────────────────────
class CreateRepositoryGrantRequest(BaseModel):
    tenantId: str
    subjectType: str  # user | team | capability
    subjectId: str
    repo: str
    operations: list[str]


class RepositoryGrantOut(BaseModel):
    id: str
    tenantId: str
    subjectType: str
    subjectId: str
    repo: str
    operations: list[str]
    status: str
