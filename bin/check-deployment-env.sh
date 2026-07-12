#!/usr/bin/env bash
set -uo pipefail

# Non-secret environment inventory for the two deployment boundaries:
#   client: MCP + local LLM Gateway
#   server: IAM + Context Fabric + platform services
# Values are never printed; only presence, length, and safe posture are shown.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-all}"
shift || true
STRICT="${ENV_CHECK_STRICT:-0}"
SPLIT_RUNTIME="${SPLIT_RUNTIME:-${DEPLOYMENT_MODE:-}}"
RUNTIME_CONFIG_DIR="${SINGULARITY_RUNTIME_CONFIG_DIR:-}"
RUNTIME_TOKEN_PRESENT="${SINGULARITY_RUNTIME_TOKEN_PRESENT:-}"
ARG_CONTEXT_URL=""; ARG_BRIDGE_URL=""; ARG_RUNTIME_ID=""; ARG_RUNTIME_NAME=""
ARG_WORKSPACE=""; ARG_PROVIDER=""; ARG_MODEL=""

if [ -z "$RUNTIME_CONFIG_DIR" ]; then
  if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ]; then
    RUNTIME_CONFIG_DIR="${HOME}/Library/Application Support/Singularity"
  else
    RUNTIME_CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/singularity"
  fi
fi

usage() {
  cat <<'USAGE'
Usage:
  bin/check-deployment-env.sh client [options]
  bin/check-deployment-env.sh server [--strict] [--split-runtime]
  bin/check-deployment-env.sh all [options]

Checks environment names, local executable prerequisites, runtime identity,
provider readiness, service tokens, URLs, database settings, and security
posture without printing secret values.

Client overrides:
  --context-fabric-url URL   Effective Context Fabric URL
  --bridge-url URL           Effective Runtime Bridge URL
  --runtime-id ID            Runtime id from enrollment
  --runtime-name NAME        Runtime display name
  --workspace PATH           MCP workspace
  --provider NAME            mock | anthropic | openai | openrouter
  --default-model MODEL      Model alias
  --runtime-token-present 0|1  Token exists in env/keychain/config
  --split-runtime            Expect a remote Context Fabric and local runtime
  --strict                   Missing conditional values fail the check
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --strict) STRICT=1; shift ;;
    --split-runtime) SPLIT_RUNTIME=1; shift ;;
    --context-fabric-url|--context-url) ARG_CONTEXT_URL="${2:?missing value}"; shift 2 ;;
    --bridge-url|--runtime-bridge-url) ARG_BRIDGE_URL="${2:?missing value}"; shift 2 ;;
    --runtime-id) ARG_RUNTIME_ID="${2:?missing value}"; shift 2 ;;
    --runtime-name) ARG_RUNTIME_NAME="${2:?missing value}"; shift 2 ;;
    --workspace) ARG_WORKSPACE="${2:?missing value}"; shift 2 ;;
    --provider|--default-provider) ARG_PROVIDER="${2:?missing value}"; shift 2 ;;
    --default-model|--model) ARG_MODEL="${2:?missing value}"; shift 2 ;;
    --runtime-token-present) RUNTIME_TOKEN_PRESENT="${2:?missing value}"; shift 2 ;;
    --runtime-config) RUNTIME_CONFIG_DIR="${2:?missing value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
done

case "$MODE" in client|server|all) ;; *) printf 'mode must be client, server, or all\n' >&2; exit 2 ;; esac

load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  set +u
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
  set -u
}

load_env_file "$ROOT/.env"
load_env_file "$ROOT/.env.local"
load_env_file "$ROOT/.env.laptop"
load_env_file "$ROOT/.env.llm-secrets"

config_value() {
  local key="$1" file="$RUNTIME_CONFIG_DIR/runtime.json"
  [ -f "$file" ] || return 0
  python3 - "$file" "$key" <<'PY' 2>/dev/null || true
import json
import sys
try:
    value = json.loads(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2])
    if value is not None:
        print(value)
except Exception:
    pass
PY
}

# Runtime CLI configuration is authoritative for client-only values when the
# caller did not provide explicit command-line overrides.
[ -n "$ARG_CONTEXT_URL" ] || ARG_CONTEXT_URL="$(config_value context_fabric_url)"
[ -n "$ARG_RUNTIME_ID" ] || ARG_RUNTIME_ID="$(config_value runtime_id)"
[ -n "$ARG_RUNTIME_NAME" ] || ARG_RUNTIME_NAME="$(config_value runtime_name)"
[ -n "$ARG_WORKSPACE" ] || ARG_WORKSPACE="$(config_value workspace)"
[ -n "$ARG_PROVIDER" ] || ARG_PROVIDER="${DEFAULT_PROVIDER:-}"
[ -n "$ARG_MODEL" ] || ARG_MODEL="${DEFAULT_MODEL:-}"

if [ -z "$ARG_RUNTIME_ID" ]; then
  runtime_token_for_claims="${SINGULARITY_RUNTIME_TOKEN:-${SINGULARITY_DEVICE_TOKEN:-}}"
  if [ -z "$runtime_token_for_claims" ] && [ -s "$RUNTIME_CONFIG_DIR/runtime-token" ]; then
    runtime_token_for_claims="$(tr -d '\n' < "$RUNTIME_CONFIG_DIR/runtime-token")"
  fi
  if [ -z "$runtime_token_for_claims" ] && [ -s "$ROOT/.singularity/laptop-device-token" ]; then
    runtime_token_for_claims="$(tr -d '\n' < "$ROOT/.singularity/laptop-device-token")"
  fi
  if [ -n "$runtime_token_for_claims" ] && command -v node >/dev/null 2>&1; then
    ARG_RUNTIME_ID="$(TOKEN="$runtime_token_for_claims" node <<'NODE' 2>/dev/null || true
try {
  const body = JSON.parse(Buffer.from((process.env.TOKEN || '').split('.')[1] || '', 'base64url').toString('utf8'));
  process.stdout.write(String(body.runtime_id || body.device_id || ''));
} catch {}
NODE
)"
  fi
fi
[ -n "$ARG_CONTEXT_URL" ] && export CONTEXT_FABRIC_URL="$ARG_CONTEXT_URL"
[ -n "$ARG_BRIDGE_URL" ] && export RUNTIME_BRIDGE_URL="$ARG_BRIDGE_URL"
[ -n "$ARG_RUNTIME_ID" ] && export SINGULARITY_RUNTIME_ID="$ARG_RUNTIME_ID"
[ -n "$ARG_RUNTIME_NAME" ] && export SINGULARITY_RUNTIME_NAME="$ARG_RUNTIME_NAME"
[ -n "$ARG_WORKSPACE" ] && export MCP_SANDBOX_ROOT="$ARG_WORKSPACE"
[ -n "$ARG_PROVIDER" ] && export DEFAULT_PROVIDER="$ARG_PROVIDER"
[ -n "$ARG_MODEL" ] && export DEFAULT_MODEL="$ARG_MODEL"

if [ -z "$RUNTIME_TOKEN_PRESENT" ]; then
  if [ -n "${SINGULARITY_RUNTIME_TOKEN:-${SINGULARITY_DEVICE_TOKEN:-}}" ]; then
    RUNTIME_TOKEN_PRESENT=1
  elif [ -s "$RUNTIME_CONFIG_DIR/runtime-token" ] || [ -s "$ROOT/.singularity/laptop-device-token" ]; then
    RUNTIME_TOKEN_PRESENT=1
  else
    keychain_runtime_id="${SINGULARITY_RUNTIME_ID:-}"
    if [ -n "$keychain_runtime_id" ] && [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v security >/dev/null 2>&1; then
      security find-generic-password -s "Singularity Runtime" -a "$keychain_runtime_id" -w >/dev/null 2>&1 && RUNTIME_TOKEN_PRESENT=1 || RUNTIME_TOKEN_PRESENT=0
    elif [ -n "$keychain_runtime_id" ] && command -v secret-tool >/dev/null 2>&1; then
      secret-tool lookup service "Singularity Runtime" account "$keychain_runtime_id" >/dev/null 2>&1 && RUNTIME_TOKEN_PRESENT=1 || RUNTIME_TOKEN_PRESENT=0
    else
      RUNTIME_TOKEN_PRESENT=0
    fi
  fi
fi

PASS=0; WARN=0; FAIL=0
pass() { printf '  OK      %s\n' "$1"; PASS=$((PASS+1)); }
warn() { printf '  WARN    %s\n      fix: %s\n' "$1" "${2:-review configuration}"; WARN=$((WARN+1)); }
fail() { printf '  MISSING %s\n      fix: %s\n' "$1" "${2:-set the value and rerun this check}"; FAIL=$((FAIL+1)); }
section() { printf '\n%s\n' "$1"; }

value_of() {
  local key="$1"
  eval "printf '%s' \"\${$key-}\""
}

length_of() { printf '%s' "$1" | wc -c | tr -d ' '; }

show_set() {
  local key="$1" value
  value="$(value_of "$key")"
  [ -n "$value" ] && pass "$key set (length=$(length_of "$value"))" || warn "$key missing" "set $key in the deployment env or use the setup script"
}

require_set() {
  local key="$1" fix="${2:-set $1}"
  [ -n "$(value_of "$key")" ] && pass "$key set (length=$(length_of "$(value_of "$key")"))" || {
    if [ "$STRICT" = "1" ]; then fail "$key missing" "$fix"; else warn "$key missing" "$fix"; fi
  }
}

check_command() {
  local command_name="$1" required="$2"
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "$command_name available ($(command -v "$command_name"))"
  elif [ "$required" = "1" ]; then
    fail "$command_name is not installed" "install $command_name"
  else
    warn "$command_name is not installed" "install $command_name when this capability is used"
  fi
}

check_url() {
  local key="$1" fallback="$2" value
  value="$(value_of "$key")"
  if [ -n "$value" ]; then pass "$key set ($value)"; else pass "$key effective default ($fallback)"; fi
}

check_any() {
  local label="$1" fix="$2" key value
  shift 2
  for key in "$@"; do
    value="$(value_of "$key")"
    [ -n "$value" ] && { pass "$label: $key set (length=$(length_of "$value"))"; return 0; }
  done
  if [ "$STRICT" = "1" ]; then fail "$label missing (${*})" "$fix"; else warn "$label missing (${*})" "$fix"; fi
}

client_check() {
  section "Client runtime environment"
  check_command node 1
  check_command npm 1
  check_command curl 1
  check_command git 1
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
    pass "python3 >= 3.11"
  else
    fail "python3 >= 3.11 missing" "install Python 3.11+ or set SINGULARITY_PYTHON"
  fi

  require_set CONTEXT_FABRIC_URL "set the cloud Context Fabric base URL"
  if [ -n "${RUNTIME_BRIDGE_URL:-}" ]; then pass "RUNTIME_BRIDGE_URL set ($RUNTIME_BRIDGE_URL)";
  elif [ -n "${CONTEXT_FABRIC_URL:-}" ]; then pass "RUNTIME_BRIDGE_URL derived from CONTEXT_FABRIC_URL";
  else require_set RUNTIME_BRIDGE_URL "set ws(s)://.../api/runtime-bridge/connect"; fi
  if [ "$RUNTIME_TOKEN_PRESENT" = "1" ]; then pass "runtime token available in env, keychain, or secure config"; else fail "runtime token missing" "run singularity-runtime enroll or provide SINGULARITY_RUNTIME_TOKEN"; fi
  [ -n "${SINGULARITY_RUNTIME_ID:-}" ] && pass "SINGULARITY_RUNTIME_ID set" || fail "SINGULARITY_RUNTIME_ID missing" "enroll the runtime from Platform Settings"
  [ -n "${SINGULARITY_RUNTIME_NAME:-}" ] && pass "SINGULARITY_RUNTIME_NAME set" || warn "SINGULARITY_RUNTIME_NAME missing" "set a display name with singularity-runtime configure"

  local workspace="${MCP_SANDBOX_ROOT:-$HOME/sg-laptop-workspace}"
  [ -d "$workspace" ] && pass "MCP_SANDBOX_ROOT available ($workspace)" || warn "MCP_SANDBOX_ROOT directory does not exist ($workspace)" "create it or run singularity-runtime configure --workspace PATH"
  check_url LLM_GATEWAY_URL "http://localhost:8001"
  local provider="$(printf '%s' "${DEFAULT_PROVIDER:-mock}" | tr '[:upper:]' '[:lower:]')"
  case "$provider" in
    mock) pass "DEFAULT_PROVIDER=mock (no provider key required)" ;;
    anthropic) require_set ANTHROPIC_API_KEY "set ANTHROPIC_API_KEY in the client secret store" ;;
    openai) require_set OPENAI_API_KEY "set OPENAI_API_KEY in the client secret store" ;;
    openrouter) require_set OPENROUTER_API_KEY "set OPENROUTER_API_KEY in the client secret store" ;;
    copilot|github_copilot) fail "Copilot is incorrectly configured as a Gateway provider" "use AGENT_TASK executor=copilot and copilot_execute" ;;
    *) fail "unsupported DEFAULT_PROVIDER=$provider" "use mock, anthropic, openai, or openrouter" ;;
  esac
  show_set DEFAULT_MODEL
  if [ "${MCP_GIT_AUTH_MODE:-}" = "token" ] || [ "${MCP_GIT_PUSH_ENABLED:-false}" = "true" ]; then
    require_set GITHUB_TOKEN "set GITHUB_TOKEN for client-side Git operations"
  else
    show_set GITHUB_TOKEN
  fi
  if [ "${COPILOT_REQUIRED:-${WORKFLOW_EXECUTOR:-}}" = "copilot" ]; then
    require_set COPILOT_BIN "install/authenticate Copilot CLI and set COPILOT_BIN"
    command -v "${COPILOT_BIN:-copilot}" >/dev/null 2>&1 && pass "Copilot CLI executable available" || fail "Copilot CLI executable unavailable" "set COPILOT_BIN to an absolute path"
  else
    show_set COPILOT_BIN
  fi
  show_set MCP_LLM_PROVIDER_CONFIG_PATH
  show_set MCP_LLM_MODEL_CATALOG_PATH
  if [ "${RUNTIME_HTTP_FALLBACK_ENABLED:-false}" = "true" ]; then require_set MCP_BEARER_TOKEN "set MCP_BEARER_TOKEN when HTTP fallback is explicitly enabled"; else pass "RUNTIME_HTTP_FALLBACK_ENABLED is not enabled"; fi
}

server_check() {
  section "Server platform environment"
  check_command curl 1
  check_command psql 0
  check_any "JWT signing secret" "set JWT_SECRET to a strong shared value" JWT_SECRET
  check_any "Context Fabric service authentication" "set CONTEXT_FABRIC_SERVICE_TOKEN or IAM_SERVICE_TOKEN" CONTEXT_FABRIC_SERVICE_TOKEN IAM_SERVICE_TOKEN
  require_set WORKGRAPH_PROXY_SERVICE_TOKEN "mint a platform-web Workgraph proxy token"
  require_set PROMPT_COMPOSER_SERVICE_TOKEN "set the Platform Web → Prompt Composer service token"
  require_set WORKGRAPH_INTERNAL_TOKEN "set Workgraph internal service authentication"
  require_set WORKGRAPH_EVENT_SECRET_KEY "set the Workgraph inbound event secret"
  require_set AUDIT_GOV_SERVICE_TOKEN "set Audit Governance service authentication"
  require_set TOOL_GRANT_SIGNING_SECRET "set the shared Context Fabric/MCP tool grant signing secret"

  check_url IAM_BASE_URL "http://localhost:8100/api/v1"
  check_url CONTEXT_FABRIC_URL "http://localhost:8000"
  check_url WORKGRAPH_API_URL "http://localhost:8080"
  check_url AGENT_RUNTIME_URL "http://localhost:3003"
  check_url PROMPT_COMPOSER_URL "http://localhost:3004"
  check_url AUDIT_GOV_URL "http://localhost:8500"
  show_set MCP_SERVER_URL
  show_set LLM_GATEWAY_URL
  check_any "application database configuration" "set DATABASE_URL or the service-specific DATABASE_URL_* values" DATABASE_URL DATABASE_URL_AGENT_TOOLS DATABASE_URL_COMPOSER CONTEXT_FABRIC_DATABASE_URL DATABASE_URL_WORKGRAPH_RUNTIME

  show_set RUNTIME_HTTP_FALLBACK_ENABLED
  [ "${RUNTIME_HTTP_FALLBACK_ENABLED:-false}" = "false" ] && pass "direct MCP/LLM HTTP fallback is disabled" || warn "direct MCP/LLM HTTP fallback is enabled" "set RUNTIME_HTTP_FALLBACK_ENABLED=false for Runtime Bridge-first operation"
  show_set DEFAULT_GOVERNANCE_MODE
  show_set MCP_DEFAULT_GOVERNANCE_MODE
  show_set MCP_TOOL_GRANT_MODE
  show_set MCP_REQUIRE_EFFECTIVE_CAPABILITIES
  show_set PROVIDER_MANIFEST_SIGNATURE_MODE
  show_set AGENT_SOURCE_ALLOW_PRIVATE_URLS
  if [ "${AGENT_SOURCE_ALLOW_PRIVATE_URLS:-false}" = "true" ]; then warn "private agent source URLs are enabled" "set AGENT_SOURCE_ALLOW_PRIVATE_URLS=false outside local development"; fi

  if [ "$SPLIT_RUNTIME" = "1" ] || [ "$SPLIT_RUNTIME" = "true" ] || [ "$SPLIT_RUNTIME" = "split-runtime" ]; then
    [ "${PREFER_LAPTOP_LLM:-false}" = "true" ] && pass "PREFER_LAPTOP_LLM=true for split runtime" || require_set PREFER_LAPTOP_LLM "set PREFER_LAPTOP_LLM=true when local MCP/LLM serves platform model-run frames"
    [ "${RUNTIME_HTTP_FALLBACK_ENABLED:-false}" != "true" ] && pass "split runtime is WebSocket-first" || warn "split runtime still permits HTTP fallback" "disable RUNTIME_HTTP_FALLBACK_ENABLED"
  else
    show_set PREFER_LAPTOP_LLM
  fi
}

case "$MODE" in
  client) client_check ;;
  server) server_check ;;
  all) server_check; client_check ;;
esac

printf '\nEnvironment summary: %s OK, %s warnings, %s blocking misses\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ]
