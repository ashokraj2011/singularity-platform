#!/usr/bin/env bash
#
# Configure the split deployment in one place:
#   server/cloud: platform apps + Context Fabric runtime bridge
#   runtime host: MCP + local LLM Gateway dialing into Context Fabric
#
# The script writes server-facing env keys to .env.local, then calls
# bin/mcp-runtime-setup.sh connect to write .env.laptop/.env.llm-secrets,
# configure the provider catalog, start llm-gateway + mcp-server, and verify
# runtime bridge visibility.
#
# Examples:
#   # Show what is missing without changing files or starting processes
#   bin/setup-mcp-server.sh check --provider anthropic
#
#   # Local server, local MCP/LLM runtime, Anthropic + GitHub token
#   bin/setup-mcp-server.sh \
#     --iam-user-id "$IAM_USER_ID" \
#     --jwt-secret "$JWT_SECRET" \
#     --github-token "$GITHUB_TOKEN" \
#     --anthropic-api-key "$ANTHROPIC_API_KEY" \
#     --provider anthropic
#
#   # Copilot through the bundled local OpenAI-compatible bridge
#   bin/setup-mcp-server.sh \
#     --iam-user-id "$IAM_USER_ID" \
#     --jwt-secret "$JWT_SECRET" \
#     --github-token "$GITHUB_TOKEN" \
#     --provider copilot \
#     --start-copilot-bridge
#
#   # Remote/cloud Context Fabric; MCP + LLM runs on this laptop
#   bin/setup-mcp-server.sh \
#     --context-fabric-url https://platform.example.com \
#     --runtime-token "$SINGULARITY_RUNTIME_TOKEN" \
#     --github-token "$GITHUB_TOKEN" \
#     --openai-api-key "$OPENAI_API_KEY" \
#     --provider openai
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

SERVER_ENV_FILE="$ROOT/.env.local"
LAPTOP_ENV_FILE="$ROOT/.env.laptop"
SECRETS_FILE="$ROOT/.env.llm-secrets"
PID_FILE="${MCP_RUNTIME_PID_FILE:-$ROOT/.pids.runtime}"
LOG_DIR="$ROOT/logs"
DEVICE_TOKEN_FILE="${DEVICE_TOKEN_FILE:-$ROOT/.singularity/laptop-device-token}"

C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m'; C_DIM=$'\033[2m'; C_END=$'\033[0m'
info()  { echo "${C_BLUE}>${C_END} $*"; }
ok()    { echo "${C_GREEN}OK${C_END} $*"; }
warn()  { echo "${C_YELLOW}WARN${C_END} $*"; }
err()   { echo "${C_RED}ERR${C_END} $*" >&2; }
dim()   { echo "${C_DIM}$*${C_END}"; }

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print }' "$0"
  cat <<'USAGE'

Options:
  check | --check              Report missing setup pieces without changing files
  --context-fabric-url URL      Server Context Fabric URL (default http://localhost:8000)
  --bridge-url URL              Runtime bridge websocket URL; derived if omitted
  --context-fabric-service-token TOKEN
                                Optional status/diagnostic token for bridge checks
  --tenant-id ID                Optional tenant id for runtime hello metadata/JWT
  --iam-user-id ID              User id for minting a local runtime JWT
  --jwt-secret SECRET           Shared JWT secret for local runtime JWT minting
  --runtime-token JWT           Existing runtime/device JWT
  --runtime-id ID               Stable runtime id
  --runtime-name NAME           Runtime display name
  --workspace PATH              MCP sandbox path

  --provider NAME               mock | anthropic | openai | openrouter | copilot
  --default-model MODEL         Provider model id
  --github-token TOKEN          Enables MCP git clone/push tools
  --anthropic-api-key KEY       Enables Anthropic provider
  --openai-api-key KEY          Enables OpenAI/OpenAI-compatible provider
  --openai-base-url URL         Default https://api.openai.com/v1
  --openrouter-api-key KEY      Enables OpenRouter provider
  --openrouter-base-url URL     Default https://openrouter.ai/api/v1
  --copilot-token TOKEN         Copilot bridge bearer; default copilot-local with bridge
  --copilot-base-url URL        Default http://localhost:4141/v1 for provider=copilot
  --copilot-bin PATH            Default copilot
  --start-copilot-bridge        Start bin/copilot-cli-server.js on --copilot-port
  --copilot-port PORT           Default 4141

  --server-only                 Only write server .env.local keys
  --runtime-only                Only configure/start MCP + LLM runtime
  --no-connect                  Write server env + print the runtime command, do not start runtime
  --seed-event-verifier         Run bin/seed-event-verifier-demo.py after setup
  --simulate-event              Also simulate one event when seeding the Verifier demo

Environment variables with matching names also work:
  CONTEXT_FABRIC_URL, RUNTIME_BRIDGE_URL, CONTEXT_FABRIC_SERVICE_TOKEN,
  SINGULARITY_RUNTIME_TOKEN, SINGULARITY_RUNTIME_ID, SINGULARITY_RUNTIME_NAME,
  SINGULARITY_TENANT_ID, IAM_USER_ID, JWT_SECRET, GITHUB_TOKEN, GH_TOKEN,
  DEFAULT_PROVIDER, DEFAULT_MODEL, ANTHROPIC_API_KEY, OPENAI_API_KEY,
  OPENROUTER_API_KEY, COPILOT_TOKEN, COPILOT_BASE_URL, COPILOT_BIN.
USAGE
}

quote_for_env() {
  printf '%q' "$1"
}

upsert_export_env() {
  local file="$1" key="$2" value="$3"
  [ -n "$value" ] || return 0
  mkdir -p "$(dirname "$file")"
  touch "$file"
  chmod 600 "$file" 2>/dev/null || true
  local tmp="${file}.tmp.$$"
  grep -Ev "^(export[[:space:]]+)?${key}=" "$file" > "$tmp" 2>/dev/null || true
  printf 'export %s=%s\n' "$key" "$(quote_for_env "$value")" >> "$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  set -a
  # shellcheck source=/dev/null
  . "$file"
  set +a
}

derive_bridge_url() {
  local url="${1%/}"
  case "$url" in
    ws://*|wss://*) printf '%s\n' "$url" ;;
    https://*) printf 'wss://%s/api/runtime-bridge/connect\n' "${url#https://}" ;;
    http://*)  printf 'ws://%s/api/runtime-bridge/connect\n' "${url#http://}" ;;
    *)         printf 'ws://%s/api/runtime-bridge/connect\n' "$url" ;;
  esac
}

require_bin() {
  command -v "$1" >/dev/null 2>&1 || { err "missing binary: $1"; exit 1; }
}

http_code() {
  local url="$1" timeout="${2:-3}"
  curl -s -o /dev/null -w '%{http_code}' --max-time "$timeout" "$url" 2>/dev/null || printf '000'
}

http_code_service() {
  local url="$1" token="$2" timeout="${3:-3}"
  if [ -n "$token" ]; then
    curl -s -o /dev/null -w '%{http_code}' --max-time "$timeout" -H "X-Service-Token: $token" "$url" 2>/dev/null || printf '000'
  else
    http_code "$url" "$timeout"
  fi
}

start_copilot_bridge() {
  local port="$1" model="$2" copilot_bin="$3"
  require_bin node
  mkdir -p "$LOG_DIR"
  local code
  code="$(http_code "http://localhost:${port}/v1/models" 2)"
  if [ "$code" = "200" ]; then
    ok "Copilot bridge already responding on :$port"
    return 0
  fi
  info "starting Copilot OpenAI-compatible bridge on :$port"
  local cmd=(node "$ROOT/bin/copilot-cli-server.js" --port "$port" --copilot-bin "$copilot_bin")
  [ -n "$model" ] && cmd+=(--model "$model")
  nohup "${cmd[@]}" > "$LOG_DIR/copilot-cli-server.log" 2>&1 &
  echo $! >> "$PID_FILE"
  local i
  for i in $(seq 1 20); do
    code="$(http_code "http://localhost:${port}/v1/models" 2)"
    [ "$code" = "200" ] && { ok "Copilot bridge ready on :$port"; return 0; }
    sleep 1
  done
  warn "Copilot bridge did not answer /v1/models yet; continuing, check logs/copilot-cli-server.log"
}

print_command() {
  printf '%q ' "$@"
  printf '\n'
}

CHECK_PASS=0
CHECK_WARN=0
CHECK_FAIL=0
check_ok() {
  printf '  OK    %s\n' "$1"
  CHECK_PASS=$((CHECK_PASS + 1))
}
check_warn() {
  printf '  WARN  %s\n' "$1"
  [ -n "${2:-}" ] && printf '        fix: %s\n' "$2"
  CHECK_WARN=$((CHECK_WARN + 1))
}
check_fail() {
  printf '  MISS  %s\n' "$1"
  [ -n "${2:-}" ] && printf '        fix: %s\n' "$2"
  CHECK_FAIL=$((CHECK_FAIL + 1))
}

token_summary() {
  local token="$1"
  TOKEN="$token" node <<'NODE' 2>/dev/null || true
const token = process.env.TOKEN || "";
try {
  const payload = JSON.parse(Buffer.from((token.split(".")[1] || ""), "base64url").toString("utf8"));
  const parts = [];
  if (payload.kind) parts.push(`kind=${payload.kind}`);
  if (payload.sub) parts.push(`sub=${payload.sub}`);
  if (payload.runtime_id) parts.push(`runtime_id=${payload.runtime_id}`);
  if (payload.tenant_id) parts.push(`tenant_id=${payload.tenant_id}`);
  if (payload.exp) {
    const exp = new Date(Number(payload.exp) * 1000);
    parts.push(`exp=${exp.toISOString().slice(0, 10)}`);
    if (Number(payload.exp) < Math.floor(Date.now() / 1000)) parts.push("expired=true");
  }
  process.stdout.write(parts.join(" "));
} catch {
  process.stdout.write("not-decodable");
}
NODE
}

run_preflight_check() {
  CHECK_PASS=0
  CHECK_WARN=0
  CHECK_FAIL=0

  echo "Singularity MCP/server setup check"
  echo "  root:              $ROOT"
  echo "  context fabric:    $context_url"
  echo "  runtime bridge:    $bridge_url"
  echo "  provider:          $provider"
  echo

  echo "1. Local binaries"
  for bin in bash node npm curl python3; do
    if command -v "$bin" >/dev/null 2>&1; then
      check_ok "$bin available ($(command -v "$bin"))"
    else
      check_fail "$bin missing" "install $bin and rerun this check"
    fi
  done
  if command -v git >/dev/null 2>&1; then
    check_ok "git available ($(command -v git))"
  else
    check_warn "git missing" "install git if MCP needs clone/push tools"
  fi
  if command -v jq >/dev/null 2>&1; then
    check_ok "jq available ($(command -v jq))"
  else
    check_warn "jq missing" "install jq for easier status inspection; setup still works without it"
  fi
  echo

  echo "2. Repo scripts and files"
  [ -x "$ROOT/bin/mcp-runtime-setup.sh" ] \
    && check_ok "bin/mcp-runtime-setup.sh executable" \
    || check_fail "bin/mcp-runtime-setup.sh not executable" "chmod +x bin/mcp-runtime-setup.sh"
  [ -f "$ROOT/context-fabric/services/llm_gateway_service/requirements.txt" ] \
    && check_ok "LLM Gateway service files present" \
    || check_fail "LLM Gateway service files missing" "verify this is a complete checkout"
  [ -f "$ROOT/mcp-server/package.json" ] \
    && check_ok "mcp-server package present" \
    || check_fail "mcp-server package missing" "verify this is a complete checkout"
  [ -d "$ROOT/.singularity" ] \
    && check_ok ".singularity directory present" \
    || check_warn ".singularity directory missing" "mkdir -p .singularity or run setup once"
  [ -f "$SERVER_ENV_FILE" ] \
    && check_ok ".env.local present" \
    || check_warn ".env.local not present" "run bin/setup-mcp-server.sh --server-only or bin/setup.sh"
  [ -f "$LAPTOP_ENV_FILE" ] \
    && check_ok ".env.laptop present" \
    || check_warn ".env.laptop not present" "run bin/setup-mcp-server.sh or bin/mcp-runtime-setup.sh connect"
  [ -f "$SECRETS_FILE" ] \
    && check_ok ".env.llm-secrets present" \
    || check_warn ".env.llm-secrets not present" "pass a provider key or run with --provider mock"
  echo

  echo "3. Runtime identity"
  if [ "$connect_runtime" = "1" ]; then
    if [ -n "$runtime_token" ]; then
      local summary
      summary="$(token_summary "$runtime_token")"
      if printf '%s' "$summary" | grep -q 'expired=true'; then
        check_fail "runtime JWT is expired ($summary)" "mint a new token or pass --iam-user-id and --jwt-secret"
      else
        check_ok "runtime JWT present ($summary)"
      fi
    elif [ -n "$iam_user_id" ] && [ -n "$jwt_secret" ]; then
      check_ok "runtime JWT can be minted locally for user $iam_user_id"
    else
      check_fail "runtime identity missing" "pass --runtime-token, or pass both --iam-user-id <id> and --jwt-secret <secret>"
    fi
    [ -n "$tenant_id" ] \
      && check_ok "tenant id configured ($tenant_id)" \
      || check_warn "tenant id not configured" "pass --tenant-id for shared/multi-tenant deployments"
  else
    check_ok "runtime start skipped by selected mode"
  fi
  [ -n "$context_service_token" ] \
    && check_ok "Context Fabric service token loaded (length=${#context_service_token})" \
    || check_warn "Context Fabric service token not loaded" "status checks may show 'missing runtime bridge service token'; source .env.local or pass --context-fabric-service-token"
  echo

  echo "4. Provider and Git credentials"
  case "$provider" in
    mock)
      check_ok "mock provider selected; no provider key required"
      ;;
    anthropic)
      [ -n "$anthropic_key" ] \
        && check_ok "ANTHROPIC_API_KEY provided" \
        || check_fail "ANTHROPIC_API_KEY missing" "export ANTHROPIC_API_KEY=... or pass --anthropic-api-key"
      ;;
    openai)
      [ -n "$openai_key" ] \
        && check_ok "OPENAI_API_KEY provided" \
        || check_fail "OPENAI_API_KEY missing" "export OPENAI_API_KEY=... or pass --openai-api-key"
      [ -n "$openai_base_url" ] \
        && check_ok "OpenAI-compatible base URL configured ($openai_base_url)" \
        || check_ok "OpenAI base URL will default to https://api.openai.com/v1"
      ;;
    openrouter)
      [ -n "$openrouter_key" ] \
        && check_ok "OPENROUTER_API_KEY provided" \
        || check_fail "OPENROUTER_API_KEY missing" "export OPENROUTER_API_KEY=... or pass --openrouter-api-key"
      ;;
    copilot)
      [ -f "$ROOT/bin/copilot-cli-server.js" ] \
        && check_ok "Copilot bridge script present" \
        || check_fail "Copilot bridge script missing" "verify bin/copilot-cli-server.js exists"
      if command -v "$copilot_bin" >/dev/null 2>&1; then
        check_ok "Copilot CLI available ($(command -v "$copilot_bin"))"
      else
        check_warn "Copilot CLI '$copilot_bin' not found" "install/login GitHub Copilot CLI or pass --copilot-bin"
      fi
      local models_code
      models_code="$(http_code "${copilot_base_url%/}/models" 2)"
      [ "$models_code" = "200" ] \
        && check_ok "Copilot bridge responding at ${copilot_base_url%/}/models" \
        || check_warn "Copilot bridge not responding at ${copilot_base_url%/}/models" "rerun with --start-copilot-bridge or start node bin/copilot-cli-server.js --port $copilot_port"
      ;;
  esac
  [ -n "$default_model" ] \
    && check_ok "default model configured ($default_model)" \
    || check_warn "default model not explicitly configured" "pass --default-model if you do not want provider defaults"
  [ -n "$github_token" ] \
    && check_ok "GitHub token provided for MCP git tools" \
    || check_warn "GitHub token missing" "export GITHUB_TOKEN=... or pass --github-token if workflows need clone/push"
  echo

  echo "5. Reachability"
  local health_code status_code gateway_code mcp_code
  health_code="$(http_code "${context_url%/}/health" 3)"
  [ "$health_code" = "200" ] \
    && check_ok "Context Fabric health reachable (${context_url%/}/health)" \
    || check_warn "Context Fabric health not reachable (HTTP $health_code)" "start platform apps or pass --context-fabric-url"
  status_code="$(http_code_service "${context_url%/}/api/runtime-bridge/status" "$context_service_token" 4)"
  case "$status_code" in
    2??) check_ok "Runtime Bridge status reachable with current token" ;;
    401|403) check_warn "Runtime Bridge status is protected (HTTP $status_code)" "use curl -H \"X-Service-Token: \$CONTEXT_FABRIC_SERVICE_TOKEN\" ${context_url%/}/api/runtime-bridge/status" ;;
    *) check_warn "Runtime Bridge status not reachable (HTTP $status_code)" "start Context Fabric or verify --context-fabric-url" ;;
  esac
  gateway_code="$(http_code "http://localhost:8001/health" 2)"
  [ "$gateway_code" = "200" ] \
    && check_ok "local LLM Gateway already running on :8001" \
    || check_warn "local LLM Gateway not running on :8001" "run bin/setup-mcp-server.sh ... or bin/mcp-runtime-setup.sh connect"
  mcp_code="$(http_code "http://localhost:7100/healthz/strict" 2)"
  case "$mcp_code" in
    2??|401|403) check_ok "local MCP debug endpoint reachable on :7100 (HTTP $mcp_code)" ;;
    *) check_warn "local MCP debug endpoint not reachable on :7100" "normal runtime bridge can still work; start runtime to enable debug health" ;;
  esac
  echo

  echo "Summary: OK=$CHECK_PASS WARN=$CHECK_WARN MISSING=$CHECK_FAIL"
  if [ "$CHECK_FAIL" -gt 0 ]; then
    echo "Run the fix commands above, then rerun: bin/setup-mcp-server.sh check"
    return 1
  fi
  echo "No blocking setup pieces are missing."
}

load_env_file "$SERVER_ENV_FILE"
load_env_file "$LAPTOP_ENV_FILE"
load_env_file "$SECRETS_FILE"

context_url="${CONTEXT_FABRIC_URL:-http://localhost:8000}"
bridge_url="${RUNTIME_BRIDGE_URL:-${LAPTOP_BRIDGE_URL:-}}"
context_service_token="${CONTEXT_FABRIC_SERVICE_TOKEN:-${IAM_SERVICE_TOKEN:-}}"
tenant_id="${SINGULARITY_TENANT_ID:-}"
iam_user_id="${IAM_USER_ID:-${SINGULARITY_USER_ID:-}}"
jwt_secret="${JWT_SECRET:-}"
runtime_token="${SINGULARITY_RUNTIME_TOKEN:-${SINGULARITY_DEVICE_TOKEN:-}}"
runtime_id="${SINGULARITY_RUNTIME_ID:-}"
runtime_name="${SINGULARITY_RUNTIME_NAME:-mcp-runtime-local}"
workspace="${MCP_SANDBOX_ROOT:-$HOME/sg-laptop-workspace}"

provider="${DEFAULT_PROVIDER:-}"
default_model="${DEFAULT_MODEL:-}"
github_token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
anthropic_key="${ANTHROPIC_API_KEY:-}"
openai_key="${OPENAI_API_KEY:-}"
openai_base_url="${OPENAI_BASE_URL:-}"
openrouter_key="${OPENROUTER_API_KEY:-}"
openrouter_base_url="${OPENROUTER_BASE_URL:-}"
anthropic_base_url="${ANTHROPIC_BASE_URL:-}"
copilot_token="${COPILOT_TOKEN:-}"
copilot_base_url="${COPILOT_BASE_URL:-}"
copilot_bin="${COPILOT_BIN:-copilot}"
copilot_port="${COPILOT_CLI_PORT:-4141}"

write_server=1
connect_runtime=1
seed_event_verifier=0
simulate_event=0
start_bridge=0
check_only=0

while [ $# -gt 0 ]; do
  case "$1" in
    check|--check|--check-only) check_only=1; shift ;;
    --context-fabric-url|--context-url) context_url="${2:?missing value}"; shift 2 ;;
    --bridge-url|--runtime-bridge-url) bridge_url="${2:?missing value}"; shift 2 ;;
    --context-fabric-service-token|--service-token) context_service_token="${2:?missing value}"; shift 2 ;;
    --tenant-id) tenant_id="${2:?missing value}"; shift 2 ;;
    --iam-user-id|--user-id) iam_user_id="${2:?missing value}"; shift 2 ;;
    --jwt-secret) jwt_secret="${2:?missing value}"; shift 2 ;;
    --runtime-token) runtime_token="${2:?missing value}"; shift 2 ;;
    --runtime-id) runtime_id="${2:?missing value}"; shift 2 ;;
    --runtime-name|--device-name) runtime_name="${2:?missing value}"; shift 2 ;;
    --workspace|--sandbox-root) workspace="${2:?missing value}"; shift 2 ;;
    --provider|--default-provider) provider="${2:?missing value}"; shift 2 ;;
    --default-model|--model) default_model="${2:?missing value}"; shift 2 ;;
    --github-token|--gh-token) github_token="${2:?missing value}"; shift 2 ;;
    --anthropic-api-key) anthropic_key="${2:?missing value}"; shift 2 ;;
    --anthropic-base-url) anthropic_base_url="${2:?missing value}"; shift 2 ;;
    --openai-api-key) openai_key="${2:?missing value}"; shift 2 ;;
    --openai-base-url) openai_base_url="${2:?missing value}"; shift 2 ;;
    --openrouter-api-key) openrouter_key="${2:?missing value}"; shift 2 ;;
    --openrouter-base-url) openrouter_base_url="${2:?missing value}"; shift 2 ;;
    --copilot-token) copilot_token="${2:?missing value}"; shift 2 ;;
    --copilot-base-url) copilot_base_url="${2:?missing value}"; shift 2 ;;
    --copilot-bin) copilot_bin="${2:?missing value}"; shift 2 ;;
    --copilot-port) copilot_port="${2:?missing value}"; shift 2 ;;
    --start-copilot-bridge) start_bridge=1; shift ;;
    --server-only) connect_runtime=0; shift ;;
    --runtime-only) write_server=0; shift ;;
    --no-connect) connect_runtime=0; shift ;;
    --seed-event-verifier) seed_event_verifier=1; shift ;;
    --simulate-event) seed_event_verifier=1; simulate_event=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown option: $1"; usage; exit 1 ;;
  esac
done

[ -n "$bridge_url" ] || bridge_url="$(derive_bridge_url "$context_url")"
provider="$(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]')"
if [ -z "$provider" ]; then
  if [ -n "$copilot_base_url" ]; then provider="copilot"
  elif [ -n "$anthropic_key" ]; then provider="anthropic"
  elif [ -n "$openai_key" ]; then provider="openai"
  elif [ -n "$openrouter_key" ]; then provider="openrouter"
  else provider="mock"
  fi
fi
case "$provider" in
  mock|anthropic|openai|openrouter|copilot) ;;
  *) err "--provider must be mock, anthropic, openai, openrouter, or copilot"; exit 1 ;;
esac

if [ "$provider" = "copilot" ]; then
  [ -n "$copilot_base_url" ] || copilot_base_url="http://localhost:${copilot_port}/v1"
  [ -n "$copilot_token" ] || copilot_token="copilot-local"
  [ -n "$default_model" ] || default_model="${COPILOT_MODEL:-gpt-4o}"
fi

if [ -z "$runtime_token" ] && [ -s "$DEVICE_TOKEN_FILE" ]; then
  runtime_token="$(tr -d '\n' < "$DEVICE_TOKEN_FILE")"
fi

if [ "$check_only" = "1" ]; then
  run_preflight_check
  exit $?
fi

if [ "$write_server" = "1" ]; then
  info "writing server runtime bridge env to .env.local"
  upsert_export_env "$SERVER_ENV_FILE" CONTEXT_FABRIC_URL "$context_url"
  upsert_export_env "$SERVER_ENV_FILE" RUNTIME_BRIDGE_URL "$bridge_url"
  upsert_export_env "$SERVER_ENV_FILE" LAPTOP_BRIDGE_URL "$bridge_url"
  upsert_export_env "$SERVER_ENV_FILE" RUNTIME_HTTP_FALLBACK_ENABLED "false"
  upsert_export_env "$SERVER_ENV_FILE" LLM_GATEWAY_URL "http://localhost:8001"
  upsert_export_env "$SERVER_ENV_FILE" LLM_PROVIDER_CONFIG_PATH "$ROOT/.singularity/llm-providers.json"
  upsert_export_env "$SERVER_ENV_FILE" LLM_MODEL_CATALOG_PATH "$ROOT/.singularity/llm-models.json"
  [ -n "$context_service_token" ] && upsert_export_env "$SERVER_ENV_FILE" CONTEXT_FABRIC_SERVICE_TOKEN "$context_service_token"
  ok "server env updated: $SERVER_ENV_FILE"
fi

if [ "$start_bridge" = "1" ]; then
  start_copilot_bridge "$copilot_port" "$default_model" "$copilot_bin"
fi

runtime_cmd=("$ROOT/bin/mcp-runtime-setup.sh" connect
  --context-fabric-url "$context_url"
  --bridge-url "$bridge_url"
  --runtime-name "$runtime_name"
  --workspace "$workspace"
  --default-provider "$provider"
)
[ -n "$context_service_token" ] && runtime_cmd+=(--context-fabric-service-token "$context_service_token")
[ -n "$tenant_id" ] && runtime_cmd+=(--tenant-id "$tenant_id")
[ -n "$iam_user_id" ] && runtime_cmd+=(--iam-user-id "$iam_user_id")
[ -n "$jwt_secret" ] && runtime_cmd+=(--jwt-secret "$jwt_secret")
[ -n "$runtime_token" ] && runtime_cmd+=(--runtime-token "$runtime_token")
[ -n "$runtime_id" ] && runtime_cmd+=(--runtime-id "$runtime_id")
[ -n "$default_model" ] && runtime_cmd+=(--default-model "$default_model")
[ -n "$github_token" ] && runtime_cmd+=(--github-token "$github_token")
[ -n "$anthropic_key" ] && runtime_cmd+=(--anthropic-api-key "$anthropic_key")
[ -n "$anthropic_base_url" ] && runtime_cmd+=(--anthropic-base-url "$anthropic_base_url")
[ -n "$openai_key" ] && runtime_cmd+=(--openai-api-key "$openai_key")
[ -n "$openai_base_url" ] && runtime_cmd+=(--openai-base-url "$openai_base_url")
[ -n "$openrouter_key" ] && runtime_cmd+=(--openrouter-api-key "$openrouter_key")
[ -n "$openrouter_base_url" ] && runtime_cmd+=(--openrouter-base-url "$openrouter_base_url")
[ -n "$copilot_token" ] && runtime_cmd+=(--copilot-token "$copilot_token")
[ -n "$copilot_base_url" ] && runtime_cmd+=(--copilot-base-url "$copilot_base_url")
[ -n "$copilot_bin" ] && runtime_cmd+=(--copilot-bin "$copilot_bin")

if [ "$connect_runtime" = "1" ]; then
  info "configuring and starting MCP + LLM runtime"
  "${runtime_cmd[@]}"
else
  echo
  dim "runtime not started. To start MCP + LLM runtime later:"
  print_command "${runtime_cmd[@]}"
fi

if [ "$seed_event_verifier" = "1" ]; then
  info "bootstrapping event Verifier demo workflow"
  sim_arg=()
  [ "$simulate_event" = "1" ] && sim_arg=(--simulate)
  if "$ROOT/bin/seed-event-verifier-demo.py" --workgraph-url "${WORKGRAPH_API_URL:-http://localhost:8080}" "${sim_arg[@]}"; then
    ok "event Verifier demo is ready"
  else
    warn "event Verifier bootstrap failed; server may not be up yet"
  fi
fi

echo
ok "MCP/server setup complete"
echo "  server env:     $SERVER_ENV_FILE"
echo "  runtime env:    $LAPTOP_ENV_FILE"
echo "  LLM secrets:    $SECRETS_FILE"
echo "  bridge status:  curl -s ${context_url%/}/api/runtime-bridge/status | jq"
echo "  LLM providers:  curl -s http://localhost:8001/llm/providers | jq"
