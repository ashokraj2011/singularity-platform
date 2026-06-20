from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field


class DeviceTokenRequest(BaseModel):
    # Client-generated UUID. Stable per-laptop; minted at first `singularity-mcp
    # login` and reused across keychain reads on the same machine.
    device_id:   Optional[str] = Field(default=None, max_length=128)
    device_name: Optional[str] = Field(default=None, max_length=200)
    scopes:      Optional[list[str]] = None
    ttl_days:    int = Field(default=90, ge=1, le=365)
    token_kind:  Literal["device", "runtime"] = "device"
    tenant_id:   Optional[str] = Field(default=None, max_length=128)
    runtime_type: Optional[str] = Field(default="mcp", max_length=64)
    runtime_scope: Optional[Literal["user", "tenant", "shared"]] = "user"
    allowed_frame_types: Optional[list[str]] = None
    capability_tags: Optional[list[str]] = None


class DeviceTokenResponse(BaseModel):
    access_token:     str
    token_kind:       str = "device"
    device_id:        str
    user_id:          str
    email:            str
    device_name:      Optional[str]
    scopes:           list[str]
    expires_in_days:  int


class DeviceOut(BaseModel):
    id:           str
    user_id:      str
    device_id:    str
    device_name:  Optional[str]
    scopes:       list[str]
    created_at:   datetime
    last_seen_at: Optional[datetime]
    revoked_at:   Optional[datetime]


class DeviceList(BaseModel):
    items: list[DeviceOut]
    total: int
