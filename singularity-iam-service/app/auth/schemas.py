from pydantic import BaseModel


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenUserOut(BaseModel):
    id: str
    email: str
    display_name: str | None
    is_super_admin: bool


class MeResponse(TokenUserOut):
    """`/me` — the caller's identity plus their effective PLATFORM-level permission
    keys, so downstream services can gate on permissions (e.g. ``platform:all``)
    rather than only role-name strings. Additive: existing consumers ignore it."""
    permissions: list[str] = []


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: TokenUserOut
