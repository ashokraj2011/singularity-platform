from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


class RuntimeEnrollmentRequest(BaseModel):
    runtime_name: str = Field(default="Singularity Runtime", min_length=1, max_length=200)
    tenant_id: Optional[str] = Field(default=None, max_length=128)
    runtime_scope: Literal["user", "tenant", "shared"] = "user"
    scopes: Optional[list[str]] = None
    allowed_frame_types: Optional[list[str]] = None
    capability_tags: Optional[list[str]] = None
    ttl_minutes: int = Field(default=10, ge=2, le=30)
    token_ttl_days: int = Field(default=90, ge=1, le=365)


class RuntimeEnrollmentResponse(BaseModel):
    enrollment_id: str
    code: str
    runtime_name: str
    runtime_scope: str
    tenant_id: Optional[str]
    expires_at: datetime
    token_ttl_days: int


class RuntimeEnrollmentExchangeRequest(BaseModel):
    code: str = Field(min_length=8, max_length=128)
    device_id: Optional[str] = Field(default=None, max_length=128)
    device_name: Optional[str] = Field(default=None, max_length=200)


class RuntimeEnrollmentExchangeResponse(BaseModel):
    access_token: str
    token_kind: Literal["runtime"] = "runtime"
    runtime_id: str
    device_id: str
    user_id: str
    email: str
    runtime_name: str
    runtime_scope: str
    tenant_id: Optional[str]
    scopes: list[str]
    allowed_frame_types: list[str]
    capability_tags: list[str]
    expires_in_days: int
