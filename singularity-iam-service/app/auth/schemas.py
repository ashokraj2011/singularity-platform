from pydantic import BaseModel


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenUserOut(BaseModel):
    id: str
    email: str
    display_name: str | None
    is_super_admin: bool


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: TokenUserOut
