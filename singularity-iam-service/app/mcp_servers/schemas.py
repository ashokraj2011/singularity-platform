from pydantic import BaseModel, HttpUrl, Field
from typing import Optional, Literal
from datetime import datetime


AuthMethod = Literal["BEARER_TOKEN"]   # v0: only BEARER_TOKEN supported
Protocol = Literal["MCP_HTTP", "MCP_WS"]
McpStatus = Literal["active", "suspended", "registering", "failed"]


class McpServerOut(BaseModel):
    id: str
    capability_id: str
    name: str
    description: Optional[str]
    base_url: str
    auth_method: AuthMethod
    bearer_token: str    # returned to authorized callers (context-fabric uses it to dial MCP)
    protocol: Protocol
    protocol_version: Optional[str]
    status: McpStatus
    last_health_check_at: Optional[datetime]
    last_health_check_status: Optional[str]
    metadata: dict
    tags: list[str]
    created_by: Optional[str]
    created_at: datetime
    updated_at: datetime


class McpServerSummary(BaseModel):
    """Same as McpServerOut but with the bearer token redacted — used for list endpoints."""
    id: str
    capability_id: str
    name: str
    description: Optional[str]
    base_url: str
    auth_method: AuthMethod
    has_token: bool
    protocol: Protocol
    protocol_version: Optional[str]
    status: McpStatus
    last_health_check_at: Optional[datetime]
    last_health_check_status: Optional[str]
    metadata: dict
    tags: list[str]
    created_at: datetime
    updated_at: datetime


class CreateMcpServerRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = None
    base_url: HttpUrl
    auth_method: AuthMethod = "BEARER_TOKEN"
    bearer_token: str = Field(min_length=8)
    protocol: Protocol = "MCP_HTTP"
    protocol_version: Optional[str] = None
    metadata: Optional[dict] = None
    tags: Optional[list[str]] = None


class UpdateMcpServerRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    base_url: Optional[HttpUrl] = None
    bearer_token: Optional[str] = Field(default=None, min_length=8)
    protocol: Optional[Protocol] = None
    protocol_version: Optional[str] = None
    status: Optional[McpStatus] = None
    metadata: Optional[dict] = None
    tags: Optional[list[str]] = None


class HealthCheckOut(BaseModel):
    server_id: str
    base_url: str
    status: McpStatus
    http_status: Optional[int]
    latency_ms: Optional[int]
    error: Optional[str]
    checked_at: datetime
