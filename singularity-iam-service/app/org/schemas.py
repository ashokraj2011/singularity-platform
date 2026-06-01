from pydantic import BaseModel, Field
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


class UpdateTeamRequest(BaseModel):
    # All optional → PATCH semantics. parent_team_id is tri-state: omitted =
    # "leave as is"; explicit null = "detach (make it a root team)"; a value =
    # "set/move parent" (cycle-guarded server-side).
    name: Optional[str] = None
    description: Optional[str] = None
    parent_team_id: Optional[str] = Field(default=None)
    # Distinguish "parent_team_id was provided (even as null)" from "omitted",
    # since None is a meaningful value here.
    model_config = {"extra": "forbid"}

    # Track which fields were explicitly set by the client.
    def provided_fields(self) -> set[str]:
        return set(self.model_fields_set)


class SetChildTeamRequest(BaseModel):
    # Re-parent an existing team under {team_id}.
    child_team_id: str


class TeamMembershipOut(BaseModel):
    id: str
    team_id: str
    user_id: str
    membership_type: str
    created_at: datetime


class AddTeamMemberRequest(BaseModel):
    user_id: str
    membership_type: str = "member"
