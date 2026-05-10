from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class UserOut(BaseModel):
    id: str
    email: str
    display_name: Optional[str]
    status: str
    auth_provider: Optional[str]
    external_subject: Optional[str]
    is_super_admin: bool
    is_local_account: bool
    metadata: dict
    tags: list[str]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CreateUserRequest(BaseModel):
    email: str
    display_name: Optional[str] = None
    auth_provider: Optional[str] = None
    external_subject: Optional[str] = None
    metadata: Optional[dict] = None
    tags: Optional[list[str]] = None


class UpdateUserRequest(BaseModel):
    display_name: Optional[str] = None
    status: Optional[str] = None
    is_super_admin: Optional[bool] = None
    metadata: Optional[dict] = None
    tags: Optional[list[str]] = None
