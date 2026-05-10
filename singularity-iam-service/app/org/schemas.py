from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class BusinessUnitOut(BaseModel):
    id: str
    bu_key: str
    name: str
    description: Optional[str]
    parent_bu_id: Optional[str]
    metadata: dict
    tags: list[str]
    created_at: datetime
    updated_at: datetime


class CreateBusinessUnitRequest(BaseModel):
    bu_key: str
    name: str
    description: Optional[str] = None
    parent_bu_id: Optional[str] = None
    metadata: Optional[dict] = None
    tags: Optional[list[str]] = None


class TeamOut(BaseModel):
    id: str
    team_key: str
    name: str
    description: Optional[str]
    bu_id: Optional[str]
    parent_team_id: Optional[str]
    metadata: dict
    tags: list[str]
    created_at: datetime
    updated_at: datetime


class CreateTeamRequest(BaseModel):
    team_key: str
    name: str
    description: Optional[str] = None
    bu_key: Optional[str] = None
    parent_team_id: Optional[str] = None
    metadata: Optional[dict] = None
    tags: Optional[list[str]] = None


class TeamMembershipOut(BaseModel):
    id: str
    team_id: str
    user_id: str
    membership_type: str
    created_at: datetime


class AddTeamMemberRequest(BaseModel):
    user_id: str
    membership_type: str = "member"
