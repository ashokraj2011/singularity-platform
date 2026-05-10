import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import settings
from app.database import engine, AsyncSessionLocal, Base
from app.seed.runner import seed_all

# Import all models so SQLAlchemy registers them before create_all
import app.models  # noqa: F401

from app.auth.routes import router as auth_router
from app.auth.deps import get_current_user
from app.auth.schemas import TokenUserOut
from app.models import User
from fastapi import Depends
from app.users.routes import router as users_router
from app.org.routes import router as org_router
from app.capabilities.routes import router as cap_router
from app.roles.routes import router as roles_router
from app.authz.routes import router as authz_router
from app.audit.routes import router as audit_router
from app.mcp_servers.routes import router as mcp_servers_router
from app.eventbus.routes import router as eventbus_router  # M11.e

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


_ADD_COLUMNS = [
    "ALTER TABLE iam.users           ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb",
    "ALTER TABLE iam.business_units  ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb",
    "ALTER TABLE iam.teams           ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb",
    "ALTER TABLE iam.teams           ADD COLUMN IF NOT EXISTS parent_team_id UUID REFERENCES iam.teams(id)",
    "ALTER TABLE iam.capabilities    ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb",
    "ALTER TABLE iam.roles           ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
    "ALTER TABLE iam.roles           ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb",
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create schema and tables
    async with engine.begin() as conn:
        await conn.execute(text("CREATE SCHEMA IF NOT EXISTS iam"))
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
        await conn.run_sync(Base.metadata.create_all)
        for stmt in _ADD_COLUMNS:
            await conn.execute(text(stmt))
    log.info("Database schema ready")

    # Seed default data
    async with AsyncSessionLocal() as db:
        await seed_all(db)

    # M11.a — self-register with platform-registry
    from .platform_registry import start_self_registration, stop_self_registration
    import os as _os
    await start_self_registration({
        "service_name":  "iam",
        "display_name":  "Singularity IAM",
        "version":       "0.1.0",
        "base_url":      _os.environ.get("PUBLIC_BASE_URL", "http://localhost:8100"),
        "health_path":   "/api/v1/healthz",
        "auth_mode":     "bearer-iam",
        "owner_team":    "platform",
        "metadata":      {"layer": "identity"},
        "capabilities": [
            {"capability_key": "identity.users",        "description": "User CRUD + auth"},
            {"capability_key": "identity.teams",        "description": "Teams + memberships"},
            {"capability_key": "identity.business-units","description": "BU hierarchy"},
            {"capability_key": "identity.capabilities", "description": "Business capability registry"},
            {"capability_key": "identity.roles",        "description": "Roles + permissions"},
            {"capability_key": "identity.mcp-servers",  "description": "Per-capability MCP server registry"},
            {"capability_key": "identity.authz",        "description": "POST /authz/check"},
        ],
        "contracts": [
            {"kind": "openapi", "contract_key": "openapi", "version": "0.1.0",
             "source_url": _os.environ.get("PUBLIC_BASE_URL", "http://localhost:8100") + "/openapi.json"},
        ],
    })

    # M11.e — start event-bus dispatcher (LISTEN/NOTIFY + safety sweep)
    from .eventbus import start_dispatcher, stop_dispatcher
    try:
        await start_dispatcher()
    except Exception as exc:
        log.warning("eventbus dispatcher failed to start: %s", exc)

    yield

    try:
        await stop_dispatcher()
    except Exception:
        pass
    await stop_self_registration()
    await engine.dispose()


app = FastAPI(
    title="Singularity Identity & Capability Service",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount all routers under /api/v1
PREFIX = "/api/v1"
app.include_router(auth_router, prefix=PREFIX)
app.include_router(users_router, prefix=PREFIX)
app.include_router(org_router, prefix=PREFIX)
app.include_router(cap_router, prefix=PREFIX)
app.include_router(roles_router, prefix=PREFIX)
app.include_router(authz_router, prefix=PREFIX)
app.include_router(audit_router, prefix=PREFIX)
app.include_router(mcp_servers_router, prefix=PREFIX)
# M11.e — event-bus subscription registry. Router itself carries the /api/v1 prefix.
app.include_router(eventbus_router)


@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "service": "singularity-iam-service"}


@app.get("/api/v1/me", response_model=TokenUserOut)
async def me(current_user: User = Depends(get_current_user)):
    return TokenUserOut(
        id=current_user.id,
        email=current_user.email,
        display_name=current_user.display_name,
        is_super_admin=current_user.is_super_admin,
    )
