from pydantic import BaseModel
from typing import Optional


class AuthzCheckRequest(BaseModel):
    user_id: str
    capability_id: str
    action: str
    resource_type: Optional[str] = None
    resource_id: Optional[str] = None
    requesting_capability_id: Optional[str] = None


class AuthzCheckResponse(BaseModel):
    allowed: bool
    reason: Optional[str] = None
    roles: list[str] = []
    permissions: list[str] = []
    source: Optional[str] = None


class BulkCheckRequest(BaseModel):
    user_id: str
    checks: list[AuthzCheckRequest]


class BulkCheckResponse(BaseModel):
    results: list[AuthzCheckResponse]
