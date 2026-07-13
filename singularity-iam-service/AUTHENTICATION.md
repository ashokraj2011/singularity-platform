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
[`app/seed/runner.py`](app/seed/runner.py). To create additional local users,
create the user with `auth_provider="local"`, then use **Identity → Users →
Set password**. The UI calls the super-admin-only endpoint below; IAM hashes
the password and never returns it.

```
POST /api/v1/users/{user_id}/password
Authorization: Bearer <super-admin-jwt>
Content-Type: application/json

{ "password": "a-strong-password-at-least-12-chars" }
```

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

### Implemented mode

IAM now supports a generic OIDC deployment mode:

```ini
IAM_AUTH_MODE=oidc
OIDC_ISSUER_URL=https://idp.example.com/oauth2/default
OIDC_CLIENT_ID=singularity-platform
OIDC_CLIENT_SECRET=<rotated 32+ char client secret>
OIDC_REDIRECT_URI=https://platform.example.com/identity/oidc/callback
OIDC_ALLOWED_DOMAINS=example.com
OIDC_ADMIN_EMAILS=platform-admin@example.com
```

When `IAM_AUTH_MODE=oidc`, local password login returns `403` and human login
must use the configured external provider. Production-class config validation
fails closed unless issuer and redirect URLs are HTTPS and the client secret is
rotated.

### Endpoints

```text
GET  /api/v1/auth/providers
GET  /api/v1/auth/oidc/login-url
POST /api/v1/auth/oidc/code-login
POST /api/v1/auth/oidc/token-login
```

`/auth/providers` reports local-vs-OIDC readiness and the configured OIDC
metadata. `/auth/oidc/login-url` returns an authorization URL plus generated
state and nonce values for Platform Web or another trusted UI to start the
redirect. Platform Web handles `/identity/oidc/callback`, checks the stored
state, and posts the authorization code to `/auth/oidc/code-login`; IAM then
exchanges the code server-side with the OIDC client secret, verifies the
returned `id_token` and nonce against the provider JWKS, maps the configured
subject/email/name claims, upserts the federated IAM user
(`auth_provider=oidc`, `external_subject=<sub>`), and returns the normal
Singularity bearer token. `/auth/oidc/token-login` remains available for trusted
test harnesses or non-browser clients that already hold an IdP `id_token`.

Deploy verification:

```bash
python3 ./bin/check-github-environment-secrets.py --require-oidc --github-environment production
IAM_AUTH_MODE=oidc ... ./bin/check-deploy-env.sh --config-only
```

The first command verifies the GitHub Environment has all required OIDC secret
names. The second verifies the release values are production-safe.

### Provider notes

- Google Workspace, Microsoft Entra ID, and Okta all work through the generic
  issuer/client/secret/redirect settings when their app registration supports
  OpenID Connect.
- GitHub OAuth is not an OIDC provider for normal web apps; use an OIDC-capable
  enterprise IdP in front of GitHub identities or add a dedicated OAuth adapter.

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
| `IAM_AUTH_MODE` | `local` | Human login mode: `local` or `oidc` |
| `OIDC_ISSUER_URL` | — | OIDC: external IdP issuer URL, HTTPS required in production |
| `OIDC_CLIENT_ID` | — | OIDC: registered client ID |
| `OIDC_CLIENT_SECRET` | — | OIDC: rotated client secret |
| `OIDC_REDIRECT_URI` | — | OIDC: callback URL registered with the IdP |
| `OIDC_SCOPES` | `openid email profile` | OIDC scopes requested by login URL |
| `OIDC_SUBJECT_CLAIM` | `sub` | OIDC claim used as external subject |
| `OIDC_EMAIL_CLAIM` | `email` | OIDC claim used as IAM email |
| `OIDC_NAME_CLAIM` | `name` | OIDC claim used as display name |
| `OIDC_ALLOWED_DOMAINS` | — | Optional comma-separated email domain allow-list |
| `OIDC_ADMIN_EMAILS` | — | Optional comma-separated emails promoted to IAM super-admin |
| `SAML_IDP_METADATA_URL` | — | SAML: IdP metadata endpoint |
| `SAML_SP_ENTITY_ID` | — | SAML: This SP's entity ID (URL) |
| `SAML_SP_ACS_URL` | — | SAML: Assertion Consumer Service URL |
| `SAML_SP_CERT` | — | SAML: Path to SP certificate |
| `SAML_SP_KEY` | — | SAML: Path to SP private key |
| `JWT_PRIVATE_KEY_PATH` | — | RS256: Path to RSA private key PEM |
| `JWT_PUBLIC_KEY_PATH` | — | RS256: Path to RSA public key PEM |
