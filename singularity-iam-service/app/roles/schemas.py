from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class PermissionOut(BaseModel):
    id: str
    permission_key: str
    description: Optional[str]
    category: Optional[str]
    created_at: datetime


class RoleOut(BaseModel):
    id: str
    role_key: str
    name: str
    description: Optional[str]
    role_scope: str
    system_role: bool
    metadata: dict
    tags: list[str]
    created_at: datetime
    updated_at: datetime


class CreateRoleRequest(BaseModel):
    role_key: str
    name: str
    description: Optional[str] = None
    role_scope: str = "capability"
    metadata: Optional[dict] = None
    tags: Optional[list[str]] = None


class AssignPermissionRequest(BaseModel):
    permission_key: str
