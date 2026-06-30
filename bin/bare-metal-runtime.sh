#!/usr/bin/env bash
set -euo pipefail

# Bare-metal runtime-infra launcher.
#
# Owns only the local LLM Gateway (:8001) and MCP/tool runtime. Normal mode is
# runtime dial-in: MCP opens an outbound WebSocket to Context Fabric and relays
# tool-run/model-run/code-context frames to local tools + local LLM Gateway.
# Direct MCP HTTP on :7100 is retained only as an explicit debug fallback.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
PID_FILE="$ROOT/.pids.runtime"
ENV_FILE="$ROOT/.env.local"
DEVICE_TOKEN_FILE="${DEVICE_TOKEN_FILE:-$ROOT/.singularity/laptop-device-token}"

C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m';  C_DIM=$'\033[2m';      C_END=$'\033[0m'
info()  { echo -e "${C_BLUE}>${C_END} $*"; }
ok()    { echo -e "${C_GREEN}OK${C_END} $*"; }
warn()  { echo -e "${C_YELLOW}WARN${C_END} $*"; }
err()   { echo -e "${C_RED}ERR${C_END} $*" >&2; }
dim()   { echo -e "${C_DIM}$*${C_END}"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { err "missing binary: $1"; exit 1; }
}

PYTHON_MIN_VERSION="3.11"

python_version_at_least() {
  local py="$1"
  "$py" - "$PYTHON_MIN_VERSION" <<'PY' >/dev/null 2>&1
import sys

required = tuple(int(part) for part in sys.argv[1].split("."))
raise SystemExit(0 if sys.version_info[: len(required)] >= required else 1)
PY
}

python_version_label() {
  local py="$1"
  "$py" - <<'PY' 2>/dev/null || printf 'unknown'
import sys

print(".".join(str(part) for part in sys.version_info[:3]))
PY
}

select_python_bin() {
  local candidate
  for candidate in "${SINGULARITY_PYTHON:-}" python3.12 python3.11 python3; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    if python_version_at_least "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  local found="not found"
  if command -v python3 >/dev/null 2>&1; then
    found="$(python_version_label python3)"
  fi
  err "bare-metal runtime requires Python >= ${PYTHON_MIN_VERSION}; found python3 ${found}."
  err "Install Python 3.11+ or run with SINGULARITY_PYTHON=/path/to/python3.11."
  exit 1
}

RUNTIME_PORT_SPECS=(
  "8001:llm-gateway"
  "7100:mcp-server"
)

free_port_specs() {
  local scope="$1"; shift || true
  local spec port label pids pid cmd
  command -v lsof >/dev/null 2>&1 || { warn "lsof not found; cannot free $scope ports"; return 0; }
  for spec in "$@"; do
    [ -n "$spec" ] || continue
    port="${spec%%:*}"
    label="${spec#*:}"
    pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$pids" ] || continue
    for pid in $pids; do
      cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "?")
      case "$cmd" in
        *docker*|*Docker*|*vpnkit*)
          warn "port $port ($label) is Docker-owned (pid $pid); leaving it alone"
          continue
          ;;
      esac
      dim "  freeing $label on :$port (pid $pid, $cmd)"
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
        warn "force-killed $label on :$port (pid $pid)"
      fi
    done
  done
}

load_laptop_env() {
  if [ -f "$ROOT/.env.laptop" ]; then
    while IFS='=' read -r key value; do
      case "$key" in ''|\#*) continue ;; esac
      [ -z "${!key:-}" ] && export "$key=$value"
    done < "$ROOT/.env.laptop"
  fi
}

config_value() {
  local dotted="$1" fallback="$2"
  local py="${SINGULARITY_PYTHON_BIN:-python3}"
  "$py" - "$dotted" "$fallback" <<'PY'
import json
import sys
from pathlib import Path

dotted, fallback = sys.argv[1], sys.argv[2]
try:
    data = json.loads(Path(".singularity/config.local.json").read_text())
except Exception:
    data = {}
cur = data
for part in dotted.split("."):
    if not isinstance(cur, dict) or part not in cur:
        print(fallback)
        raise SystemExit
    cur = cur[part]
if cur is True:
    print("true")
elif cur is False:
    print("false")
else:
    print(cur if cur not in (None, "") else fallback)
PY
}

load_platform_env() {
  load_laptop_env
  if [ -f "$ENV_FILE" ]; then
    set +u
    # shellcheck source=/dev/null
    . "$ENV_FILE"
    set -u
  fi

  export MCP_SERVER_URL="${MCP_SERVER_URL:-http://localhost:7100}"
  export RUNTIME_BRIDGE_URL="${RUNTIME_BRIDGE_URL:-${LAPTOP_BRIDGE_URL:-ws://localhost:8000/api/runtime-bridge/connect}}"
  export LAPTOP_BRIDGE_URL="$RUNTIME_BRIDGE_URL"
  export RUNTIME_HTTP_FALLBACK_ENABLED="${RUNTIME_HTTP_FALLBACK_ENABLED:-false}"
  export MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-$(config_value mcpRuntime.bearerToken demo-bearer-token-must-be-min-16-chars)}"
  export MCP_DEFAULT_GOVERNANCE_MODE="${MCP_DEFAULT_GOVERNANCE_MODE:-$(config_value mcpRuntime.defaultGovernanceMode fail_open)}"
  export MCP_TOOL_GRANT_MODE="${MCP_TOOL_GRANT_MODE:-$(config_value mcpRuntime.toolGrantMode off)}"
  export MCP_REQUIRE_EFFECTIVE_CAPABILITIES="${MCP_REQUIRE_EFFECTIVE_CAPABILITIES:-$(config_value mcpRuntime.requireEffectiveCapabilities false)}"
  export TOOL_GRANT_SIGNING_SECRET="${TOOL_GRANT_SIGNING_SECRET:-$(config_value mcpRuntime.toolGrantSigningSecret dev-tool-grant-signing-secret-min-32-chars!!)}"
  export IAM_BASE_URL="${IAM_BASE_URL:-http://localhost:8100/api/v1}"
  export LOCAL_SUPER_ADMIN_EMAIL="${LOCAL_SUPER_ADMIN_EMAIL:-$(config_value identity.bootstrapEmail admin@singularity.local)}"
  export LOCAL_SUPER_ADMIN_PASSWORD="${LOCAL_SUPER_ADMIN_PASSWORD:-$(config_value identity.bootstrapPassword Admin1234!)}"

  export LLM_GATEWAY_URL="${LLM_GATEWAY_URL:-http://localhost:8001}"
  export LLM_PROVIDER_CONFIG_PATH="${LLM_PROVIDER_CONFIG_PATH:-$ROOT/.singularity/llm-providers.json}"
  export LLM_MODEL_CATALOG_PATH="${LLM_MODEL_CATALOG_PATH:-$ROOT/.singularity/llm-models.json}"

  export AUDIT_GOV_URL="${AUDIT_GOV_URL:-http://localhost:8500}"
  export AUDIT_GOV_SERVICE_TOKEN="${AUDIT_GOV_SERVICE_TOKEN:-$(config_value tokens.auditGovServiceToken dev-audit-gov-service-token)}"
  export CONTEXT_FABRIC_SERVICE_TOKEN="${CONTEXT_FABRIC_SERVICE_TOKEN:-$(config_value tokens.contextFabricServiceToken dev-context-fabric-service-token)}"
  export PROMPT_COMPOSER_SERVICE_TOKEN="${PROMPT_COMPOSER_SERVICE_TOKEN:-${WORKGRAPH_PROXY_SERVICE_TOKEN:-}}"
  export LEARNING_SERVICE_TOKEN="${LEARNING_SERVICE_TOKEN:-$AUDIT_GOV_SERVICE_TOKEN}"

}

ensure_provider_configs() {
  mkdir -p "$ROOT/.singularity"
  [ -f "$LLM_PROVIDER_CONFIG_PATH" ] || cp "$ROOT/.singularity/llm-providers.json.default" "$LLM_PROVIDER_CONFIG_PATH" 2>/dev/null || true
  [ -f "$LLM_MODEL_CATALOG_PATH" ] || cp "$ROOT/.singularity/llm-models.json.default" "$LLM_MODEL_CATALOG_PATH" 2>/dev/null || true

  if [ ! -f "$LLM_PROVIDER_CONFIG_PATH" ] || [ ! -f "$LLM_MODEL_CATALOG_PATH" ]; then
    warn "LLM provider/model config missing under .singularity; llm-gateway may fail to start."
  fi
}

ensure_python_runtime() {
  local venv="$ROOT/.venv"
  local pybin="${SINGULARITY_PYTHON_BIN:-$(select_python_bin)}"
  if [ -x "$venv/bin/python" ] && ! python_version_at_least "$venv/bin/python"; then
    warn ".venv uses Python $(python_version_label "$venv/bin/python"), below ${PYTHON_MIN_VERSION}; recreating it."
    rm -rf "$venv"
  fi
  if [ ! -x "$venv/bin/python" ]; then
    info "creating python venv at .venv with $(python_version_label "$pybin")..."
    "$pybin" -m venv "$venv" || { err "venv create failed at $venv (need Python ${PYTHON_MIN_VERSION}+ with venv support)"; exit 1; }
  fi
  if ! python_version_at_least "$venv/bin/python"; then
    err ".venv is using Python $(python_version_label "$venv/bin/python"); expected >= ${PYTHON_MIN_VERSION}."
    err "Remove .venv or set SINGULARITY_PYTHON=/path/to/python3.11 and retry."
    exit 1
  fi
  export VIRTUAL_ENV="$venv"
  export PATH="$venv/bin:$PATH"
  hash -r 2>/dev/null || true
  if ! "$venv/bin/python" -c "import fastapi, uvicorn, httpx, pydantic, pydantic_settings" 2>/dev/null; then
    info "installing llm-gateway python deps into .venv..."
    "$venv/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
    "$venv/bin/python" -m pip install --quiet -r context-fabric/services/llm_gateway_service/requirements.txt
  fi
}

ensure_node_runtime() {
  if [ ! -d "$ROOT/mcp-server/node_modules" ]; then
    info "installing mcp-server npm deps..."
    ( cd "$ROOT/mcp-server" && npm install >/dev/null 2>&1 )
  fi
}

free_ports() {
  free_port_specs "bare-metal runtime" "${RUNTIME_PORT_SPECS[@]}"
}

boot() {
  local name="$1"; shift
  local cmd="$*"
  mkdir -p "$LOG_DIR"
  ( bash -c "$cmd" >> "$LOG_DIR/${name}.log" 2>&1 & printf '%s %s\n' "$name" "$!" >> "$PID_FILE" )
  sleep 0.3
  local pid
  pid=$(tail -n 1 "$PID_FILE" | awk '{print $2}')
  ok "${name} (PID ${pid})  -> tail -f logs/${name}.log"
}

http_code() {
  local url="$1" timeout="${2:-3}" code
  if command -v curl >/dev/null 2>&1; then
    code=$(curl -s -o /dev/null -w "%{http_code}" "$url" --max-time "$timeout" 2>/dev/null || true)
  else
    code=$(python3 - "$url" "$timeout" <<'PY' 2>/dev/null || true
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
try:
    res = urlopen(Request(sys.argv[1]), timeout=float(sys.argv[2]))
    print(res.status)
except HTTPError as exc:
    print(exc.code)
except (OSError, URLError, TimeoutError):
    print("000")
PY
)
  fi
  printf '%s' "${code:-000}"
}

runtime_token_is_fresh() {
  local token="$1"
  [ -n "$token" ] || return 1
  TOKEN="$token" "${SINGULARITY_PYTHON_BIN:-python3}" - <<'PY' >/dev/null 2>&1
import base64
import json
import os
import time

token = os.environ.get("TOKEN", "")
try:
    payload_b64 = token.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode()).decode())
except Exception:
    raise SystemExit(1)
if payload.get("kind") not in {"runtime", "device"}:
    raise SystemExit(1)
exp = payload.get("exp")
if exp is not None and float(exp) <= time.time() + 300:
    raise SystemExit(1)
raise SystemExit(0)
PY
}

load_runtime_token() {
  local token source
  if [ -n "${SINGULARITY_RUNTIME_TOKEN:-}" ]; then
    token="$SINGULARITY_RUNTIME_TOKEN"
    source="SINGULARITY_RUNTIME_TOKEN"
  elif [ -n "${SINGULARITY_DEVICE_TOKEN:-}" ]; then
    token="$SINGULARITY_DEVICE_TOKEN"
    source="SINGULARITY_DEVICE_TOKEN"
  elif [ -s "$DEVICE_TOKEN_FILE" ]; then
    token="$(tr -d '\n' < "$DEVICE_TOKEN_FILE")"
    source="$DEVICE_TOKEN_FILE"
  else
    return 1
  fi
  if runtime_token_is_fresh "$token"; then
    export SINGULARITY_RUNTIME_TOKEN="$token"
    export SINGULARITY_DEVICE_TOKEN="$token"
    ok "runtime bridge token loaded from $source"
    return 0
  fi
  warn "runtime bridge token from $source is missing, expired, or invalid"
  if [ "$source" = "$DEVICE_TOKEN_FILE" ]; then
    rm -f "$DEVICE_TOKEN_FILE"
  else
    unset SINGULARITY_RUNTIME_TOKEN SINGULARITY_DEVICE_TOKEN
  fi
  return 1
}

mint_runtime_token_via_iam() {
  case "${SINGULARITY_AUTO_MINT_RUNTIME_TOKEN:-true}" in
    0|false|FALSE|no|NO) return 1 ;;
  esac
  local iam_base="${IAM_BASE_URL:-http://localhost:8100/api/v1}"
  local email="${SINGULARITY_RUNTIME_USER_EMAIL:-${LOCAL_SUPER_ADMIN_EMAIL:-admin@singularity.local}}"
  local password="${SINGULARITY_RUNTIME_USER_PASSWORD:-${LOCAL_SUPER_ADMIN_PASSWORD:-Admin1234!}}"
  local runtime_id="${SINGULARITY_RUNTIME_ID:-baremetal-mcp-runtime}"
  local runtime_name="${SINGULARITY_RUNTIME_NAME:-bare-metal-mcp-runtime}"
  local code
  code=$(http_code "${iam_base%/}/health" 3)
  if [ "$code" != "200" ] && [ "$code" != "204" ]; then
    warn "IAM is not ready at ${iam_base%/}/health; cannot auto-mint runtime bridge token"
    return 1
  fi
  mkdir -p "$(dirname "$DEVICE_TOKEN_FILE")"
  IAM_BASE_URL="${iam_base%/}" \
  RUNTIME_TOKEN_EMAIL="$email" \
  RUNTIME_TOKEN_PASSWORD="$password" \
  RUNTIME_TOKEN_FILE="$DEVICE_TOKEN_FILE" \
  RUNTIME_ID="$runtime_id" \
  RUNTIME_NAME="$runtime_name" \
  RUNTIME_TENANT_ID="${SINGULARITY_TENANT_ID:-}" \
  RUNTIME_SCOPE="${SINGULARITY_RUNTIME_SCOPE:-user}" \
  RUNTIME_CAPABILITY_TAGS="${SINGULARITY_RUNTIME_CAPABILITY_TAGS:-mcp,tools,llm}" \
  "${SINGULARITY_PYTHON_BIN:-python3}" - <<'PY'
import json
import os
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path

base = os.environ["IAM_BASE_URL"].rstrip("/")
email = os.environ["RUNTIME_TOKEN_EMAIL"]
password = os.environ["RUNTIME_TOKEN_PASSWORD"]
token_file = Path(os.environ["RUNTIME_TOKEN_FILE"])
capability_tags = [item.strip() for item in os.environ.get("RUNTIME_CAPABILITY_TAGS", "").split(",") if item.strip()]

def post_json(path: str, payload: dict, bearer: str | None = None) -> dict:
    headers = {"content-type": "application/json"}
    if bearer:
        headers["authorization"] = f"Bearer {bearer}"
    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:500]
        print(f"IAM {path} failed with HTTP {exc.code}: {detail}", file=sys.stderr)
        raise SystemExit(1)
    except Exception as exc:
        print(f"IAM {path} failed: {exc}", file=sys.stderr)
        raise SystemExit(1)

login = post_json("/auth/local/login", {"email": email, "password": password})
admin_token = login.get("access_token")
if not admin_token:
    print("IAM login did not return an access_token", file=sys.stderr)
    raise SystemExit(1)

payload = {
    "device_id": os.environ["RUNTIME_ID"],
    "device_name": os.environ["RUNTIME_NAME"],
    "token_kind": "runtime",
    "runtime_type": "mcp",
    "runtime_scope": os.environ.get("RUNTIME_SCOPE") or "user",
    "allowed_frame_types": ["tool-run", "model-run", "code-context", "source-tree", "source-file", "invoke"],
    "capability_tags": capability_tags or ["mcp", "tools", "llm"],
    "ttl_days": 90,
}
tenant_id = os.environ.get("RUNTIME_TENANT_ID", "").strip()
if tenant_id:
    payload["tenant_id"] = tenant_id

minted = post_json("/auth/device-token", payload, admin_token)
runtime_token = minted.get("access_token")
if not runtime_token:
    print("IAM device-token mint did not return an access_token", file=sys.stderr)
    raise SystemExit(1)
token_file.write_text(runtime_token + "\n")
token_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
print(f"minted runtime JWT for user_id={minted.get('user_id')} runtime_id={minted.get('device_id')} -> {token_file}")
PY
}

ensure_runtime_token() {
  load_runtime_token && return 0
  if mint_runtime_token_via_iam; then
    load_runtime_token && return 0
  fi
  warn "no runtime bridge token available; MCP will start in direct HTTP debug mode unless you set SINGULARITY_RUNTIME_TOKEN"
  return 1
}

cmd_up() {
  require node
  require npm
  local python_bin
  python_bin="$(select_python_bin)"
  export SINGULARITY_PYTHON_BIN="$python_bin"
  info "using Python $(python_version_label "$python_bin") for bare-metal runtime"

  info "freeing runtime ports..."
  free_ports
  : > "$PID_FILE"

  load_platform_env
  ensure_runtime_token || true
  ensure_provider_configs
  ensure_python_runtime
  ensure_node_runtime

  info "booting runtime infrastructure..."
  boot llm-gateway "cd context-fabric && LLM_PROVIDER_CONFIG_PATH=\"$LLM_PROVIDER_CONFIG_PATH\" LLM_MODEL_CATALOG_PATH=\"$LLM_MODEL_CATALOG_PATH\" ALLOW_CALLER_PROVIDER_OVERRIDE=false python3 -m uvicorn services.llm_gateway_service.app.main:app --host 0.0.0.0 --port 8001"

  local mcp_workspace="${SINGULARITY_MCP_WORKSPACE:-$HOME/.singularity/mcp-workspace}"
  mkdir -p "$mcp_workspace"
  local mcp_common
  mcp_common="cd mcp-server && PORT=7100 MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" MCP_DEFAULT_GOVERNANCE_MODE=\"$MCP_DEFAULT_GOVERNANCE_MODE\" MCP_TOOL_GRANT_MODE=\"$MCP_TOOL_GRANT_MODE\" MCP_REQUIRE_EFFECTIVE_CAPABILITIES=\"$MCP_REQUIRE_EFFECTIVE_CAPABILITIES\" TOOL_GRANT_SIGNING_SECRET=\"$TOOL_GRANT_SIGNING_SECRET\" LLM_GATEWAY_URL=\"$LLM_GATEWAY_URL\" MCP_COMMAND_EXECUTION_MODE=process MCP_SANDBOX_ROOT=\"$mcp_workspace\" MCP_LLM_PROVIDER_CONFIG_PATH=\"$LLM_PROVIDER_CONFIG_PATH\" MCP_LLM_MODEL_CATALOG_PATH=\"$LLM_MODEL_CATALOG_PATH\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" AUDIT_GOV_SERVICE_TOKEN=\"$AUDIT_GOV_SERVICE_TOKEN\" LEARNING_SERVICE_TOKEN=\"$LEARNING_SERVICE_TOKEN\" CONTEXT_FABRIC_SERVICE_TOKEN=\"$CONTEXT_FABRIC_SERVICE_TOKEN\" PROMPT_COMPOSER_SERVICE_TOKEN=\"$PROMPT_COMPOSER_SERVICE_TOKEN\" ${COPILOT_PROVIDER_TYPE:+COPILOT_PROVIDER_TYPE=\"$COPILOT_PROVIDER_TYPE\" }${COPILOT_PROVIDER_BASE_URL:+COPILOT_PROVIDER_BASE_URL=\"$COPILOT_PROVIDER_BASE_URL\" }${COPILOT_PROVIDER_API_KEY:+COPILOT_PROVIDER_API_KEY=\"$COPILOT_PROVIDER_API_KEY\" }${COPILOT_MODEL:+COPILOT_MODEL=\"$COPILOT_MODEL\" }${MCP_GIT_PUSH_ENABLED:+MCP_GIT_PUSH_ENABLED=\"$MCP_GIT_PUSH_ENABLED\" }${MCP_GIT_AUTH_MODE:+MCP_GIT_AUTH_MODE=\"$MCP_GIT_AUTH_MODE\" }${GITHUB_TOKEN:+GITHUB_TOKEN=\"$GITHUB_TOKEN\" }${GH_TOKEN:+GH_TOKEN=\"$GH_TOKEN\" }"

  if [ -n "${SINGULARITY_RUNTIME_TOKEN:-}" ]; then
    info "MCP runtime will dial into Context Fabric: $RUNTIME_BRIDGE_URL"
    boot mcp-server "$mcp_common RUNTIME_DIAL_IN_MODE=true LAPTOP_MODE=true RUNTIME_BRIDGE_URL=\"$RUNTIME_BRIDGE_URL\" LAPTOP_BRIDGE_URL=\"$RUNTIME_BRIDGE_URL\" SINGULARITY_RUNTIME_TOKEN=\"$SINGULARITY_RUNTIME_TOKEN\" SINGULARITY_DEVICE_TOKEN=\"$SINGULARITY_RUNTIME_TOKEN\" SINGULARITY_RUNTIME_ID=\"${SINGULARITY_RUNTIME_ID:-baremetal-mcp-runtime}\" SINGULARITY_DEVICE_ID=\"${SINGULARITY_RUNTIME_ID:-baremetal-mcp-runtime}\" SINGULARITY_RUNTIME_NAME=\"${SINGULARITY_RUNTIME_NAME:-bare-metal-mcp-runtime}\" SINGULARITY_DEVICE_NAME=\"${SINGULARITY_RUNTIME_NAME:-bare-metal-mcp-runtime}\" SINGULARITY_RUNTIME_TYPE=mcp SINGULARITY_TENANT_ID=\"${SINGULARITY_TENANT_ID:-}\" SINGULARITY_USER_ID=\"${SINGULARITY_USER_ID:-}\" SINGULARITY_RUNTIME_CAPABILITY_TAGS=\"${SINGULARITY_RUNTIME_CAPABILITY_TAGS:-mcp,tools,llm}\" npm run dev"
  else
    warn "SINGULARITY_RUNTIME_TOKEN is not set; starting MCP in direct HTTP debug mode on :7100."
    warn "Context Fabric will use this only when RUNTIME_HTTP_FALLBACK_ENABLED=true."
    boot mcp-server "$mcp_common npm run dev"
  fi

  echo
  ok "runtime infrastructure booted"
  echo "    http://localhost:8001/health  (LLM Gateway)"
  if [ -n "${SINGULARITY_RUNTIME_TOKEN:-}" ]; then
    echo "    $RUNTIME_BRIDGE_URL  (MCP runtime dial-in)"
  else
    echo "    http://localhost:7100/health  (MCP/tool runtime debug HTTP)"
  fi
  echo
  dim "stop runtime only: $0 down"
}

cmd_down() {
  if [ -f "$PID_FILE" ]; then
    info "stopping runtime infrastructure..."
    while read -r name pid; do
      [ -z "${pid:-}" ] && continue
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && dim "  killed $name ($pid)"
      fi
    done < "$PID_FILE"
  else
    warn "no $PID_FILE found - sweeping runtime ports only"
  fi
  free_ports
  rm -f "$PID_FILE"
  ok "runtime infrastructure down."
}

cmd_smoke() {
  local fail=0
  load_platform_env
  load_runtime_token >/dev/null 2>&1 || true
  for url in "http://localhost:8001/health"; do
    code=$(http_code "$url" 3)
    if [ "$code" = "200" ] || [ "$code" = "304" ]; then
      printf "  ${C_GREEN}%s${C_END}  %s\n" "$code" "$url"
    else
      printf "  ${C_RED}%s${C_END}  %s\n" "$code" "$url"
      fail=$((fail + 1))
    fi
  done
  if [ -z "${SINGULARITY_RUNTIME_TOKEN:-}" ]; then
    url="http://localhost:7100/health"
    code=$(http_code "$url" 3)
    if [ "$code" = "200" ] || [ "$code" = "304" ]; then
      printf "  ${C_GREEN}%s${C_END}  %s\n" "$code" "$url"
    else
      printf "  ${C_RED}%s${C_END}  %s\n" "$code" "$url"
      fail=$((fail + 1))
    fi
  else
    dim "  MCP runtime is in dial-in mode; verify from Context Fabric /api/runtime-bridge/status."
  fi
  [ "$fail" = "0" ] || { err "$fail runtime endpoint(s) failing - check logs/"; exit 1; }
  ok "runtime infrastructure healthy."
}

cmd_status() {
  if [ ! -f "$PID_FILE" ]; then
    warn "no runtime PIDs recorded; run '$0 up'"
    return 0
  fi
  printf "%-18s %-8s %s\n" "SERVICE" "PID" "STATE"
  while read -r name pid; do
    [ -z "${pid:-}" ] && continue
    if kill -0 "$pid" 2>/dev/null; then state="${C_GREEN}running${C_END}"; else state="${C_RED}exited${C_END}"; fi
    printf "%-18s %-8s %b\n" "$name" "$pid" "$state"
  done < "$PID_FILE"
}

cmd_logs() {
  local svc="${1:?usage: $0 logs <llm-gateway|mcp-server>}"
  tail -f "$LOG_DIR/${svc}.log"
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  up)     cmd_up "$@" ;;
  down)   cmd_down ;;
  smoke)  cmd_smoke ;;
  status) cmd_status ;;
  logs)   cmd_logs "$@" ;;
  help|-h|--help)
    cat <<USAGE
Singularity bare-metal runtime-infra launcher.

  $0 up                 boot only llm-gateway and mcp-server
  $0 smoke              check runtime health endpoints
  $0 status             list runtime PIDs
  $0 logs <service>     tail llm-gateway or mcp-server logs
  $0 down               stop runtime PIDs + free :8001 and :7100

Start platform apps separately:
  bin/bare-metal-apps.sh up <db_user> [db_password] [db_host] [db_port]
USAGE
    ;;
  *)
    err "unknown command: $cmd"
    echo "Run '$0 help' for usage."
    exit 1
    ;;
esac
