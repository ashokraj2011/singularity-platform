from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class CapabilityOut(BaseModel):
    id: str
    capability_id: str
    name: str
    description: Optional[str]
    capability_type: str
    status: str
    visibility: str
    owner_bu_id: Optional[str]
    owner_team_id: Optional[str]
    metadata: dict
    tags: list[str]
    created_by: Optional[str]
    created_at: datetime
    updated_at: datetime


class CreateCapabilityRequest(BaseModel):
    capability_id: str
    name: str
    description: Optional[str] = None
    capability_type: str
    visibility: str = "private"
    owner_bu_key: Optional[str] = None
    owner_team_key: Optional[str] = None
    metadata: Optional[dict] = None
    tags: Optional[list[str]] = None


class UpdateCapabilityRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    visibility: Optional[str] = None
    metadata: Optional[dict] = None
    tags: Optional[list[str]] = None


class CapabilityRelationshipOut(BaseModel):
    id: str
    source_capability_id: str
    target_capability_id: str
    relationship_type: str
    inheritance_policy: str
    metadata: dict
    created_at: datetime


class CreateCapabilityRelationshipRequest(BaseModel):
    target_capability_id: str
    relationship_type: str
    inheritance_policy: str = "none"
    metadata: Optional[dict] = None


class CapabilityMembershipOut(BaseModel):
    id: str
    capability_id: str
    user_id: Optional[str]
    team_id: Optional[str]
    role_id: str
    status: str
    granted_by: Optional[str]
    valid_from: Optional[datetime]
    valid_until: Optional[datetime]
    metadata: dict
    created_at: datetime


class AddCapabilityMemberRequest(BaseModel):
    user_id: Optional[str] = None
    team_id: Optional[str] = None
    role_key: str


class SharingGrantOut(BaseModel):
    id: str
    provider_capability_id: str
    consumer_capability_id: str
    grant_type: str
    allowed_permissions: list[str]
    status: str
    approved_by: Optional[str]
    approved_at: Optional[datetime]
    metadata: dict
    created_at: datetime


class CreateSharingGrantRequest(BaseModel):
    provider_capability_id: str
    consumer_capability_id: str
    grant_type: str
    allowed_permissions: list[str]
    metadata: Optional[dict] = None
