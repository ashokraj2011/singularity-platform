# Pseudo IAM Service

> ⚠️ **NOT FOR PRODUCTION.** By design this service has no authentication.
> It accepts any credentials, approves every authz check, and returns synthetic
> data. Use it ONLY for local development, smoke tests, and demos where you
> don't want to wrangle real users / JWTs / capabilities.

A drop-in shim for the real Singularity IAM service (`singularity-iam-service`,
`:8100`). Mirrors the wire protocol so any consumer that points
`IAM_BASE_URL` here will Just Work.

## Why

For dev work, every test against the real IAM needs:

- A real user row
- A current JWT (60-min lifetime, has to be re-minted)
- A real capability with members
- A registered MCP server per capability

This service collapses all of that to "any string is fine":

- `POST /api/v1/auth/local/login` with any email + any password → JWT
- Any bearer token validates as a synthetic super-admin user
- `POST /api/v1/authz/check` always returns `{allowed: true}`
- `GET /api/v1/capabilities/:id` returns a synthetic capability for any id
- `GET /api/v1/capabilities/:id/mcp-servers` returns the running
  `mcp-server-demo` (configurable via `PSEUDO_MCP_BASE_URL`)

## How to use

### 1. Start it

```bash
cd pseudo-iam-service
docker compose up -d --build
curl -s http://localhost:8101/health
# → {"status":"ok","mode":"pseudo","warning":"NOT FOR PRODUCTION — accepts any credentials",...}
```

### 2. Try it standalone

```bash
TOKEN=$(curl -sS -X POST http://localhost:8101/api/v1/auth/local/login \
  -H "Content-Type: application/json" \
  -d '{"email":"random@example.com","password":"whatever"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])")

curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:8101/api/v1/me
```

### 3. Flip a consumer to pseudo-IAM

Point that service's `IAM_BASE_URL` env at `http://host.docker.internal:8101/api/v1`
and restart it. Examples:

```bash
# workgraph-api
cd workgraph-studio
IAM_BASE_URL=http://host.docker.internal:8101/api/v1 \
IAM_BOOTSTRAP_USERNAME=any@dev IAM_BOOTSTRAP_PASSWORD=anything \
docker compose -f infra/docker/docker-compose.yml up -d --force-recreate api

# context-fabric
cd context-fabric
IAM_BASE_URL=http://host.docker.internal:8101/api/v1 \
docker compose up -d --force-recreate context-api-service
```

To switch back: revert `IAM_BASE_URL` to `:8100` and recreate.

## What's exposed

| Endpoint | Behaviour |
|---|---|
| `POST /api/v1/auth/local/login` | Mint user JWT for any email/password |
| `POST /api/v1/auth/service-token` | Mint long-lived service JWT for any caller |
| `POST /api/v1/auth/verify` | Validate any token; return synthetic user |
| `GET /api/v1/me` | Decode bearer; return synthetic user |
| `POST /api/v1/authz/check` | Always `{allowed: true, source: "pseudo-iam"}` |
| `GET /api/v1/capabilities[/:id][/members][/mcp-servers]` | Synthetic capability data |
| `GET /api/v1/mcp-servers/:id` | Returns running mcp-server-demo (full record incl. bearer) |
| `GET /api/v1/users[/:id][/teams][/skills]` | 3 synthetic users + empty membership lists |
| `GET /api/v1/teams[/:id][/members]` | 2 synthetic teams |
| `GET /api/v1/business-units[/:id]` | 1 synthetic BU |
| `GET /api/v1/roles[/:role_key]` | viewer / editor / super-admin |
| `GET /api/v1/skills` | Empty list |
| `GET /health` | `{status:"ok", mode:"pseudo", warning:...}` |
| `GET /openapi.json` | Minimal stub |

## Token shape

Identical to real IAM so consumers' local-verify paths (using the same
`JWT_SECRET`) accept tokens minted here without code changes.

**User token** (from `/auth/local/login`):
```json
{
  "sub": "<sha256(email)-derived uuid>",
  "email": "<input email>",
  "is_super_admin": true,
  "iat": ..., "exp": ...
}
```

**Service token** (from `/auth/service-token`):
```json
{
  "sub": "service:<service_name>",
  "kind": "service",
  "service_name": "<input>",
  "scopes": [...],
  "issued_by": "<originating user sub>",
  "is_super_admin": true,
  "iat": ..., "exp": ...
}
```

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `8101` | HTTP port |
| `JWT_SECRET` | `dev-secret-change-in-prod` | Must match the `JWT_SECRET` used by your consumers (workgraph + IAM share this in dev). |
| `PSEUDO_MCP_BASE_URL` | `http://host.docker.internal:7100` | Where capability-MCP-server lookups point |
| `PSEUDO_MCP_BEARER` | `demo-bearer-token-must-be-min-16-chars` | Bearer the MCP record carries |
| `PLATFORM_REGISTRY_URL` | `http://host.docker.internal:8090` | Optional self-register on startup |
| `PUBLIC_BASE_URL` | `http://localhost:8101` | URL reported during self-register |

## Stop

```bash
docker compose down
```
