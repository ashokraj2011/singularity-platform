#!/usr/bin/env bash
# Plain Docker launcher for the Singularity platform apps.
#
# This intentionally does not use `docker compose`.
# It starts the core platform box and keeps MCP + LLM Gateway outside the box as
# dial-in runtimes. Start those separately with bin/laptop-bridge.sh,
# bin/bare-metal-runtime.sh, or a remote runtime deployment.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NETWORK="${SINGULARITY_DOCKER_NETWORK:-singularity-core}"
IMAGE_PREFIX="${SINGULARITY_DOCKER_IMAGE_PREFIX:-singularity}"

IMG_IAM="${IMAGE_PREFIX}/iam-service:docker-core"
IMG_CONTEXT="${IMAGE_PREFIX}/context-api:docker-core"
IMG_PLATFORM_CORE="${IMAGE_PREFIX}/platform-core:docker-core"
IMG_WORKGRAPH="${IMAGE_PREFIX}/workgraph-api:docker-core"
IMG_PLATFORM_WEB="${IMAGE_PREFIX}/platform-web:docker-core"
IMG_AUDIT="${IMAGE_PREFIX}/audit-governance:docker-core"

AT_PG="singularity-at-postgres"
AT_BOOT="singularity-at-postgres-bootstrap"
IAM="singularity-iam-service"
CONTEXT="singularity-context-api"
WG_PG="singularity-wg-postgres"
WG_BOOT="singularity-wg-postgres-bootstrap"
MINIO="singularity-wg-minio"
WORKGRAPH="singularity-workgraph-api"
PLATFORM_CORE="singularity-platform-core"
PLATFORM_WEB="singularity-platform-web"
AUDIT_PG="audit-governance-postgres"
AUDIT_MIGRATE="audit-governance-migrate"
AUDIT="audit-governance-service"

WITH_AUDIT=0
BUILD=0
YES=0

log() { printf '[docker-core] %s\n' "$*"; }
err() { printf '[docker-core] ERROR: %s\n' "$*" >&2; }

usage() {
  cat <<'USAGE'
Singularity plain Docker launcher.

Usage:
  bin/docker-core.sh up [--build] [--with-audit]
  bin/docker-core.sh build [--with-audit]
  bin/docker-core.sh seed [--with-audit]
  bin/docker-core.sh smoke [--with-audit]
  bin/docker-core.sh status
  bin/docker-core.sh logs <service-or-container>
  bin/docker-core.sh down [--with-audit]
  bin/docker-core.sh nuke --yes

What starts by default:
  at-postgres, wg-postgres, wg-minio, iam-service, platform-core,
  context-api, workgraph-api, platform-web

What does not start here:
  llm-gateway, mcp-server, mcp-sandbox-runner

Runtime endpoints default to host.docker.internal:7100 and :8001 so MCP/LLM
can run on the same laptop or on a remote runtime bridge.
USAGE
}

load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  # The repo-generated .env files are shell-compatible KEY=VALUE files.
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
}

load_env() {
  load_env_file "$ROOT/.env"
  load_env_file "$ROOT/.env.local"

  APP_ENV="${APP_ENV:-${SINGULARITY_ENV:-development}}"
  ENVIRONMENT="${ENVIRONMENT:-${SINGULARITY_ENV:-$APP_ENV}}"
  SINGULARITY_ENV="${SINGULARITY_ENV:-$APP_ENV}"
  AUTH_OPTIONAL="${AUTH_OPTIONAL:-true}"
  JWT_SECRET="${JWT_SECRET:-changeme_dev_only_min_32_chars_long!!}"
  LOCAL_SUPER_ADMIN_EMAIL="${LOCAL_SUPER_ADMIN_EMAIL:-admin@singularity.local}"
  LOCAL_SUPER_ADMIN_PASSWORD="${LOCAL_SUPER_ADMIN_PASSWORD:-Admin1234!}"
  IAM_BOOTSTRAP_USERNAME="${IAM_BOOTSTRAP_USERNAME:-$LOCAL_SUPER_ADMIN_EMAIL}"
  IAM_BOOTSTRAP_PASSWORD="${IAM_BOOTSTRAP_PASSWORD:-$LOCAL_SUPER_ADMIN_PASSWORD}"
  CONTEXT_FABRIC_SERVICE_TOKEN="${CONTEXT_FABRIC_SERVICE_TOKEN:-dev-context-fabric-service-token}"
  AUDIT_GOV_SERVICE_TOKEN="${AUDIT_GOV_SERVICE_TOKEN:-dev-audit-gov-service-token}"
  WORKGRAPH_INTERNAL_TOKEN="${WORKGRAPH_INTERNAL_TOKEN:-dev-workgraph-internal-token}"
  MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-${MCP_DEMO_BEARER_TOKEN:-demo-bearer-token-must-be-min-16-chars}}"
  WORKGRAPH_APP_DB_USER="${WORKGRAPH_APP_DB_USER:-workgraph_app}"
  WORKGRAPH_APP_DB_PASSWORD="${WORKGRAPH_APP_DB_PASSWORD:-workgraph_app_secret}"
  TENANT_ISOLATION_MODE="${TENANT_ISOLATION_MODE:-off}"
  REQUIRE_TENANT_ID="${REQUIRE_TENANT_ID:-false}"
  DEFAULT_GOVERNANCE_MODE="${DEFAULT_GOVERNANCE_MODE:-fail_open}"
  WORKGRAPH_FORCE_GOVERNED_CODING="${WORKGRAPH_FORCE_GOVERNED_CODING:-true}"
  CONTEXT_FABRIC_GOVERN_SIDE_CALLERS="${CONTEXT_FABRIC_GOVERN_SIDE_CALLERS:-true}"
  RUNTIME_HTTP_FALLBACK_ENABLED="${RUNTIME_HTTP_FALLBACK_ENABLED:-false}"

  DOCKER_CORE_MCP_URL="${DOCKER_CORE_MCP_URL:-${MCP_SERVER_INTERNAL_URL:-${MCP_SERVER_URL:-http://host.docker.internal:7100}}}"
  DOCKER_CORE_LLM_URL="${DOCKER_CORE_LLM_URL:-${LLM_GATEWAY_INTERNAL_URL:-${LLM_GATEWAY_URL:-http://host.docker.internal:8001}}}"
  case "$DOCKER_CORE_MCP_URL" in
    http://mcp-server:*|https://mcp-server:*) DOCKER_CORE_MCP_URL="http://host.docker.internal:7100" ;;
  esac
  case "$DOCKER_CORE_LLM_URL" in
    http://llm-gateway:*|https://llm-gateway:*) DOCKER_CORE_LLM_URL="http://host.docker.internal:8001" ;;
  esac

  if [ "$WITH_AUDIT" = "1" ]; then
    DOCKER_CORE_AUDIT_URL="${DOCKER_CORE_AUDIT_URL:-http://audit-governance:8500}"
  else
    DOCKER_CORE_AUDIT_URL="${DOCKER_CORE_AUDIT_URL:-${AUDIT_GOV_URL:-http://host.docker.internal:8500}}"
  fi
}

parse_flags() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --build) BUILD=1 ;;
      --with-audit|--audit) WITH_AUDIT=1 ;;
      --yes|-y) YES=1 ;;
      --help|-h) usage; exit 0 ;;
      *) err "unknown option: $1"; usage; exit 1 ;;
    esac
    shift
  done
}

require_docker() {
  command -v docker >/dev/null 2>&1 || { err "docker CLI not found"; exit 1; }
  docker info >/dev/null 2>&1 || { err "Docker daemon is not reachable"; exit 1; }
}

ensure_network() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
}

ensure_volumes() {
  docker volume create singularity_at_postgres_data >/dev/null
  docker volume create singularity_wg_postgres_data >/dev/null
  docker volume create singularity_wg_minio_data >/dev/null
  if [ "$WITH_AUDIT" = "1" ]; then
    docker volume create singularity_audit_postgres_data >/dev/null
    docker volume create singularity_audit_log_data >/dev/null
  fi
}

rm_container() {
  docker rm -f "$1" >/dev/null 2>&1 || true
}

image_missing() {
  ! docker image inspect "$1" >/dev/null 2>&1
}

build_images() {
  local force="${1:-0}"
  if [ "$force" = "1" ] || image_missing "$IMG_IAM"; then
    log "building $IMG_IAM"
    docker build -t "$IMG_IAM" "$ROOT/singularity-iam-service"
  fi
  if [ "$force" = "1" ] || image_missing "$IMG_CONTEXT"; then
    log "building $IMG_CONTEXT"
    docker build -t "$IMG_CONTEXT" -f "$ROOT/context-fabric/services/context_api_service/Dockerfile" "$ROOT/context-fabric"
  fi
  if [ "$force" = "1" ] || image_missing "$IMG_PLATFORM_CORE"; then
    log "building $IMG_PLATFORM_CORE"
    docker build \
      --build-arg ARTIFACTORY_NPM_REGISTRY="${ARTIFACTORY_NPM_REGISTRY:-}" \
      -t "$IMG_PLATFORM_CORE" \
      -f "$ROOT/agent-and-tools/platform-core.Dockerfile" \
      "$ROOT/agent-and-tools"
  fi
  if [ "$force" = "1" ] || image_missing "$IMG_WORKGRAPH"; then
    log "building $IMG_WORKGRAPH"
    docker build \
      --target dev \
      --build-arg ARTIFACTORY_NPM_REGISTRY="${ARTIFACTORY_NPM_REGISTRY:-}" \
      -t "$IMG_WORKGRAPH" \
      -f "$ROOT/workgraph-studio/apps/api/Dockerfile" \
      "$ROOT/workgraph-studio"
  fi
  if [ "$force" = "1" ] || image_missing "$IMG_PLATFORM_WEB"; then
    log "building $IMG_PLATFORM_WEB"
    docker build \
      --build-arg ARTIFACTORY_NPM_REGISTRY="${ARTIFACTORY_NPM_REGISTRY:-}" \
      -t "$IMG_PLATFORM_WEB" \
      -f "$ROOT/agent-and-tools/web/Dockerfile" \
      "$ROOT"
  fi
  if [ "$WITH_AUDIT" = "1" ] && { [ "$force" = "1" ] || image_missing "$IMG_AUDIT"; }; then
    log "building $IMG_AUDIT"
    docker build --target dev -t "$IMG_AUDIT" "$ROOT/audit-governance-service"
  fi
}

wait_for_container_running() {
  local name="$1"
  local seconds="${2:-90}"
  local i state
  for i in $(seq 1 "$seconds"); do
    state="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)"
    [ "$state" = "true" ] && return 0
    sleep 1
  done
  err "$name did not start"
  docker logs --tail=80 "$name" 2>/dev/null || true
  exit 1
}

wait_for_pg() {
  local name="$1"
  local user="$2"
  local db="${3:-}"
  local seconds="${4:-120}"
  local i
  for i in $(seq 1 "$seconds"); do
    if [ -n "$db" ]; then
      docker exec "$name" pg_isready -U "$user" -d "$db" >/dev/null 2>&1 && return 0
    else
      docker exec "$name" pg_isready -U "$user" >/dev/null 2>&1 && return 0
    fi
    sleep 1
  done
  err "$name postgres was not ready"
  docker logs --tail=80 "$name" || true
  exit 1
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local seconds="${3:-120}"
  local i
  for i in $(seq 1 "$seconds"); do
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -o /dev/null "$url" >/dev/null 2>&1 && return 0
    else
      python3 - "$url" >/dev/null 2>&1 <<'PY' && return 0
import sys, urllib.request
try:
    with urllib.request.urlopen(sys.argv[1], timeout=2) as r:
        sys.exit(0 if 200 <= r.status < 500 else 1)
except Exception:
    sys.exit(1)
PY
    fi
    sleep 1
  done
  err "$label did not become reachable at $url"
  exit 1
}

docker_add_host_args() {
  printf '%s\n' --add-host host.docker.internal:host-gateway
}

start_infra() {
  log "starting shared app/IAM Postgres"
  rm_container "$AT_BOOT"
  rm_container "$AT_PG"
  docker run -d \
    --name "$AT_PG" \
    --network "$NETWORK" \
    --network-alias at-postgres \
    -p "${AT_POSTGRES_PORT:-5432}:5432" \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=singularity \
    -e POSTGRES_DB=singularity \
    -v singularity_at_postgres_data:/var/lib/postgresql/data \
    -v "$ROOT/agent-and-tools/packages/db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro" \
    pgvector/pgvector:pg16 >/dev/null
  wait_for_container_running "$AT_PG"
  wait_for_pg "$AT_PG" postgres singularity

  log "bootstrapping shared app/IAM Postgres"
  docker run --rm \
    --name "$AT_BOOT" \
    --network "$NETWORK" \
    -e PGHOST=at-postgres \
    -e PGPORT=5432 \
    -e PGUSER=postgres \
    -e PGPASSWORD=singularity \
    -v "$ROOT/agent-and-tools/packages/db/bootstrap-existing-volume.sh:/bootstrap.sh:ro" \
    postgres:16-alpine /bin/sh /bootstrap.sh

  log "starting Workgraph Postgres"
  rm_container "$WG_BOOT"
  rm_container "$WG_PG"
  docker run -d \
    --name "$WG_PG" \
    --network "$NETWORK" \
    --network-alias wg-postgres \
    -p "${WG_POSTGRES_PORT:-5434}:5432" \
    -e POSTGRES_DB=workgraph \
    -e POSTGRES_USER=workgraph \
    -e POSTGRES_PASSWORD=workgraph_secret \
    -v singularity_wg_postgres_data:/var/lib/postgresql/data \
    postgres:16-alpine >/dev/null
  wait_for_container_running "$WG_PG"
  wait_for_pg "$WG_PG" workgraph workgraph

  log "bootstrapping Workgraph runtime DB role"
  docker run --rm \
    --name "$WG_BOOT" \
    --network "$NETWORK" \
    -e PGHOST=wg-postgres \
    -e PGPORT=5432 \
    -e PGUSER=workgraph \
    -e PGPASSWORD=workgraph_secret \
    -e POSTGRES_DB=workgraph \
    -e POSTGRES_USER=workgraph \
    -e WORKGRAPH_APP_DB_USER="$WORKGRAPH_APP_DB_USER" \
    -e WORKGRAPH_APP_DB_PASSWORD="$WORKGRAPH_APP_DB_PASSWORD" \
    -v "$ROOT/workgraph-studio/apps/api/prisma/bootstrap-app-role.sh:/bootstrap-workgraph.sh:ro" \
    postgres:16-alpine /bin/sh /bootstrap-workgraph.sh

  log "starting Workgraph MinIO"
  rm_container "$MINIO"
  docker run -d \
    --name "$MINIO" \
    --network "$NETWORK" \
    --network-alias wg-minio \
    -p "${MINIO_PORT:-9000}:9000" \
    -p "${MINIO_CONSOLE_PORT:-9001}:9001" \
    -e MINIO_ROOT_USER=workgraph \
    -e MINIO_ROOT_PASSWORD=workgraph_secret \
    -v singularity_wg_minio_data:/data \
    minio/minio:latest server /data --console-address ":9001" >/dev/null
  wait_for_url "MinIO" "http://localhost:${MINIO_PORT:-9000}/minio/health/ready" 120
}

start_audit() {
  [ "$WITH_AUDIT" = "1" ] || return 0

  log "starting audit-governance Postgres"
  rm_container "$AUDIT_MIGRATE"
  rm_container "$AUDIT"
  rm_container "$AUDIT_PG"
  docker run -d \
    --name "$AUDIT_PG" \
    --network "$NETWORK" \
    --network-alias audit-postgres \
    -p "${AUDIT_POSTGRES_PORT:-5436}:5432" \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=audit \
    -e POSTGRES_DB=audit_governance \
    -v singularity_audit_postgres_data:/var/lib/postgresql/data \
    -v "$ROOT/audit-governance-service/db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro" \
    pgvector/pgvector:pg16 >/dev/null
  wait_for_container_running "$AUDIT_PG"
  wait_for_pg "$AUDIT_PG" postgres audit_governance

  log "applying audit-governance migrations"
  docker run --rm \
    --name "$AUDIT_MIGRATE" \
    --network "$NETWORK" \
    -e PGPASSWORD=audit \
    -v "$ROOT/audit-governance-service/db:/db:ro" \
    pgvector/pgvector:pg16 \
    /bin/sh -c 'set -e; for m in $(ls /db/migrations/*.sql 2>/dev/null | sort); do echo "applying $m"; psql -h audit-postgres -U postgres -d audit_governance -v ON_ERROR_STOP=1 -f "$m"; done'

  log "starting audit-governance service"
  docker run -d \
    --name "$AUDIT" \
    --network "$NETWORK" \
    --network-alias audit-governance \
    $(docker_add_host_args) \
    -p "${AUDIT_GOV_PORT:-8500}:8500" \
    -e NODE_ENV=development \
    -e PORT=8500 \
    -e DATABASE_URL=postgresql://postgres:audit@audit-postgres:5432/audit_governance \
    -e AUDIT_GOV_SERVICE_TOKEN="$AUDIT_GOV_SERVICE_TOKEN" \
    -e MCP_SERVER_URL="$DOCKER_CORE_MCP_URL" \
    -e MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" \
    -e LLM_GATEWAY_URL="$DOCKER_CORE_LLM_URL" \
    -e LOG_STORAGE_BACKEND="${LOG_STORAGE_BACKEND:-filesystem}" \
    -e LOG_STORAGE_PATH="${LOG_STORAGE_PATH:-/data/singularity-logs}" \
    -e JUDGE_MODEL_ALIAS="${JUDGE_MODEL_ALIAS:-}" \
    -e JUDGE_TIMEOUT_MS="${JUDGE_TIMEOUT_MS:-30000}" \
    -v "$ROOT/audit-governance-service/src:/app/src" \
    -v "$ROOT/audit-governance-service/db:/app/db" \
    -v singularity_audit_log_data:/data/singularity-logs \
    "$IMG_AUDIT" >/dev/null
  wait_for_url "audit-governance" "http://localhost:${AUDIT_GOV_PORT:-8500}/health" 120
}

start_apps() {
  log "starting IAM service"
  rm_container "$IAM"
  docker run -d \
    --name "$IAM" \
    --network "$NETWORK" \
    --network-alias iam-service \
    -p "${IAM_PORT:-8100}:8100" \
    -e APP_ENV="$APP_ENV" \
    -e ENVIRONMENT="$ENVIRONMENT" \
    -e SINGULARITY_ENV="$SINGULARITY_ENV" \
    -e DATABASE_URL=postgresql+asyncpg://singularity:singularity@at-postgres:5432/singularity_iam \
    -e JWT_SECRET="$JWT_SECRET" \
    -e JWT_EXPIRE_MINUTES="${JWT_EXPIRE_MINUTES:-60}" \
    -e LOCAL_SUPER_ADMIN_EMAIL="$LOCAL_SUPER_ADMIN_EMAIL" \
    -e LOCAL_SUPER_ADMIN_PASSWORD="$LOCAL_SUPER_ADMIN_PASSWORD" \
    -e CORS_ORIGINS='["http://localhost:5175","http://localhost:5180","http://localhost:3000","http://localhost:5174","http://localhost:5176"]' \
    "$IMG_IAM" >/dev/null
  wait_for_url "iam-service" "http://localhost:${IAM_PORT:-8100}/api/v1/health" 180

  log "starting platform-core"
  rm_container "$PLATFORM_CORE"
  docker run -d \
    --name "$PLATFORM_CORE" \
    --network "$NETWORK" \
    --network-alias platform-core \
    --network-alias agent-service \
    --network-alias tool-service \
    --network-alias agent-runtime \
    --network-alias prompt-composer \
    $(docker_add_host_args) \
    -p "${AGENT_SERVICE_PORT:-3001}:3001" \
    -p "${TOOL_SERVICE_PORT:-3002}:3002" \
    -p "${AGENT_RUNTIME_PORT:-3003}:3003" \
    -p "${PROMPT_COMPOSER_PORT:-3004}:3004" \
    -e NODE_ENV=development \
    -e APP_ENV="$APP_ENV" \
    -e ENVIRONMENT="$ENVIRONMENT" \
    -e SINGULARITY_ENV="$SINGULARITY_ENV" \
    -e AUTH_OPTIONAL="$AUTH_OPTIONAL" \
    -e DATABASE_URL_AGENT_TOOLS=postgresql://postgres:singularity@at-postgres:5432/singularity \
    -e DATABASE_URL_COMPOSER=postgresql://postgres:singularity@at-postgres:5432/singularity_composer \
    -e DATABASE_URL_RUNTIME_READ=postgresql://postgres:singularity@at-postgres:5432/singularity \
    -e JWT_SECRET="$JWT_SECRET" \
    -e LOG_LEVEL="${LOG_LEVEL:-info}" \
    -e CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:3000,http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5180}" \
    -e IAM_SERVICE_URL=http://iam-service:8100 \
    -e IAM_BASE_URL=http://iam-service:8100/api/v1 \
    -e IAM_SERVICE_TOKEN="${AGENT_RUNTIME_IAM_SERVICE_TOKEN:-}" \
    -e IAM_SERVICE_TOKEN_TENANT_IDS="${IAM_SERVICE_TOKEN_TENANT_IDS:-}" \
    -e IAM_BOOTSTRAP_USERNAME="$IAM_BOOTSTRAP_USERNAME" \
    -e IAM_BOOTSTRAP_PASSWORD="$IAM_BOOTSTRAP_PASSWORD" \
    -e TOOL_SERVICE_URL=http://tool-service:3002 \
    -e AGENT_RUNTIME_URL=http://agent-runtime:3003 \
    -e CONTEXT_FABRIC_URL=http://context-api:8000 \
    -e CONTEXT_FABRIC_SERVICE_TOKEN="$CONTEXT_FABRIC_SERVICE_TOKEN" \
    -e PROMPT_COMPOSER_SERVICE_TOKEN="${PROMPT_COMPOSER_SERVICE_TOKEN:-$CONTEXT_FABRIC_SERVICE_TOKEN}" \
    -e LEARNING_SERVICE_URL=http://agent-service:3001 \
    -e WORKGRAPH_ARTIFACT_FETCH_URL=http://workgraph-api:8080/api/internal/artifacts/fetch \
    -e WORKGRAPH_ARTIFACT_FETCH_TOKEN="$WORKGRAPH_INTERNAL_TOKEN" \
    -e AUDIT_GOV_URL="$DOCKER_CORE_AUDIT_URL" \
    -e AUDIT_GOV_SERVICE_TOKEN="$AUDIT_GOV_SERVICE_TOKEN" \
    -e MCP_SERVER_URL="$DOCKER_CORE_MCP_URL" \
    -e MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" \
    -e LLM_GATEWAY_URL="$DOCKER_CORE_LLM_URL" \
    -e TOOL_SERVER_ENDPOINT_ALLOWLIST="${TOOL_SERVER_ENDPOINT_ALLOWLIST:-}" \
    -e PROVIDER_MANIFEST_SIGNATURE_MODE="${PROVIDER_MANIFEST_SIGNATURE_MODE:-auto}" \
    -e PROVIDER_MANIFEST_TRUSTED_KEYS="${PROVIDER_MANIFEST_TRUSTED_KEYS:-}" \
    -e PROVIDER_MANIFEST_MAX_TTL_SECONDS="${PROVIDER_MANIFEST_MAX_TTL_SECONDS:-2592000}" \
    -e AGENT_SOURCE_ALLOW_PRIVATE_URLS="${AGENT_SOURCE_ALLOW_PRIVATE_URLS:-false}" \
    -e WORLD_MODEL_DISTILL_MODEL_ALIAS="${WORLD_MODEL_DISTILL_MODEL_ALIAS:-claude-haiku-4-5-20251001}" \
    -e CAPSULE_COMPILE_MODEL_ALIAS="${CAPSULE_COMPILE_MODEL_ALIAS:-}" \
    -e EMBEDDING_MODEL_ALIAS="${EMBEDDING_MODEL_ALIAS:-}" \
    "$IMG_PLATFORM_CORE" >/dev/null
  wait_for_url "agent-service" "http://localhost:${AGENT_SERVICE_PORT:-3001}/health" 180
  wait_for_url "tool-service" "http://localhost:${TOOL_SERVICE_PORT:-3002}/health" 180
  wait_for_url "agent-runtime" "http://localhost:${AGENT_RUNTIME_PORT:-3003}/health" 180
  wait_for_url "prompt-composer" "http://localhost:${PROMPT_COMPOSER_PORT:-3004}/health" 180

  log "starting Context Fabric"
  rm_container "$CONTEXT"
  docker run -d \
    --name "$CONTEXT" \
    --network "$NETWORK" \
    --network-alias context-api \
    $(docker_add_host_args) \
    -p "${CONTEXT_API_PORT:-8000}:8000" \
    -e APP_ENV="$APP_ENV" \
    -e ENVIRONMENT="$ENVIRONMENT" \
    -e SINGULARITY_ENV="$SINGULARITY_ENV" \
    -e CONTEXT_MEMORY_URL=http://localhost:8000 \
    -e CONTEXT_FABRIC_DATABASE_URL=postgresql://postgres:singularity@at-postgres:5432/singularity_context_fabric \
    -e COMPOSER_URL=http://prompt-composer:3004 \
    -e PROMPT_COMPOSER_URL=http://prompt-composer:3004 \
    -e PROMPT_COMPOSER_SERVICE_TOKEN="${PROMPT_COMPOSER_SERVICE_TOKEN:-$CONTEXT_FABRIC_SERVICE_TOKEN}" \
    -e IAM_BASE_URL=http://iam-service:8100/api/v1 \
    -e REQUIRE_TENANT_ID="$REQUIRE_TENANT_ID" \
    -e DEFAULT_GOVERNANCE_MODE="$DEFAULT_GOVERNANCE_MODE" \
    -e IAM_SERVICE_TOKEN="$CONTEXT_FABRIC_SERVICE_TOKEN" \
    -e IAM_SERVICE_TOKEN_TENANT_IDS="${IAM_SERVICE_TOKEN_TENANT_IDS:-}" \
    -e IAM_BOOTSTRAP_USERNAME="$IAM_BOOTSTRAP_USERNAME" \
    -e IAM_BOOTSTRAP_PASSWORD="$IAM_BOOTSTRAP_PASSWORD" \
    -e JWT_SECRET="$JWT_SECRET" \
    -e MCP_DEFAULT_BASE_URL="$DOCKER_CORE_MCP_URL" \
    -e MCP_DEFAULT_BEARER_TOKEN="$MCP_BEARER_TOKEN" \
    -e MCP_SERVER_URL="$DOCKER_CORE_MCP_URL" \
    -e MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" \
    -e RUNTIME_HTTP_FALLBACK_ENABLED="$RUNTIME_HTTP_FALLBACK_ENABLED" \
    -e MCP_DEFAULT_SERVER_ID="${MCP_DEFAULT_SERVER_ID:-local-default-mcp}" \
    -e CF_TOOL_GRANT_ENABLED="${CF_TOOL_GRANT_ENABLED:-false}" \
    -e TOOL_GRANT_SIGNING_SECRET="${TOOL_GRANT_SIGNING_SECRET:-dev-tool-grant-signing-secret-min-32-chars!!}" \
    -e CF_TOOL_GRANT_TTL_SEC="${CF_TOOL_GRANT_TTL_SEC:-120}" \
    -e AUDIT_GOV_URL="$DOCKER_CORE_AUDIT_URL" \
    -e AUDIT_GOV_SERVICE_TOKEN="$AUDIT_GOV_SERVICE_TOKEN" \
    -e DEEP_REASONING_BUDGET_TOKENS="${DEEP_REASONING_BUDGET_TOKENS:-4096}" \
    -e AGENT_RUNTIME_URL=http://agent-runtime:3003 \
    -e COMPRESSOR_URL=http://prompt-compressor:8011 \
    -e COMPRESSION_ENABLED="${COMPRESSION_ENABLED:-false}" \
    -e COMPRESSION_PER_LAYER_BUDGET_TOKENS="${COMPRESSION_PER_LAYER_BUDGET_TOKENS:-1500}" \
    -e CONTEXT_FABRIC_MCP_INVOKE_TIMEOUT_SEC="${CONTEXT_FABRIC_MCP_INVOKE_TIMEOUT_SEC:-480}" \
    -e CF_AUTO_BASELINE_ENABLED="${CF_AUTO_BASELINE_ENABLED:-true}" \
    -e CF_GIT_PREFLIGHT_ENABLED="${CF_GIT_PREFLIGHT_ENABLED:-true}" \
    -e CF_AUTO_VERIFY_ENABLED="${CF_AUTO_VERIFY_ENABLED:-true}" \
    "$IMG_CONTEXT" >/dev/null
  wait_for_url "context-api" "http://localhost:${CONTEXT_API_PORT:-8000}/health" 180

  mkdir -p "$ROOT/.singularity/downloads"
  log "starting Workgraph API"
  rm_container "$WORKGRAPH"
  docker run -d \
    --name "$WORKGRAPH" \
    --network "$NETWORK" \
    --network-alias workgraph-api \
    $(docker_add_host_args) \
    -p "${WORKGRAPH_API_PORT:-8080}:8080" \
    -e NODE_ENV=development \
    -e APP_ENV="$APP_ENV" \
    -e ENVIRONMENT="$ENVIRONMENT" \
    -e SINGULARITY_ENV="$SINGULARITY_ENV" \
    -e PORT=8080 \
    -e DATABASE_URL="postgresql://${WORKGRAPH_APP_DB_USER}:${WORKGRAPH_APP_DB_PASSWORD}@wg-postgres:5432/workgraph" \
    -e WORKGRAPH_RUNTIME_DATABASE_URL="postgresql://${WORKGRAPH_APP_DB_USER}:${WORKGRAPH_APP_DB_PASSWORD}@wg-postgres:5432/workgraph" \
    -e WORKGRAPH_DATABASE_URL_ADMIN=postgresql://workgraph:workgraph_secret@wg-postgres:5432/workgraph \
    -e JWT_SECRET="$JWT_SECRET" \
    -e MINIO_ENDPOINT=wg-minio \
    -e MINIO_PORT=9000 \
    -e MINIO_ACCESS_KEY=workgraph \
    -e MINIO_SECRET_KEY=workgraph_secret \
    -e MINIO_BUCKET=workgraph-documents \
    -e WORKGRAPH_INTERNAL_TOKEN="$WORKGRAPH_INTERNAL_TOKEN" \
    -e WORKGRAPH_INCOMING_EVENT_SECRETS="${WORKGRAPH_INCOMING_EVENT_SECRETS:-{\"agent-runtime\":\"dev-workgraph-incoming-event-secret-min-32-chars\",\"agent-service\":\"dev-workgraph-incoming-event-secret-min-32-chars\",\"tool-service\":\"dev-workgraph-incoming-event-secret-min-32-chars\",\"iam\":\"dev-workgraph-incoming-event-secret-min-32-chars\"}}" \
    -e WORKBENCH_TABLES_AUTHORITATIVE="${WORKBENCH_TABLES_AUTHORITATIVE:-false}" \
    -e WORKBENCH_MULTINODE="${WORKBENCH_MULTINODE:-false}" \
    -e CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:3000,http://localhost:5173,http://localhost:5174,http://localhost:5176,http://localhost:5180}" \
    -e PROMPT_COMPOSER_URL=http://prompt-composer:3004 \
    -e AUTH_PROVIDER=iam \
    -e TENANT_ISOLATION_MODE="$TENANT_ISOLATION_MODE" \
    -e DEFAULT_GOVERNANCE_MODE="$DEFAULT_GOVERNANCE_MODE" \
    -e WORKGRAPH_FORCE_GOVERNED_CODING="$WORKGRAPH_FORCE_GOVERNED_CODING" \
    -e CONTEXT_FABRIC_GOVERN_SIDE_CALLERS="$CONTEXT_FABRIC_GOVERN_SIDE_CALLERS" \
    -e IAM_BASE_URL=http://iam-service:8100/api/v1 \
    -e IAM_SERVICE_TOKEN_TENANT_IDS="${IAM_SERVICE_TOKEN_TENANT_IDS:-}" \
    -e WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS="${WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS:-}" \
    -e IAM_BOOTSTRAP_USERNAME="$IAM_BOOTSTRAP_USERNAME" \
    -e IAM_BOOTSTRAP_PASSWORD="$IAM_BOOTSTRAP_PASSWORD" \
    -e AGENT_SERVICE_URL=http://agent-service:3001 \
    -e TOOL_SERVICE_URL=http://tool-service:3002 \
    -e AGENT_RUNTIME_URL=http://agent-runtime:3003 \
    -e AUDIT_GOV_URL="$DOCKER_CORE_AUDIT_URL" \
    -e AUDIT_GOV_SERVICE_TOKEN="$AUDIT_GOV_SERVICE_TOKEN" \
    -e CONTEXT_FABRIC_URL=http://context-api:8000 \
    -e CONTEXT_FABRIC_SERVICE_TOKEN="$CONTEXT_FABRIC_SERVICE_TOKEN" \
    -e MCP_SERVER_URL="$DOCKER_CORE_MCP_URL" \
    -e MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" \
    -e MCP_TOOL_GRANT_MODE="${MCP_TOOL_GRANT_MODE:-off}" \
    -e MCP_REQUIRE_EFFECTIVE_CAPABILITIES="${MCP_REQUIRE_EFFECTIVE_CAPABILITIES:-false}" \
    -e MCP_SESSION_JWT_SECRET="${MCP_SESSION_JWT_SECRET:-dev-mcp-session-secret-min-32-chars!!}" \
    -e FORMAL_VERIFICATION_ENABLED="${FORMAL_VERIFICATION_ENABLED:-false}" \
    -e FORMAL_VERIFIER_URL="${FORMAL_VERIFIER_INTERNAL_URL:-http://host.docker.internal:8010}" \
    -e FORMAL_VERIFICATION_TIMEOUT_MS="${FORMAL_VERIFICATION_DEFAULT_TIMEOUT_MS:-3000}" \
    -e WORKBENCH_DEFAULT_MODEL_ALIAS="${WORKBENCH_DEFAULT_MODEL_ALIAS:-}" \
    -e EVENT_HORIZON_MODEL_ALIAS="${EVENT_HORIZON_MODEL_ALIAS:-}" \
    -e WORKBENCH_AGENT_PHASES_ENABLED="${WORKBENCH_AGENT_PHASES_ENABLED:-false}" \
    -e LLM_GATEWAY_TIMEOUT_SEC="${LLM_GATEWAY_TIMEOUT_SEC:-300}" \
    -e GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
    -v "$ROOT/workgraph-studio/apps/api/src:/app/apps/api/src" \
    -v "$ROOT/workgraph-studio/apps/api/prisma:/app/apps/api/prisma" \
    -v "$ROOT/workgraph-studio/packages:/app/packages" \
    -v "$ROOT/.singularity/downloads:/workspace/downloads:ro" \
    "$IMG_WORKGRAPH" >/dev/null
  wait_for_url "workgraph-api" "http://localhost:${WORKGRAPH_API_PORT:-8080}/health" 240

  log "starting Platform Web"
  rm_container "$PLATFORM_WEB"
  docker run -d \
    --name "$PLATFORM_WEB" \
    --network "$NETWORK" \
    --network-alias platform-web \
    $(docker_add_host_args) \
    -p "${PLATFORM_WEB_PORT:-5180}:80" \
    -e APP_ENV="$APP_ENV" \
    -e ENVIRONMENT="$ENVIRONMENT" \
    -e SINGULARITY_ENV="$SINGULARITY_ENV" \
    -e NEXT_PUBLIC_AGENT_SERVICE_URL=http://localhost:3001 \
    -e NEXT_PUBLIC_TOOL_SERVICE_URL=http://localhost:3002 \
    -e NEXT_PUBLIC_AGENT_RUNTIME_URL=http://localhost:3003 \
    -e NEXT_PUBLIC_PROMPT_COMPOSER_URL=http://localhost:3004 \
    -e NEXT_PUBLIC_WORKGRAPH_WEB_URL=/workflows \
    -e AGENT_SERVICE_URL=http://agent-service:3001 \
    -e TOOL_SERVICE_URL=http://tool-service:3002 \
    -e AGENT_RUNTIME_URL=http://agent-runtime:3003 \
    -e PROMPT_COMPOSER_URL=http://prompt-composer:3004 \
    -e WORKGRAPH_API_URL=http://workgraph-api:8080 \
    -e CONTEXT_FABRIC_URL=http://context-api:8000 \
    -e EVENT_HORIZON_MODEL_ALIAS="${EVENT_HORIZON_MODEL_ALIAS:-}" \
    -e MCP_SERVER_URL="$DOCKER_CORE_MCP_URL" \
    -e MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" \
    -e LLM_GATEWAY_URL="$DOCKER_CORE_LLM_URL" \
    -e LLM_GATEWAY_BEARER="${LLM_GATEWAY_BEARER:-}" \
    -e FORMAL_VERIFIER_URL="${FORMAL_VERIFIER_INTERNAL_URL:-http://host.docker.internal:8010}" \
    -e IAM_BASE_URL=http://iam-service:8100/api/v1 \
    -e IAM_BOOTSTRAP_USERNAME="$IAM_BOOTSTRAP_USERNAME" \
    -e IAM_BOOTSTRAP_PASSWORD="$IAM_BOOTSTRAP_PASSWORD" \
    -e TENANT_ISOLATION_MODE="$TENANT_ISOLATION_MODE" \
    -e REQUIRE_TENANT_ID="$REQUIRE_TENANT_ID" \
    -e IAM_SERVICE_TOKEN_TENANT_IDS="${IAM_SERVICE_TOKEN_TENANT_IDS:-}" \
    -e WORKGRAPH_PROXY_SERVICE_AUTH="${WORKGRAPH_PROXY_SERVICE_AUTH:-true}" \
    -e WORKGRAPH_PROXY_SERVICE_TOKEN="${WORKGRAPH_PROXY_SERVICE_TOKEN:-}" \
    -e PROMPT_COMPOSER_SERVICE_TOKEN="${PROMPT_COMPOSER_SERVICE_TOKEN:-${WORKGRAPH_PROXY_SERVICE_TOKEN:-}}" \
    -e IAM_HEALTH_URL=http://iam-service:8100 \
    -e AUDIT_GOV_URL="$DOCKER_CORE_AUDIT_URL" \
    -e AUDIT_GOV_SERVICE_TOKEN="$AUDIT_GOV_SERVICE_TOKEN" \
    "$IMG_PLATFORM_WEB" >/dev/null
  wait_for_url "platform-web" "http://localhost:${PLATFORM_WEB_PORT:-5180}/healthz" 180
}

run_seed() {
  log "seeding IAM"
  docker exec -i "$AT_PG" psql -v ON_ERROR_STOP=1 -U postgres -d singularity_iam < "$ROOT/seed/00-iam.sql"
  docker exec -i "$AT_PG" psql -v ON_ERROR_STOP=1 -U postgres -d singularity_iam < "$ROOT/seed/04-demo-users.sql"
  docker exec -i "$AT_PG" psql -v ON_ERROR_STOP=1 -U postgres -d singularity_iam < "$ROOT/seed/05-demo-user-capabilities.sql"

  log "seeding agent-runtime SQL baseline"
  docker exec -i "$AT_PG" psql -v ON_ERROR_STOP=1 -U postgres -d singularity < "$ROOT/seed/01-agent-runtime.sql"

  log "seeding agent-runtime service baseline"
  docker exec -T "$PLATFORM_CORE" sh -lc 'cd /app/apps/agent-runtime && DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" npm run seed'

  log "seeding prompt-composer"
  docker exec -T "$PLATFORM_CORE" sh -lc 'cd /app/apps/prompt-composer && DATABASE_URL="$DATABASE_URL_COMPOSER" DATABASE_URL_RUNTIME_READ="$DATABASE_URL_RUNTIME_READ" npm run seed'

  log "seeding Workgraph"
  docker exec -T "$WORKGRAPH" sh -lc 'cd /app/apps/api && DATABASE_URL="$WORKGRAPH_DATABASE_URL_ADMIN" npx prisma db seed'
  docker exec -T "$WORKGRAPH" sh -lc 'cd /app/apps/api && DATABASE_URL="$WORKGRAPH_DATABASE_URL_ADMIN" npx tsx prisma/seed-sdlc-workbench.ts'
  docker exec -T "$WORKGRAPH" sh -lc 'cd /app/apps/api && DATABASE_URL="$WORKGRAPH_DATABASE_URL_ADMIN" npx tsx prisma/seed-sdlc-main.ts'
  docker exec -T \
    -e SEED_GOVERNANCE_MODE="${SEED_GOVERNANCE_MODE:-fail_open}" \
    -e SEED_PREFER_LAPTOP="${SEED_PREFER_LAPTOP:-true}" \
    ${SEED_COPILOT_REPO_URL:+-e SEED_COPILOT_REPO_URL="$SEED_COPILOT_REPO_URL"} \
    "$WORKGRAPH" sh -lc 'cd /app/apps/api && DATABASE_URL="$WORKGRAPH_DATABASE_URL_ADMIN" npx tsx prisma/seed-sdlc-copilot.ts'

  if [ "$WITH_AUDIT" = "1" ] && docker ps --format '{{.Names}}' | grep -qx "$AUDIT_PG"; then
    log "seeding audit-governance"
    docker exec -i "$AUDIT_PG" psql -v ON_ERROR_STOP=1 -U postgres -d audit_governance < "$ROOT/seed/03-audit-governance.sql"
  fi
  log "seed complete"
}

run_smoke() {
  local fail=0
  check_url "Platform Web" "http://localhost:${PLATFORM_WEB_PORT:-5180}/healthz" || fail=$((fail + 1))
  check_url "Platform Web home" "http://localhost:${PLATFORM_WEB_PORT:-5180}/" || fail=$((fail + 1))
  check_url "IAM" "http://localhost:${IAM_PORT:-8100}/api/v1/health" || fail=$((fail + 1))
  check_url "Context Fabric" "http://localhost:${CONTEXT_API_PORT:-8000}/health" || fail=$((fail + 1))
  check_url "Workgraph" "http://localhost:${WORKGRAPH_API_PORT:-8080}/health" || fail=$((fail + 1))
  check_url "agent-service" "http://localhost:${AGENT_SERVICE_PORT:-3001}/health" || fail=$((fail + 1))
  check_url "tool-service" "http://localhost:${TOOL_SERVICE_PORT:-3002}/health" || fail=$((fail + 1))
  check_url "agent-runtime" "http://localhost:${AGENT_RUNTIME_PORT:-3003}/health" || fail=$((fail + 1))
  check_url "prompt-composer" "http://localhost:${PROMPT_COMPOSER_PORT:-3004}/health" || fail=$((fail + 1))
  if [ "$WITH_AUDIT" = "1" ]; then
    check_url "audit-governance" "http://localhost:${AUDIT_GOV_PORT:-8500}/health" || fail=$((fail + 1))
  fi
  if [ "$fail" -gt 0 ]; then
    err "$fail smoke check(s) failed"
    exit 1
  fi
  log "smoke checks passed"
}

check_url() {
  local label="$1"
  local url="$2"
  if command -v curl >/dev/null 2>&1 && curl -fsS -o /dev/null "$url"; then
    printf '  OK   %s %s\n' "$label" "$url"
    return 0
  fi
  printf '  DOWN %s %s\n' "$label" "$url"
  return 1
}

run_status() {
  docker ps -a --filter "network=$NETWORK" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

run_logs() {
  local target="${1:-}"
  [ -n "$target" ] || { err "usage: bin/docker-core.sh logs <service-or-container>"; exit 1; }
  case "$target" in
    at-postgres) target="$AT_PG" ;;
    iam|iam-service) target="$IAM" ;;
    platform-core) target="$PLATFORM_CORE" ;;
    context|context-api) target="$CONTEXT" ;;
    wg-postgres) target="$WG_PG" ;;
    minio|wg-minio) target="$MINIO" ;;
    workgraph|workgraph-api) target="$WORKGRAPH" ;;
    web|platform-web) target="$PLATFORM_WEB" ;;
    audit|audit-governance) target="$AUDIT" ;;
  esac
  docker logs --tail="${LOG_TAIL:-200}" -f "$target"
}

run_down() {
  for c in "$PLATFORM_WEB" "$WORKGRAPH" "$CONTEXT" "$PLATFORM_CORE" "$IAM" "$MINIO" "$WG_BOOT" "$WG_PG" "$AT_BOOT" "$AT_PG" "$AUDIT" "$AUDIT_MIGRATE" "$AUDIT_PG"; do
    rm_container "$c"
  done
  log "stopped plain Docker core containers; data volumes kept"
}

run_nuke() {
  if [ "$YES" != "1" ]; then
    err "nuke deletes plain Docker data volumes; rerun with --yes"
    exit 1
  fi
  run_down
  docker volume rm singularity_at_postgres_data singularity_wg_postgres_data singularity_wg_minio_data >/dev/null 2>&1 || true
  docker volume rm singularity_audit_postgres_data singularity_audit_log_data >/dev/null 2>&1 || true
  log "removed plain Docker data volumes"
}

cmd="${1:-}"
[ -n "$cmd" ] || { usage; exit 1; }
shift || true

case "$cmd" in
  up)
    parse_flags "$@"
    require_docker
    load_env
    ensure_network
    ensure_volumes
    build_images "$BUILD"
    start_infra
    start_audit
    start_apps
    log "ready: http://localhost:${PLATFORM_WEB_PORT:-5180}"
    log "MCP runtime should dial into: ws://localhost:${CONTEXT_API_PORT:-8000}/api/runtime-bridge/connect"
    log "runtime debug URLs: MCP=$DOCKER_CORE_MCP_URL LLM=$DOCKER_CORE_LLM_URL"
    ;;
  build)
    parse_flags "$@"
    require_docker
    load_env
    build_images 1
    ;;
  seed)
    parse_flags "$@"
    require_docker
    load_env
    run_seed
    ;;
  smoke)
    parse_flags "$@"
    require_docker
    load_env
    run_smoke
    ;;
  status)
    require_docker
    load_env
    run_status
    ;;
  logs)
    require_docker
    run_logs "${1:-}"
    ;;
  down)
    parse_flags "$@"
    require_docker
    load_env
    run_down
    ;;
  nuke)
    parse_flags "$@"
    require_docker
    load_env
    run_nuke
    ;;
  --help|-h|help)
    usage
    ;;
  *)
    err "unknown command: $cmd"
    usage
    exit 1
    ;;
esac
