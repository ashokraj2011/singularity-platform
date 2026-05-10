# Authentication Configuration

This document covers every authentication method supported by the Singularity IAM Service, how to configure each one, and the code paths involved.

---

## Table of Contents

1. [How authentication works](#how-authentication-works)
2. [Local (username / password)](#1-local-username--password)
3. [OAuth2 / OpenID Connect](#2-oauth2--openid-connect)
4. [SAML 2.0](#3-saml-20)
5. [API Key (service-to-service)](#4-api-key-service-to-service)
6. [JWT configuration](#5-jwt-configuration)
7. [Multi-factor authentication (MFA / TOTP)](#6-multi-factor-authentication-mfa--totp)
8. [Environment variable reference](#environment-variable-reference)

---

## How authentication works

Every authentication method ultimately produces the same thing: a short-lived JWT that the caller presents on subsequent requests.

```
Client ──► POST /api/v1/auth/<method>/login
              │
              ▼
         Verify identity
         (password / token / assertion)
              │
              ▼
         Look up or create User row
         (auth_provider + external_subject)
              │
              ▼
         create_access_token(user.id, user.email, user.is_super_admin)
              │
              ▼
         Return { access_token, token_type, user }
```

All protected endpoints read the token via the `HTTPBearer` scheme in
[`app/auth/deps.py`](app/auth/deps.py):

```
Authorization: Bearer <token>
```

The `User` row that backs every identity has two fields that identify the
originating provider:

| Field | Purpose |
|---|---|
| `auth_provider` | `"local"`, `"google"`, `"microsoft"`, `"github"`, `"saml"`, … |
| `external_subject` | The provider's stable unique ID for this user (sub claim, nameID, …) |
| `is_local_account` | `True` only for local-password accounts |

---

## 1. Local (username / password)

### What is it?

Users authenticate with an email address and a bcrypt-hashed password stored in
the `iam.local_credentials` table. This is the only method enabled out of the
box.

### Endpoint

```
POST /api/v1/auth/local/login
Content-Type: application/json

{ "email": "alice@example.com", "password": "s3cret!" }
```

### Configuration

```ini
# .env
LOCAL_SUPER_ADMIN_EMAIL=admin@singularity.local
LOCAL_SUPER_ADMIN_PASSWORD=Admin1234!          # change on first deploy
JWT_SECRET=<random-256-bit-hex>
JWT_EXPIRE_MINUTES=60
```

The super-admin account is seeded automatically on first startup by
[`app/seed/runner.py`](app/seed/runner.py). To create additional local users
call `POST /api/v1/users` with `auth_provider="local"` then set their
password via the admin UI or a direct DB update.

### Code path

```
app/auth/routes.py  →  local_login()
  app/auth/password.py  →  verify_password(plain, hash)   # passlib bcrypt
  app/auth/jwt.py       →  create_access_token()          # PyJWT HS256
```

### Password hashing details

| Setting | Value |
|---|---|
| Algorithm | bcrypt |
| Library | passlib 1.7.4 + bcrypt 3.x |
| Work factor | bcrypt default (12 rounds) |

To change the work factor edit [`app/auth/password.py`](app/auth/password.py):

```python
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=14)
```

---

## 2. OAuth2 / OpenID Connect

### What is it?

Users are redirected to an external identity provider (Google Workspace,
Microsoft Entra ID, GitHub, Okta, etc.). After consent the provider issues an
authorization code that the IAM service exchanges for an ID token containing
the user's identity claims.

### How to add it

**Step 1 — Install the OAuth2 client library**

```bash
pip install "authlib>=1.3"         # handles PKCE, token exchange, JWKS
```

Add to `pyproject.toml`:

```toml
"authlib>=1.3",
```

And add to the `Dockerfile` pip install line:

```dockerfile
"authlib>=1.3"
```

**Step 2 — Add env vars**

```ini
# .env

# Google
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
GOOGLE_REDIRECT_URI=http://localhost:8100/api/v1/auth/google/callback

# Microsoft (Entra / Azure AD)
MICROSOFT_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_CLIENT_SECRET=xxxx~xxxx
MICROSOFT_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MICROSOFT_REDIRECT_URI=http://localhost:8100/api/v1/auth/microsoft/callback

# GitHub
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_REDIRECT_URI=http://localhost:8100/api/v1/auth/github/callback
```

Add to [`app/config.py`](app/config.py):

```python
GOOGLE_CLIENT_ID: str | None = None
GOOGLE_CLIENT_SECRET: str | None = None
GOOGLE_REDIRECT_URI: str = "http://localhost:8100/api/v1/auth/google/callback"

MICROSOFT_CLIENT_ID: str | None = None
MICROSOFT_CLIENT_SECRET: str | None = None
MICROSOFT_TENANT_ID: str | None = None
MICROSOFT_REDIRECT_URI: str = "http://localhost:8100/api/v1/auth/microsoft/callback"

GITHUB_CLIENT_ID: str | None = None
GITHUB_CLIENT_SECRET: str | None = None
GITHUB_REDIRECT_URI: str = "http://localhost:8100/api/v1/auth/github/callback"
```

**Step 3 — Create `app/auth/oauth_routes.py`**

```python
from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.database import get_db
from app.models import User
from app.auth.jwt import create_access_token
from app.auth.schemas import LoginResponse, TokenUserOut
from app.config import settings

router = APIRouter(prefix="/auth", tags=["auth/oauth"])
oauth = OAuth()

# ── Google ──────────────────────────────────────────────────────────────────

if settings.GOOGLE_CLIENT_ID:
    oauth.register(
        name="google",
        client_id=settings.GOOGLE_CLIENT_ID,
        client_secret=settings.GOOGLE_CLIENT_SECRET,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )

    @router.get("/google/login")
    async def google_login(request: Request):
        return await oauth.google.authorize_redirect(
            request, settings.GOOGLE_REDIRECT_URI
        )

    @router.get("/google/callback", response_model=LoginResponse)
    async def google_callback(request: Request, db: AsyncSession = Depends(get_db)):
        token = await oauth.google.authorize_access_token(request)
        userinfo = token["userinfo"]
        return await _upsert_oauth_user(
            db,
            provider="google",
            subject=userinfo["sub"],
            email=userinfo["email"],
            display_name=userinfo.get("name"),
        )

# ── Microsoft ────────────────────────────────────────────────────────────────

if settings.MICROSOFT_CLIENT_ID:
    oauth.register(
        name="microsoft",
        client_id=settings.MICROSOFT_CLIENT_ID,
        client_secret=settings.MICROSOFT_CLIENT_SECRET,
        server_metadata_url=(
            f"https://login.microsoftonline.com/{settings.MICROSOFT_TENANT_ID}"
            "/v2.0/.well-known/openid-configuration"
        ),
        client_kwargs={"scope": "openid email profile"},
    )

    @router.get("/microsoft/login")
    async def microsoft_login(request: Request):
        return await oauth.microsoft.authorize_redirect(
            request, settings.MICROSOFT_REDIRECT_URI
        )

    @router.get("/microsoft/callback", response_model=LoginResponse)
    async def microsoft_callback(request: Request, db: AsyncSession = Depends(get_db)):
        token = await oauth.microsoft.authorize_access_token(request)
        userinfo = token["userinfo"]
        return await _upsert_oauth_user(
            db,
            provider="microsoft",
            subject=userinfo["sub"],
            email=userinfo.get("email") or userinfo.get("preferred_username"),
            display_name=userinfo.get("name"),
        )

# ── Shared helper ────────────────────────────────────────────────────────────

async def _upsert_oauth_user(
    db: AsyncSession, provider: str, subject: str, email: str, display_name: str | None
) -> LoginResponse:
    user = (await db.execute(
        select(User).where(
            User.auth_provider == provider, User.external_subject == subject
        )
    )).scalar_one_or_none()

    if not user:
        user = User(
            email=email,
            display_name=display_name,
            auth_provider=provider,
            external_subject=subject,
            is_local_account=False,
            status="active",
        )
        db.add(user)
        await db.flush()

    await db.commit()
    token = create_access_token(user.id, user.email, user.is_super_admin)
    return LoginResponse(
        access_token=token,
        user=TokenUserOut(
            id=user.id, email=user.email,
            display_name=user.display_name, is_super_admin=user.is_super_admin,
        ),
    )
```

**Step 4 — Mount the router in `app/main.py`**

```python
from app.auth.oauth_routes import router as oauth_router
app.include_router(oauth_router, prefix=PREFIX)
```

**Step 5 — Add session middleware** (Authlib needs server-side state for PKCE)

```python
# app/main.py
from starlette.middleware.sessions import SessionMiddleware
app.add_middleware(SessionMiddleware, secret_key=settings.JWT_SECRET)
```

### Provider-specific notes

| Provider | Discovery URL | Notes |
|---|---|---|
| Google | `https://accounts.google.com/.well-known/openid-configuration` | Add authorized redirect URI in Google Cloud Console |
| Microsoft | `https://login.microsoftonline.com/{tenant}/v2.0/.well-known/...` | Use `common` as tenant for multi-tenant apps |
| GitHub | No OIDC — use `https://github.com/login/oauth/authorize` + `/user` API | `sub` = numeric GitHub user ID |
| Okta | `https://{domain}.okta.com/.well-known/openid-configuration` | Requires Okta application created in admin console |
| Auth0 | `https://{domain}.auth0.com/.well-known/openid-configuration` | Supports social + enterprise in one integration |

---

## 3. SAML 2.0

### What is it?

Enterprise SSO via XML assertions — used with corporate identity providers
such as Active Directory Federation Services (ADFS), Ping Identity, and
Okta (SAML mode). The IAM service acts as the **Service Provider (SP)**;
the corporate IdP handles authentication.

### How to add it

**Step 1 — Install pysaml2**

```bash
pip install pysaml2 xmlsec1
apt-get install -y xmlsec1   # add to Dockerfile RUN line
```

```toml
# pyproject.toml
"pysaml2>=7.5",
```

**Step 2 — Add env vars**

```ini
# .env
SAML_IDP_METADATA_URL=https://your-idp.example.com/saml/metadata
SAML_SP_ENTITY_ID=https://iam.your-company.com/api/v1/auth/saml/metadata
SAML_SP_ACS_URL=https://iam.your-company.com/api/v1/auth/saml/acs
SAML_SP_CERT=/run/secrets/saml_sp.crt
SAML_SP_KEY=/run/secrets/saml_sp.key
```

**Step 3 — Create `app/auth/saml_routes.py`**

```python
from saml2 import BINDING_HTTP_POST, BINDING_HTTP_REDIRECT
from saml2.client import Saml2Client
from saml2.config import Config as Saml2Config
from fastapi import APIRouter, Request, Depends
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models import User
from app.auth.jwt import create_access_token
from app.config import settings

router = APIRouter(prefix="/auth/saml", tags=["auth/saml"])

def _build_saml_client() -> Saml2Client:
    config = Saml2Config()
    config.load({
        "entityid": settings.SAML_SP_ENTITY_ID,
        "service": {
            "sp": {
                "endpoints": {
                    "assertion_consumer_service": [
                        (settings.SAML_SP_ACS_URL, BINDING_HTTP_POST),
                    ],
                },
                "allow_unsolicited": True,
                "authn_requests_signed": True,
                "want_assertions_signed": True,
            }
        },
        "cert_file": settings.SAML_SP_CERT,
        "key_file": settings.SAML_SP_KEY,
        "metadata": {"remote": [{"url": settings.SAML_IDP_METADATA_URL}]},
    })
    return Saml2Client(config=config)

@router.get("/login")
async def saml_login():
    client = _build_saml_client()
    _, info = client.prepare_for_authenticate()
    for key, value in info["headers"]:
        if key == "Location":
            return RedirectResponse(url=value)

@router.post("/acs")
async def saml_acs(request: Request, db: AsyncSession = Depends(get_db)):
    form = await request.form()
    saml_response = form["SAMLResponse"]
    client = _build_saml_client()
    authn_response = client.parse_authn_request_response(
        saml_response, BINDING_HTTP_POST
    )
    identity = authn_response.get_identity()
    name_id = str(authn_response.get_subject())
    email = identity.get("email", [name_id])[0]
    display_name = identity.get("displayName", [None])[0]

    from sqlalchemy import select
    user = (await db.execute(
        select(User).where(User.auth_provider == "saml", User.external_subject == name_id)
    )).scalar_one_or_none()

    if not user:
        user = User(
            email=email, display_name=display_name,
            auth_provider="saml", external_subject=name_id,
            is_local_account=False, status="active",
        )
        db.add(user)
        await db.flush()

    await db.commit()
    token = create_access_token(user.id, user.email, user.is_super_admin)
    # Redirect the browser back to the frontend with the token
    return RedirectResponse(
        url=f"http://localhost:5175/auth/callback?token={token}"
    )

@router.get("/metadata")
async def saml_metadata():
    from fastapi.responses import Response
    client = _build_saml_client()
    metadata = client.config.metadata
    return Response(content=str(metadata), media_type="text/xml")
```

**Step 4 — Mount in `app/main.py`**

```python
from app.auth.saml_routes import router as saml_router
app.include_router(saml_router, prefix=PREFIX)
```

### Attribute mapping

SAML attributes vary by IdP. Common mappings:

| IAM field | ADFS attribute | Okta attribute | Azure AD attribute |
|---|---|---|---|
| `email` | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` | `email` | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` |
| `display_name` | `http://schemas.microsoft.com/ws/2008/06/identity/claims/displayname` | `displayName` | `name` |
| `external_subject` (nameID) | UPN or employee ID | username | Object ID |

---

## 4. API Key (service-to-service)

### What is it?

Machine clients (agents, workflow executors, external services) authenticate
with a static API key instead of a user credential. The key is verified and
exchanged for a short-lived JWT bound to a service user.

### How to add it

**Step 1 — Add an `api_keys` table**

```python
# app/models.py  (add this class)
class ApiKey(Base):
    __tablename__ = "api_keys"
    __table_args__ = {"schema": "iam"}

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=_uuid)
    key_hash: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("iam.users.id", ondelete="CASCADE"), nullable=False
    )
    description: Mapped[Optional[str]] = mapped_column(String)
    expires_at: Mapped[Optional[datetime]] = mapped_column(_tstz())
    last_used_at: Mapped[Optional[datetime]] = mapped_column(_tstz())
    created_at: Mapped[datetime] = mapped_column(_tstz(), nullable=False, default=_now)

    user: Mapped["User"] = relationship()
```

**Step 2 — Create `app/auth/apikey_routes.py`**

```python
import secrets
import hashlib
from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from datetime import datetime, timezone
from app.database import get_db
from app.models import ApiKey
from app.auth.jwt import create_access_token
from app.auth.schemas import LoginResponse, TokenUserOut

router = APIRouter(prefix="/auth/apikey", tags=["auth/apikey"])

def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()

@router.post("/token", response_model=LoginResponse)
async def exchange_api_key(
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
):
    key_hash = _hash_key(x_api_key)
    api_key = (await db.execute(
        select(ApiKey).where(ApiKey.key_hash == key_hash)
    )).scalar_one_or_none()

    if not api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid API key")

    if api_key.expires_at and api_key.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="API key expired")

    api_key.last_used_at = datetime.now(timezone.utc)
    await db.commit()

    user = api_key.user
    if not user or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not active")

    token = create_access_token(user.id, user.email, user.is_super_admin)
    return LoginResponse(
        access_token=token,
        user=TokenUserOut(
            id=user.id, email=user.email,
            display_name=user.display_name, is_super_admin=user.is_super_admin,
        ),
    )
```

**Step 3 — Generating an API key**

```python
import secrets
raw_key = secrets.token_urlsafe(32)   # give this to the client ONCE
key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
# Insert into iam.api_keys: key_hash=key_hash, user_id=<service-user-id>
```

**Step 4 — Usage by a client**

```bash
# Exchange key for JWT
curl -X POST http://localhost:8100/api/v1/auth/apikey/token \
  -H "X-API-Key: <raw_key>"

# Use the returned JWT on subsequent calls
curl http://localhost:8100/api/v1/authz/check \
  -H "Authorization: Bearer <jwt>"
```

---

## 5. JWT configuration

All methods produce a JWT signed with the settings in `app/config.py` and
`app/auth/jwt.py`.

### Signing algorithms

The default is `HS256` (HMAC-SHA256) with a shared secret. To switch to
RS256 (asymmetric — better for multi-service deployments):

**Step 1 — Generate a key pair**

```bash
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
```

**Step 2 — Update config**

```ini
JWT_ALGORITHM=RS256
JWT_PRIVATE_KEY_PATH=/run/secrets/jwt_private.pem
JWT_PUBLIC_KEY_PATH=/run/secrets/jwt_public.pem
```

```python
# app/config.py
JWT_ALGORITHM: str = "RS256"
JWT_PRIVATE_KEY_PATH: str | None = None
JWT_PUBLIC_KEY_PATH: str | None = None
```

**Step 3 — Update `app/auth/jwt.py`**

```python
def _load_key(path: str) -> str:
    with open(path) as f:
        return f.read()

def create_access_token(user_id: str, email: str, is_super_admin: bool) -> str:
    key = _load_key(settings.JWT_PRIVATE_KEY_PATH) if settings.JWT_ALGORITHM == "RS256" \
          else settings.JWT_SECRET
    # ... same jwt.encode() call

def decode_token(token: str) -> dict:
    key = _load_key(settings.JWT_PUBLIC_KEY_PATH) if settings.JWT_ALGORITHM == "RS256" \
          else settings.JWT_SECRET
    # ... same jwt.decode() call
```

### Token lifetime

```ini
JWT_EXPIRE_MINUTES=60        # access token — keep short (15–60 min)
```

For longer sessions add a refresh-token endpoint that issues a new access
token without re-authentication. Store refresh tokens (hashed) in a
`iam.refresh_tokens` table with their own TTL.

### Algorithm comparison

| Algorithm | Key type | Best for |
|---|---|---|
| `HS256` | Shared secret | Single-service deployments |
| `HS512` | Shared secret | Same as HS256, larger signature |
| `RS256` | RSA 2048+ key pair | Multi-service; public key can be published |
| `ES256` | ECDSA P-256 key pair | Same as RS256, smaller tokens |

---

## 6. Multi-factor authentication (MFA / TOTP)

The `iam.local_credentials` table already has `mfa_enabled` and
`mfa_secret_ref` columns. The following shows how to wire them up.

### How TOTP works

1. On enrollment, generate a TOTP secret and show the user a QR code.
2. User scans with Google Authenticator / Authy.
3. On login, after password verification, require a 6-digit TOTP code.

### How to add it

**Step 1 — Install pyotp**

```bash
pip install pyotp qrcode[pil]
```

```toml
"pyotp>=2.9",
"qrcode[pil]>=7.4",
```

**Step 2 — Enrollment endpoint**

```python
import pyotp, qrcode, io, base64
from fastapi import APIRouter, Depends
from app.auth.deps import get_current_user
from app.models import LocalCredential, User
from app.database import get_db

@router.post("/auth/mfa/enroll")
async def enroll_mfa(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    secret = pyotp.random_base32()
    totp = pyotp.TOTP(secret)
    uri = totp.provisioning_uri(current_user.email, issuer_name="Singularity")

    # Generate QR code as base64 PNG
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    qr_b64 = base64.b64encode(buf.getvalue()).decode()

    # Store secret (use Vault or KMS in production — mfa_secret_ref stores a reference)
    cred = (await db.execute(
        select(LocalCredential).where(LocalCredential.user_id == current_user.id)
    )).scalar_one()
    cred.mfa_secret_ref = secret   # replace with Vault path in production
    await db.commit()

    return {"qr_code_png_base64": qr_b64, "manual_entry_key": secret}
```

**Step 3 — Verify TOTP on login**

Extend `local_login()` in [`app/auth/routes.py`](app/auth/routes.py):

```python
# After password verification succeeds:
if cred.mfa_enabled:
    if not body.totp_code:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="TOTP code required")
    totp = pyotp.TOTP(cred.mfa_secret_ref)
    if not totp.verify(body.totp_code, valid_window=1):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Invalid TOTP code")
```

Update `LoginRequest` schema:

```python
class LoginRequest(BaseModel):
    email: str
    password: str
    totp_code: str | None = None   # omitted if MFA not enabled
```

**Step 4 — Secret storage**

`mfa_secret_ref` is intentionally a *reference*, not the secret itself.
In production store TOTP secrets in HashiCorp Vault or AWS Secrets Manager
and put the Vault path in `mfa_secret_ref`:

```
mfa_secret_ref = "secret/iam/mfa/user-uuid"
```

---

## Environment variable reference

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql+asyncpg://singularity:singularity@localhost:5433/singularity_iam` | PostgreSQL connection string |
| `JWT_SECRET` | `change-me-in-production` | HMAC signing secret for HS256 |
| `JWT_ALGORITHM` | `HS256` | JWT signing algorithm |
| `JWT_EXPIRE_MINUTES` | `60` | Access token lifetime |
| `LOCAL_SUPER_ADMIN_EMAIL` | `admin@singularity.local` | Seeded super-admin email |
| `LOCAL_SUPER_ADMIN_PASSWORD` | `change-me-now` | Seeded super-admin password |
| `CORS_ORIGINS` | `["http://localhost:5175"]` | Allowed CORS origins (JSON array) |
| `GOOGLE_CLIENT_ID` | — | OAuth2: Google app client ID |
| `GOOGLE_CLIENT_SECRET` | — | OAuth2: Google app client secret |
| `GOOGLE_REDIRECT_URI` | — | OAuth2: Google callback URL |
| `MICROSOFT_CLIENT_ID` | — | OAuth2: Entra/Azure app client ID |
| `MICROSOFT_CLIENT_SECRET` | — | OAuth2: Entra/Azure client secret |
| `MICROSOFT_TENANT_ID` | — | OAuth2: Entra directory tenant ID |
| `SAML_IDP_METADATA_URL` | — | SAML: IdP metadata endpoint |
| `SAML_SP_ENTITY_ID` | — | SAML: This SP's entity ID (URL) |
| `SAML_SP_ACS_URL` | — | SAML: Assertion Consumer Service URL |
| `SAML_SP_CERT` | — | SAML: Path to SP certificate |
| `SAML_SP_KEY` | — | SAML: Path to SP private key |
| `JWT_PRIVATE_KEY_PATH` | — | RS256: Path to RSA private key PEM |
| `JWT_PUBLIC_KEY_PATH` | — | RS256: Path to RSA public key PEM |
