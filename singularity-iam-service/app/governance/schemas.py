from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class CreateGovernedByRequest(BaseModel):
    """Attach a governing capability to an operational capability (a `governed_by`
    edge + one scoped governance attachment)."""
    governing_capability_id: str
    mode: str = "ADVISORY"          # ADVISORY | REQUIRED | BLOCKING
    scope: str = "ALL"              # ALL | WORK_ITEM_TYPE | WORKFLOW_TYPE | WORKFLOW | STAGE
    target_kind: Optional[str] = None
    target_key: Optional[str] = None
    priority: int = 100
    effective_from: Optional[datetime] = None
    effective_to: Optional[datetime] = None
    waiver_allowed: bool = False
    inheritance_policy: str = "none"
    # Governance payload: { promptLayers[], requiredEvidence[], verifierAgents[],
    # toolPolicy{}, approvalGates[], waiverRules[], blockingControls[] }.
    contributions: Optional[dict] = None


class UpdateGovernedByRequest(BaseModel):
    """Patch an existing governance attachment (G7a). All fields optional —
    only provided fields change. Any governance-relevant change bumps the
    attachment's `version` (so resolved-overlay `versionPins` stay unique).
    `mode`/`scope` are validated against MODE_RANK/SCOPE_RANK; raising mode to
    REQUIRED/BLOCKING is gated by elevated authority at the route layer."""
    mode: Optional[str] = None
    scope: Optional[str] = None
    target_kind: Optional[str] = None
    target_key: Optional[str] = None
    priority: Optional[int] = None
    effective_from: Optional[datetime] = None
    effective_to: Optional[datetime] = None
    waiver_allowed: Optional[bool] = None
    contributions: Optional[dict] = None


class GovernanceAttachmentOut(BaseModel):
    id: str
    relationship_id: str
    capability_id: str
    governing_capability_id: str
    mode: str
    scope: str
    target_kind: Optional[str]
    target_key: Optional[str]
    priority: int
    is_active: bool
    effective_from: Optional[datetime]
    effective_to: Optional[datetime]
    waiver_allowed: bool
    version: int
    contributions: dict
    created_at: datetime
    updated_at: Optional[datetime] = None


class GovernanceResolveRequest(BaseModel):
    capability_id: str                       # governed operational capability
    work_item_type: Optional[str] = None
    workflow_type: Optional[str] = None
    workflow_id: Optional[str] = None
    stage_key: Optional[str] = None
    agent_role: Optional[str] = None
    node_id: Optional[str] = None
    risk_level: Optional[str] = None
