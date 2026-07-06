#!/usr/bin/env bash
# Bare-metal launcher — runs the Singularity demo path against a single
# Postgres instance, no Docker.
#
# Usage:
#   bin/bare-metal.sh up   <db_user> [db_password] [db_host] [db_port]
#   bin/bare-metal.sh down
#   bin/bare-metal.sh smoke
#   bin/bare-metal.sh status
#   bin/bare-metal.sh logs <service>
#
# Defaults (when args/env unset):
#   db_password : value of $PGPASSWORD env, else 'postgres'
#   db_host     : 'localhost'
#   db_port     : '5432'
#
# Compatibility launcher. Prefer bin/bare-metal-apps.sh for platform apps
# without MCP/LLM, and bin/bare-metal-runtime.sh for local llm-gateway +
# mcp-server. This script still supports the older all-in-one path: it boots
# iam, audit-gov, agent/tool/runtime/composer, context-api, workgraph-api, the
# unified platform-web Next app on :5180, and, unless SKIP_LOCAL_RUNTIME=1,
# local llm-gateway + mcp-server. BOX_ONLY=1 remains a legacy alias for
# office/laptop-bridge installs. Deprecated/optional sidecars such as
# context-memory and formal-verifier are opt-in (BARE_METAL_FULL=1, or
# FORMAL_VERIFICATION_ENABLED=true for the verifier).
# Set BARE_METAL_TRACE_SPINE=1 with `smoke` to run the Docker/split-DB trace
# evidence gate after endpoint health checks.
# Skips on purpose: metrics-ledger (M65: sunset in the singularity stack —
# savings analytics moved to audit-gov :8500), MinIO, and legacy split UI apps.
#
# Context Fabric stores run on Postgres (DB: singularity_context_fabric) to
# match the Docker stack — see CONTEXT_FABRIC_DATABASE_URL below. The legacy
# SQLite fallback under context-fabric/data/ is no longer used by this script.

set -e

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
PID_FILE="$ROOT/.pids"
ENV_FILE="$ROOT/.env.local"
DEVICE_TOKEN_FILE="${DEVICE_TOKEN_FILE:-$ROOT/.singularity/laptop-device-token}"
# Per-checkout runtime id (see ensure_runtime_id). A FIXED shared id makes every
# stack register to the same CF-bridge slot (user, id) and evict each other.
RUNTIME_ID_FILE="${RUNTIME_ID_FILE:-$ROOT/.singularity/runtime-id}"

# Laptop secrets (.env.laptop — Copilot BYOK key/model, GITHUB_TOKEN, git push
# flags). Same file bin/laptop.sh and the desktop app read, so a bare-metal `up`
# needs no per-shell exports. Shell-exported values still win (file only fills
# in what's unset).
if [ -f "$ROOT/.env.laptop" ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in ''|\#*) continue ;; esac
    [ -z "${!_k:-}" ] && export "$_k=$_v"
  done < "$ROOT/.env.laptop"
fi

# ── Colours + helpers ──────────────────────────────────────────────────────
C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m';  C_DIM=$'\033[2m';      C_END=$'\033[0m'
info()  { echo -e "${C_BLUE}▸${C_END} $*"; }
ok()    { echo -e "${C_GREEN}✓${C_END} $*"; }
warn()  { echo -e "${C_YELLOW}⚠${C_END} $*"; }
err()   { echo -e "${C_RED}✗${C_END} $*" >&2; }
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
  err "bare-metal requires Python >= ${PYTHON_MIN_VERSION}; found python3 ${found}."
  err "Install Python 3.11+ or run with SINGULARITY_PYTHON=/path/to/python3.11."
  exit 1
}

ensure_python_venv() {
  local venv="$1"
  local pybin="$2"
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
}

normalize_runtime_mode() {
  # SKIP_LOCAL_RUNTIME=1 skips only the local llm-gateway + mcp-server. BOX_ONLY
  # is the legacy office/cloud alias. Runtime traffic now goes through the
  # Runtime Bridge by default; direct HTTP fallback must be enabled explicitly.
  [ "${BOX_ONLY:-}" = "1" ] || BOX_ONLY=""
  [ "${SKIP_LOCAL_RUNTIME:-}" = "1" ] || SKIP_LOCAL_RUNTIME=""
  if [ -n "$BOX_ONLY" ]; then
    SKIP_LOCAL_RUNTIME=1
  fi
  export BOX_ONLY SKIP_LOCAL_RUNTIME
}

validate_sql_ident() {
  case "$1" in
    ""|*[!A-Za-z0-9_]*|[0-9]*)
      err "invalid SQL identifier for $2: '$1'"
      exit 1
      ;;
  esac
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

wait_http() {
  local name="$1"
  local url="$2"
  local tries="${3:-30}"
  local code
  for _ in $(seq 1 "$tries"); do
    code=$(http_code "$url" 2)
    if [ "$code" = "200" ] || [ "$code" = "204" ]; then
      ok "$name is ready"
      return 0
    fi
    sleep 1
  done
  err "$name did not become ready at $url"
  return 1
}

BARE_METAL_APP_PORT_SPECS=(
  "3001:agent-service"
  "3003:agent-runtime"
  "3004:prompt-composer"
  "5180:platform-web"
  "8000:context-api"
  "8080:workgraph-api"
  "8100:iam-service"
  "8500:audit-governance"
)
BARE_METAL_OPTIONAL_PORT_SPECS=(
  "8002:context-memory"
  "8010:formal-verifier"
  "8011:prompt-compressor"
  "8003:legacy-metrics-ledger"
  "8101:legacy-pseudo-iam"
)
BARE_METAL_LEGACY_UI_PORT_SPECS=(
  "5174:legacy-agent-web"
  "5175:legacy-workgraph-web"
  "5176:legacy-blueprint-workbench"
  "5181:legacy-edge-gateway"
  "5182:legacy-portal"
  "8085:legacy-user-and-capability"
)
BARE_METAL_RUNTIME_PORT_SPECS=(
  "8001:llm-gateway"
  "7100:mcp-server"
)

free_port_specs() {
  local scope="$1"; shift || true
  local spec port label pids pid cmd target
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
      target="$(repo_owned_process_root "$pid")"
      dim "  freeing $label on :$port (pid $pid, $cmd; root $target)"
      kill_process_tree "$target" "$label on :$port"
    done
  done
}

repo_owned_process_root() {
  local pid="$1" parent cmd
  while :; do
    parent=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)
    [ -n "$parent" ] && [ "$parent" != "0" ] && [ "$parent" != "1" ] || break
    cmd=$(ps -p "$parent" -o command= 2>/dev/null || true)
    case "$cmd" in
      *"$ROOT"*) pid="$parent" ;;
      *) break ;;
    esac
  done
  printf '%s' "$pid"
}

kill_process_tree() {
  local pid="$1" label="${2:-process}" child
  [ -n "$pid" ] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_process_tree "$child" "$label"
  done
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    warn "force-killed $label (pid $pid)"
  fi
}

free_stale_platform_web_legacy_port() {
  local port=3000
  local pids pid cmd full_cmd cwd
  [ "${SINGULARITY_FREE_STALE_PLATFORM_WEB_PORT:-1}" != "0" ] || return 0
  command -v lsof >/dev/null 2>&1 || return 0
  pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    cmd=$(ps -p "$pid" -o comm= 2>/dev/null || echo "?")
    case "$cmd" in
      *docker*|*Docker*|*vpnkit*)
        warn "port $port (legacy platform-web Next dev) is Docker-owned (pid $pid); leaving it alone"
        continue
        ;;
    esac
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)
    full_cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$cwd:$full_cmd" in
      "$ROOT/agent-and-tools/web:"*|"$ROOT/agent-and-tools/web/"*|*"$ROOT/agent-and-tools/web"*)
        dim "  freeing stale platform-web Next dev listener on :$port (pid $pid, $cmd)"
        kill "$pid" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.2
        done
        if kill -0 "$pid" 2>/dev/null; then
          kill -9 "$pid" 2>/dev/null || true
          warn "force-killed stale platform-web Next dev listener on :$port (pid $pid)"
        fi
        ;;
      *)
        warn "port $port is in use by pid $pid ($cmd) but is not this repo's Platform Web; leaving it alone"
        ;;
    esac
  done
}

clean_platform_web_cache() {
  local web_dir="$ROOT/agent-and-tools/web"
  local pids pid cwd full_cmd in_use=0
  if [ ! -d "$web_dir" ]; then
    warn "platform-web directory not found at $web_dir"
    return 0
  fi
  if [ "${SINGULARITY_FORCE_CLEAN_WEB_CACHE:-0}" != "1" ] && command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:5180 -sTCP:LISTEN 2>/dev/null || true)"
    [ -n "$pids" ] && in_use=1
    for pid in $(lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null || true); do
      cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)
      full_cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
      case "$cwd:$full_cmd" in
        "$web_dir:"*|"$web_dir/"*|*"$web_dir"*) in_use=1 ;;
      esac
    done
    if [ "$in_use" = "1" ]; then
      warn "platform-web may be running; stop it before cleaning cache: bin/bare-metal-apps.sh down"
      warn "override only if needed: SINGULARITY_FORCE_CLEAN_WEB_CACHE=1 $0 clean-web-cache"
      return 1
    fi
  fi
  rm -rf "$web_dir/.next"
  ok "platform-web Next cache cleared → agent-and-tools/web/.next"
}

platform_web_cache_error_hint() {
  local log_file="$1"
  [ -s "$log_file" ] || return 0
  if grep -E "vendor-chunks|Cannot find module.*\\.next|_buildManifest|_ssgManifest|react-loadable-manifest" "$log_file" >/dev/null 2>&1; then
    warn "platform-web log looks like a stale Next cache/chunk mismatch."
    warn "fix: bin/bare-metal-apps.sh down && bin/bare-metal.sh clean-web-cache && bin/bare-metal-apps.sh up"
  fi
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

platform_web_service_token_is_fresh() {
  local token="$1"
  [ -n "$token" ] || return 1
  TOKEN="$token" "${SINGULARITY_PYTHON_BIN:-python3}" - <<'PY' >/dev/null 2>&1
import base64
import json
import os
import time

required_scopes = {"read:reference-data", "read:mcp-servers", "publish:events"}
token = os.environ.get("TOKEN", "")
try:
    payload_b64 = token.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode()).decode())
except Exception:
    raise SystemExit(1)
if payload.get("kind") != "service" or payload.get("service_name") != "platform-web" or payload.get("sub") != "service:platform-web":
    raise SystemExit(1)
if not required_scopes.issubset(set(payload.get("scopes") or [])):
    raise SystemExit(1)
exp = payload.get("exp")
if exp is not None and float(exp) <= time.time() + 300:
    raise SystemExit(1)
raise SystemExit(0)
PY
}

set_env_export() {
  local key="$1" value="$2" tmp
  [ -f "$ENV_FILE" ] || return 0
  tmp="${ENV_FILE}.tmp.$$"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^export " key "=" {
      print "export " key "=\"" value "\""
      done = 1
      next
    }
    { print }
    END {
      if (!done) print "export " key "=\"" value "\""
    }
  ' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

mint_platform_web_service_token_via_iam() {
  case "${SINGULARITY_AUTO_MINT_PLATFORM_WEB_TOKEN:-true}" in
    0|false|FALSE|no|NO) return 1 ;;
  esac
  local iam_base="${IAM_BASE_URL:-http://localhost:8100/api/v1}"
  local email="${LOCAL_SUPER_ADMIN_EMAIL:-admin@singularity.local}"
  local password="${LOCAL_SUPER_ADMIN_PASSWORD:-Admin1234!}"
  local code token
  code=$(http_code "${iam_base%/}/health" 3)
  if [ "$code" != "200" ] && [ "$code" != "204" ]; then
    warn "IAM is not ready at ${iam_base%/}/health; cannot auto-mint platform-web service token"
    return 1
  fi
  token=$(IAM_BASE_URL="${iam_base%/}" \
    PLATFORM_WEB_TOKEN_EMAIL="$email" \
    PLATFORM_WEB_TOKEN_PASSWORD="$password" \
    PLATFORM_WEB_TOKEN_TENANT_IDS="${IAM_SERVICE_TOKEN_TENANT_IDS:-}" \
    "${SINGULARITY_PYTHON_BIN:-python3}" - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

base = os.environ["IAM_BASE_URL"].rstrip("/")
email = os.environ["PLATFORM_WEB_TOKEN_EMAIL"]
password = os.environ["PLATFORM_WEB_TOKEN_PASSWORD"]
tenant_ids = [item.strip() for item in os.environ.get("PLATFORM_WEB_TOKEN_TENANT_IDS", "").split(",") if item.strip()]

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

minted = post_json(
    "/auth/service-token",
    {
        "service_name": "platform-web",
        "scopes": ["read:reference-data", "read:mcp-servers", "publish:events"],
        "tenant_ids": tenant_ids,
        "ttl_hours": 24 * 90,
    },
    admin_token,
)
service_token = minted.get("access_token")
if not service_token:
    print("IAM service-token mint did not return an access_token", file=sys.stderr)
    raise SystemExit(1)
print(service_token)
PY
) || return 1
  [ -n "$token" ] || return 1
  export WORKGRAPH_PROXY_SERVICE_TOKEN="$token"
  export PROMPT_COMPOSER_SERVICE_TOKEN="${PROMPT_COMPOSER_SERVICE_TOKEN:-$token}"
  set_env_export WORKGRAPH_PROXY_SERVICE_TOKEN "$WORKGRAPH_PROXY_SERVICE_TOKEN"
  set_env_export PROMPT_COMPOSER_SERVICE_TOKEN "$PROMPT_COMPOSER_SERVICE_TOKEN"
  ok "platform-web service token minted through IAM (redacted) → .env.local"
}

ensure_platform_web_service_token() {
  if platform_web_service_token_is_fresh "${WORKGRAPH_PROXY_SERVICE_TOKEN:-}"; then
    export PROMPT_COMPOSER_SERVICE_TOKEN="${PROMPT_COMPOSER_SERVICE_TOKEN:-$WORKGRAPH_PROXY_SERVICE_TOKEN}"
    set_env_export WORKGRAPH_PROXY_SERVICE_TOKEN "$WORKGRAPH_PROXY_SERVICE_TOKEN"
    set_env_export PROMPT_COMPOSER_SERVICE_TOKEN "$PROMPT_COMPOSER_SERVICE_TOKEN"
    ok "platform-web service token loaded (redacted)"
    return 0
  fi
  if mint_platform_web_service_token_via_iam; then
    return 0
  fi
  warn "platform-web service token was not minted; Workgraph/Composer server-side proxy calls may require manual WORKGRAPH_PROXY_SERVICE_TOKEN"
  return 1
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

# Decode a runtime JWT's runtime_id claim (read-only; no signature check). Token
# is passed via env (not argv) to keep it out of `ps`. Empty on parse failure.
_runtime_token_claim_id() {
  RT_TOK="$1" python3 -c '
import base64, json, os
tok = os.environ.get("RT_TOK", "")
try:
    p = tok.split(".")[1]; p += "=" * (-len(p) % 4)
    c = json.loads(base64.urlsafe_b64decode(p))
    print(c.get("runtime_id") or c.get("device_id") or "")
except Exception:
    pass
' 2>/dev/null
}

# Resolve a STABLE, UNIQUE-per-stack runtime id and export it before the token is
# minted + the runtime is booted. The old fixed default ("baremetal-mcp-runtime")
# made every concurrent stack/checkout register to the same CF-bridge slot
# (user, id), so they evicted each other in a "replaced" loop and tool/model
# dispatch broke. An explicit SINGULARITY_RUNTIME_ID still wins; otherwise we
# persist a per-checkout id in .singularity/runtime-id (stable across restarts).
ensure_runtime_id() {
  if [ -z "${SINGULARITY_RUNTIME_ID:-}" ]; then
    if [ -s "$RUNTIME_ID_FILE" ]; then
      SINGULARITY_RUNTIME_ID="$(tr -d '\n' < "$RUNTIME_ID_FILE")"
    else
      local gen
      gen="$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]')"
      [ -n "$gen" ] || gen="$(printf '%s' "$ROOT" | shasum -a 256 2>/dev/null | cut -c1-12)"
      SINGULARITY_RUNTIME_ID="bm-mcp-${gen:-$$}"
      mkdir -p "$(dirname "$RUNTIME_ID_FILE")"
      printf '%s' "$SINGULARITY_RUNTIME_ID" > "$RUNTIME_ID_FILE"
      info "minted unique runtime id $SINGULARITY_RUNTIME_ID (persisted to $RUNTIME_ID_FILE)"
    fi
  fi
  export SINGULARITY_RUNTIME_ID

  # CF-bridge identity is TOKEN-authoritative. A cached token minted for a
  # DIFFERENT runtime_id (e.g. the old shared "baremetal-mcp-runtime") would make
  # this stack register under THAT id and collide ("replaced" storm) regardless
  # of the id above — load_runtime_token only checks freshness, not the claim.
  # Drop a mismatched cached token so ensure_runtime_token re-mints with our id.
  if [ -s "$DEVICE_TOKEN_FILE" ]; then
    local claimed
    claimed="$(_runtime_token_claim_id "$(tr -d '\n' < "$DEVICE_TOKEN_FILE")")"
    if [ -n "$claimed" ] && [ "$claimed" != "$SINGULARITY_RUNTIME_ID" ]; then
      warn "cached runtime token is for runtime_id '$claimed' but this stack is '$SINGULARITY_RUNTIME_ID' — re-minting"
      rm -f "$DEVICE_TOKEN_FILE"
      unset SINGULARITY_RUNTIME_TOKEN SINGULARITY_DEVICE_TOKEN
    fi
  fi
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
    "allowed_frame_types": ["tool-run", "model-run", "code-context", "source-tree", "source-file", "work-finish-branch", "worktree-write-file", "invoke"],
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

# ── Subcommands ────────────────────────────────────────────────────────────

cmd_up() {
  local db_user="${1:?usage: $0 up <db_user> [db_password] [db_host] [db_port]}"
  local db_pass="${2:-${PGPASSWORD:-postgres}}"
  local db_host="${3:-localhost}"
  local db_port="${4:-5432}"
  local python_bin
  normalize_runtime_mode

  require psql
  require node
  require npm
  python_bin="$(select_python_bin)"
  export SINGULARITY_PYTHON_BIN="$python_bin"
  info "using Python $(python_version_label "$python_bin") for bare-metal services"
  command -v pnpm >/dev/null 2>&1 || warn "pnpm not found — workgraph install will fail; install with 'npm i -g pnpm'"

  # ── 0. Free our app ports FIRST ──────────────────────────────────────────
  # Kill any stale listeners on our service ports (a prior 'up' not 'down'ed, a
  # duplicate/Docker stack, or a hung dev server) so nothing later fails with
  # EADDRINUSE — and so killing services releases their DB connections before we
  # touch the databases. Storage ports (5432/5434/9000/9001) are EXCLUDED on
  # purpose: those are your Postgres/MinIO, not ours to kill.
  info "freeing our service ports…"
  local _ports_to_free=(
    "${BARE_METAL_APP_PORT_SPECS[@]}"
    "${BARE_METAL_OPTIONAL_PORT_SPECS[@]}"
  )
  if [ "${SINGULARITY_FREE_LEGACY_PORTS:-1}" != "0" ]; then
    _ports_to_free+=("${BARE_METAL_LEGACY_UI_PORT_SPECS[@]}")
  fi
  if [ "${SKIP_LOCAL_RUNTIME:-}" != "1" ]; then
    _ports_to_free+=("${BARE_METAL_RUNTIME_PORT_SPECS[@]}")
  fi
  free_port_specs "bare-metal" "${_ports_to_free[@]}"
  # Older Platform Web package scripts ignored PORT=5180 and launched Next on
  # :3000. Clear only that repo-owned stale listener; do not treat :3000 as a
  # normal Singularity app port.
  free_stale_platform_web_legacy_port

  info "using Postgres at ${db_user}@${db_host}:${db_port}"
  WORKGRAPH_APP_DB_USER="${WORKGRAPH_APP_DB_USER:-workgraph_app}"
  WORKGRAPH_APP_DB_PASSWORD="${WORKGRAPH_APP_DB_PASSWORD:-workgraph_app_secret}"
  validate_sql_ident "$db_user" "db_user"
  validate_sql_ident "$WORKGRAPH_APP_DB_USER" "WORKGRAPH_APP_DB_USER"
  case "$WORKGRAPH_APP_DB_PASSWORD" in
    *"'"*)
      err "WORKGRAPH_APP_DB_PASSWORD cannot contain a single quote"
      exit 1
      ;;
  esac

  # ── 1. Create databases + extensions ────────────────────────────────────
  info "creating databases (idempotent)…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d postgres <<SQL 2>&1 | grep -vE "already exists|NOTICE" || true
SELECT 'CREATE DATABASE singularity'          WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='singularity')\gexec
SELECT 'CREATE DATABASE singularity_composer' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='singularity_composer')\gexec
SELECT 'CREATE DATABASE workgraph'            WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='workgraph')\gexec
SELECT 'CREATE DATABASE audit_governance'     WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='audit_governance')\gexec
SELECT 'CREATE DATABASE singularity_iam'      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='singularity_iam')\gexec
SELECT 'CREATE DATABASE singularity_context_fabric' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='singularity_context_fabric')\gexec
SQL

  info "enabling pgvector + pgcrypto in 'singularity' (agent-runtime + tool-service)…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d singularity \
    -c "CREATE EXTENSION IF NOT EXISTS vector;" \
    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>&1 | grep -vE "NOTICE" || \
    { err "Failed to install pgvector. Install it on your Postgres (e.g. 'brew install pgvector') and retry."; exit 1; }

  # M30 — prompt-composer's own DB. Decoupled from agent-runtime so
  # cross-service prisma db push fights are structurally impossible.
  info "enabling pgvector + pgcrypto in 'singularity_composer' (prompt-composer)…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d singularity_composer \
    -c "CREATE EXTENSION IF NOT EXISTS vector;" \
    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>&1 | grep -vE "NOTICE" || \
    { err "Failed to install pgvector on singularity_composer."; exit 1; }

  # Context Fabric shared DB — context-memory stores pgvector embeddings; the
  # context-api call_log/events_store + memory + (legacy) metrics stores live
  # here too. Matches the Docker stack's CONTEXT_FABRIC_DATABASE_URL target.
  info "enabling pgvector + pgcrypto in 'singularity_context_fabric' (context-fabric stores)…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d singularity_context_fabric \
    -c "CREATE EXTENSION IF NOT EXISTS vector;" \
    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>&1 | grep -vE "NOTICE" || \
    { err "Failed to install pgvector on singularity_context_fabric."; exit 1; }

  info "enabling pgcrypto in 'singularity_iam'…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d singularity_iam \
    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>&1 | grep -vE "NOTICE" || true

  info "enabling pgcrypto in 'audit_governance'…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d audit_governance \
    -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" 2>&1 | grep -vE "NOTICE" || true

  info "applying audit-governance schema…"
  PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d audit_governance \
    -f audit-governance-service/db/init.sql >/dev/null 2>&1 || \
    warn "audit_governance schema may already exist — continuing"
  # init.sql is the base table set; the migrations/ add columns it doesn't include
  # (e.g. m63 adds audit_events.risk_level + search_vector — without it the audit
  # search 500s with "column risk_level does not exist"). All idempotent; ordered.
  for _m in audit-governance-service/db/migrations/*.sql; do
    [ -f "$_m" ] || continue
    PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d audit_governance \
      -f "$_m" >/dev/null 2>&1 || warn "audit-gov migration $(basename "$_m") may already be applied — continuing"
  done

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

  # ── Phase 3: auto-provision shared service secrets ────────────────────────
  # CONTEXT_FABRIC_SERVICE_TOKEN / AUDIT_GOV_SERVICE_TOKEN / MCP_BEARER_TOKEN /
  # WORKGRAPH_INTERNAL_TOKEN are opaque service bearers (string-equality checks);
  # TOOL_GRANT_SIGNING_SECRET is an HMAC secret — all are SHARED symmetric
  # secrets (not IAM-minted JWTs), so every issuer/verifier must hold the
  # IDENTICAL value. Instead of weak hand-set dev defaults that silently break a
  # path on mismatch, resolve each once and persist it to .env.local, reusing it
  # on later boots. Precedence: explicit env > singularity config > persisted
  # .env.local > generated. LEARNING_SERVICE_TOKEN follows AUDIT_GOV below.
  # NOT touched here: JWT_SECRET (root signing key — rotating it would invalidate
  # live sessions + the laptop device token), the IAM-minted platform-web
  # WORKGRAPH_PROXY/PROMPT_COMPOSER tokens (minted via IAM separately).
  # WORKGRAPH_INCOMING_EVENT_SECRETS (per-caller HMAC map) is generated below.
  _rand_secret() { openssl rand -hex "${1:-32}" 2>/dev/null || LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c "$(( ${1:-32} * 2 ))"; }
  _persisted_env() {
    [ -f "$ENV_FILE" ] || return 0
    sed -n "s/^export $1=\"\\(.*\\)\"\$/\\1/p" "$ENV_FILE" | tail -1 || true
  }
  _is_weak_secret() { case "$1" in ""|dev-*|changeme*|demo-*) return 0 ;; *) return 1 ;; esac; }
  provision_secret() { # <VAR> <config_key> <bytes>
    local var="$1" cfg="$2" bytes="${3:-32}" cur
    eval "cur=\"\${$var:-}\""
    _is_weak_secret "$cur" && cur="$(config_value "$cfg" "")"
    _is_weak_secret "$cur" && cur="$(_persisted_env "$var")"
    if _is_weak_secret "$cur"; then cur="$(_rand_secret "$bytes")"; ok "generated $var (redacted) → .env.local"; fi
    export "$var=$cur"
  }
  provision_secret WORKGRAPH_INTERNAL_TOKEN      tokens.workgraphInternalToken      32
  provision_secret CONTEXT_FABRIC_SERVICE_TOKEN  tokens.contextFabricServiceToken   32
  provision_secret AUDIT_GOV_SERVICE_TOKEN       tokens.auditGovServiceToken        32
  provision_secret MCP_BEARER_TOKEN              mcpRuntime.bearerToken             24
  provision_secret TOOL_GRANT_SIGNING_SECRET     mcpRuntime.toolGrantSigningSecret  32
  provision_secret WORKGRAPH_INCOMING_EVENT_SECRET tokens.workgraphIncomingEventSecret 32
  # Per-caller HMAC map (verified by workgraph-api) shares the one generated
  # secret above — an operator may pin a full JSON map via config instead. The
  # plain secret persists double-quoted and the map single-quoted, so both
  # round-trip .env.local cleanly (the old double-quoted map corrupted on source).
  if [ -z "${WORKGRAPH_INCOMING_EVENT_SECRETS:-}" ]; then
    _wg_map_cfg="$(config_value tokens.workgraphIncomingEventSecrets "")"
    case "$_wg_map_cfg" in
      *'"'*) export WORKGRAPH_INCOMING_EVENT_SECRETS="$_wg_map_cfg" ;;
      *) _wg_s="$WORKGRAPH_INCOMING_EVENT_SECRET"
         export WORKGRAPH_INCOMING_EVENT_SECRETS="{\"agent-runtime\":\"$_wg_s\",\"agent-service\":\"$_wg_s\",\"tool-service\":\"$_wg_s\",\"iam\":\"$_wg_s\"}" ;;
    esac
  fi

  # ── 2. Write env file ────────────────────────────────────────────────────
  cat > "$ENV_FILE" <<EOF
# Auto-generated by bin/bare-metal.sh — re-run 'up' to refresh.
export PG_HOST="$db_host"
export PG_PORT="$db_port"
export PG_USER="$db_user"
export PG_PASS="$db_pass"

export DATABASE_URL_AGENT_TOOLS="postgresql://${db_user}:${db_pass}@${db_host}:${db_port}/singularity"
# M30 — composer owns this DB; agent-runtime data is read via DATABASE_URL_RUNTIME_READ (= AGENT_TOOLS)
export DATABASE_URL_COMPOSER="postgresql://${db_user}:${db_pass}@${db_host}:${db_port}/singularity_composer"
export DATABASE_URL_RUNTIME_READ="\$DATABASE_URL_AGENT_TOOLS"
export DATABASE_URL_WORKGRAPH_ADMIN="postgresql://${db_user}:${db_pass}@${db_host}:${db_port}/workgraph"
export DATABASE_URL_WORKGRAPH_RUNTIME="postgresql://${WORKGRAPH_APP_DB_USER}:${WORKGRAPH_APP_DB_PASSWORD}@${db_host}:${db_port}/workgraph"
export DATABASE_URL_WORKGRAPH="\$DATABASE_URL_WORKGRAPH_RUNTIME"
export DATABASE_URL_AUDIT_GOV="postgresql://${db_user}:${db_pass}@${db_host}:${db_port}/audit_governance"
# Context Fabric stores (call_log, events_store, context_memory) — Postgres,
# matching the Docker stack. The CF services read CONTEXT_FABRIC_DATABASE_URL.
export DATABASE_URL_CONTEXT_FABRIC="postgresql://${db_user}:${db_pass}@${db_host}:${db_port}/singularity_context_fabric"
export CONTEXT_FABRIC_DATABASE_URL="\$DATABASE_URL_CONTEXT_FABRIC"
# Pin EACH CF store to Postgres explicitly (highest precedence in
# resolve_database_target). This guarantees the services never fall back to
# SQLite during bare-metal runs. Belt-and-suspenders alongside the per-boot
# CONTEXT_FABRIC_DATABASE_URL, and it also covers manual runs that source
# .env.local.
export CALL_LOG_DATABASE_URL="\$DATABASE_URL_CONTEXT_FABRIC"
export EVENTS_STORE_DATABASE_URL="\$DATABASE_URL_CONTEXT_FABRIC"
export CONTEXT_MEMORY_DATABASE_URL="\$DATABASE_URL_CONTEXT_FABRIC"
export METRICS_LEDGER_DATABASE_URL="\$DATABASE_URL_CONTEXT_FABRIC"

# Respect an operator-provided secret (office/cloud!); dev default matches
# docker-compose + IAM + the laptop bridge so dev pairing verifies everywhere.
export JWT_SECRET="${JWT_SECRET:-$(config_value identity.jwtSecret changeme_dev_only_min_32_chars_long!!)}"
export LOCAL_SUPER_ADMIN_EMAIL="${LOCAL_SUPER_ADMIN_EMAIL:-$(config_value identity.bootstrapEmail admin@singularity.local)}"
export LOCAL_SUPER_ADMIN_PASSWORD="${LOCAL_SUPER_ADMIN_PASSWORD:-$(config_value identity.bootstrapPassword Admin1234!)}"
export WORKGRAPH_INTERNAL_TOKEN="${WORKGRAPH_INTERNAL_TOKEN:-$(config_value tokens.workgraphInternalToken dev-workgraph-internal-token)}"
export WORKGRAPH_INCOMING_EVENT_SECRET="${WORKGRAPH_INCOMING_EVENT_SECRET}"
export WORKGRAPH_INCOMING_EVENT_SECRETS='${WORKGRAPH_INCOMING_EVENT_SECRETS}'
export CONTEXT_FABRIC_SERVICE_TOKEN="${CONTEXT_FABRIC_SERVICE_TOKEN:-$(config_value tokens.contextFabricServiceToken dev-context-fabric-service-token)}"
export IAM_SERVICE_TOKEN_TENANT_IDS="${IAM_SERVICE_TOKEN_TENANT_IDS:-$(config_value tokens.iamServiceTokenTenantIds "")}"
export WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS="${WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS:-$(config_value tokens.workgraphInternalTokenTenantIds "")}"
export WORKGRAPH_PROXY_SERVICE_TOKEN="${WORKGRAPH_PROXY_SERVICE_TOKEN:-$(config_value platform.workgraphProxyServiceToken "")}"
export PROMPT_COMPOSER_SERVICE_TOKEN="\${PROMPT_COMPOSER_SERVICE_TOKEN:-\$WORKGRAPH_PROXY_SERVICE_TOKEN}"
export AUDIT_GOV_SERVICE_TOKEN="${AUDIT_GOV_SERVICE_TOKEN:-$(config_value tokens.auditGovServiceToken dev-audit-gov-service-token)}"
export LEARNING_SERVICE_TOKEN="\${LEARNING_SERVICE_TOKEN:-\$AUDIT_GOV_SERVICE_TOKEN}"
export APP_ENV="${APP_ENV:-${SINGULARITY_ENV:-development}}"
export ENVIRONMENT="${ENVIRONMENT:-${SINGULARITY_ENV:-${APP_ENV:-development}}}"
export SINGULARITY_ENV="${SINGULARITY_ENV:-${APP_ENV:-development}}"
export AUTH_OPTIONAL="${AUTH_OPTIONAL:-$(config_value platform.authOptional true)}"
export REQUIRE_TENANT_ID="${REQUIRE_TENANT_ID:-$(config_value platform.requireTenantId false)}"
export TENANT_ISOLATION_MODE="${TENANT_ISOLATION_MODE:-$(config_value platform.tenantIsolationMode off)}"
export PROVIDER_MANIFEST_SIGNATURE_MODE="${PROVIDER_MANIFEST_SIGNATURE_MODE:-$(config_value agentRuntime.providerManifestSignatureMode auto)}"
export PROVIDER_MANIFEST_TRUSTED_KEYS="${PROVIDER_MANIFEST_TRUSTED_KEYS:-$(config_value agentRuntime.providerManifestTrustedKeys "")}"
export PROVIDER_MANIFEST_MAX_TTL_SECONDS="${PROVIDER_MANIFEST_MAX_TTL_SECONDS:-$(config_value agentRuntime.providerManifestMaxTtlSeconds 2592000)}"
export AGENT_SOURCE_ALLOW_PRIVATE_URLS="${AGENT_SOURCE_ALLOW_PRIVATE_URLS:-$(config_value agentRuntime.allowPrivateSourceUrls false)}"
export DEFAULT_GOVERNANCE_MODE="${DEFAULT_GOVERNANCE_MODE:-$(config_value contextFabric.defaultGovernanceMode fail_open)}"
export WORKGRAPH_FORCE_GOVERNED_CODING="${WORKGRAPH_FORCE_GOVERNED_CODING:-$(config_value workgraph.forceGovernedCoding true)}"
export CONTEXT_FABRIC_GOVERN_SIDE_CALLERS="${CONTEXT_FABRIC_GOVERN_SIDE_CALLERS:-$(config_value workgraph.governSideCallers true)}"
export CF_TOOL_GRANT_ENABLED="${CF_TOOL_GRANT_ENABLED:-$(config_value contextFabric.toolGrantEnabled false)}"
export TOOL_SERVER_ENDPOINT_ALLOWLIST="${TOOL_SERVER_ENDPOINT_ALLOWLIST:-$(config_value toolService.serverEndpointAllowlist "")}"
[ "${BARE_METAL_FULL:-}" = "1" ] || BARE_METAL_FULL=""
export AUTH_PROVIDER="iam"
export IAM_BASE_URL="http://localhost:8100/api/v1"
export IAM_SERVICE_URL="http://localhost:8100"

export AUDIT_GOV_URL="http://localhost:8500"
export PROMPT_COMPOSER_URL="http://localhost:3004"
export AGENT_RUNTIME_URL="http://localhost:3003"
# No OTEL collector on a bare-metal dev stack. The node services' otel.ts defaults
# the exporter endpoint to host.docker.internal:4318 and the OTLP/DNS export error
# is UNCAUGHT — which crashes agent-service on ts-node-dev respawn (so code changes
# silently don't take effect). Disable OTEL here unless the operator opts in.
export OTEL_DISABLED="${OTEL_DISABLED:-1}"
# Phase 4 — tool-service merged into agent-service; both resolve to :3001.
export TOOL_SERVICE_URL="http://localhost:3001"
export AGENT_SERVICE_URL="http://localhost:3001"
export CONTEXT_FABRIC_URL="http://localhost:8000"
export CONTEXT_MEMORY_URL="http://localhost:8002"
export FORMAL_VERIFIER_URL="http://localhost:8010"
export RUNTIME_BRIDGE_URL="${RUNTIME_BRIDGE_URL:-${LAPTOP_BRIDGE_URL:-ws://localhost:8000/api/runtime-bridge/connect}}"
export LAPTOP_BRIDGE_URL="\$RUNTIME_BRIDGE_URL"
export RUNTIME_HTTP_FALLBACK_ENABLED="${RUNTIME_HTTP_FALLBACK_ENABLED:-false}"
export MCP_SERVER_URL="${MCP_SERVER_URL:-http://localhost:7100}"
export MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-$(config_value mcpRuntime.bearerToken demo-bearer-token-must-be-min-16-chars)}"
export MCP_DEFAULT_GOVERNANCE_MODE="${MCP_DEFAULT_GOVERNANCE_MODE:-$(config_value mcpRuntime.defaultGovernanceMode fail_open)}"
export MCP_TOOL_GRANT_MODE="${MCP_TOOL_GRANT_MODE:-$(config_value mcpRuntime.toolGrantMode off)}"
export MCP_REQUIRE_EFFECTIVE_CAPABILITIES="${MCP_REQUIRE_EFFECTIVE_CAPABILITIES:-$(config_value mcpRuntime.requireEffectiveCapabilities false)}"
export TOOL_GRANT_SIGNING_SECRET="${TOOL_GRANT_SIGNING_SECRET:-$(config_value mcpRuntime.toolGrantSigningSecret dev-tool-grant-signing-secret-min-32-chars!!)}"

export LLM_GATEWAY_URL="${LLM_GATEWAY_URL:-http://localhost:8001}"
export LLM_PROVIDER_CONFIG_PATH="$ROOT/.singularity/llm-providers.json"
export LLM_MODEL_CATALOG_PATH="$ROOT/.singularity/llm-models.json"
export WORKBENCH_DEFAULT_MODEL_ALIAS="mock"
EOF

# Fresh-clone restore: the LIVE provider/model configs are gitignored (operator-
# owned) — recreate them from the tracked .default templates so the gateway can
# boot on a brand-new checkout instead of failing with a missing config file.
[ -f "$ROOT/.singularity/llm-providers.json" ] || cp "$ROOT/.singularity/llm-providers.json.default" "$ROOT/.singularity/llm-providers.json" 2>/dev/null || true
[ -f "$ROOT/.singularity/llm-models.json" ]    || cp "$ROOT/.singularity/llm-models.json.default"    "$ROOT/.singularity/llm-models.json"    2>/dev/null || true
  ok "wrote env to ${ENV_FILE}"
  # shellcheck source=/dev/null
  . "$ENV_FILE"

  # ── Python venv (PEP 668 / Homebrew-safe) ─────────────────────────────────
  # Modern Python (Homebrew/3.12+) marks the system env "externally managed",
  # so a system-wide `pip install` is refused. Create a repo-local .venv and
  # put it first on PATH so every python3/uvicorn below resolves to it. Deps
  # are PINNED where fresh resolution otherwise pulls versions the platform
  # never tested against:
  #   • greenlet            — async SQLAlchemy needs it; not auto-pulled on new Pythons
  #   • bcrypt==4.0.1       — passlib 1.7.x breaks on bcrypt 4.1+/5.x ("72 bytes")
  #   • sqlalchemy[asyncio] — pulls greenlet on supported Pythons
  VENV="$ROOT/.venv"
  ensure_python_venv "$VENV" "$python_bin"
  export VIRTUAL_ENV="$VENV"; export PATH="$VENV/bin:$PATH"; hash -r 2>/dev/null || true
  if ! "$VENV/bin/python" -c "import fastapi, uvicorn, psycopg, asyncpg, greenlet, bcrypt, z3" 2>/dev/null; then
    info "installing python deps into .venv (iam + context-fabric)…"
    "$VENV/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
    "$VENV/bin/python" -m pip install --quiet -e singularity-iam-service \
      || { err "iam-service editable install failed under Python $(python_version_label "$VENV/bin/python")."; exit 1; }
    # z3-solver: formal-verifier imports `z3`. Without it that service crashes.
    "$VENV/bin/python" -m pip install --quiet \
        fastapi "uvicorn[standard]" httpx pydantic pydantic-settings "python-jose[cryptography]" \
        "sqlalchemy[asyncio]" greenlet aiosqlite "psycopg[binary]" pyjwt "bcrypt==4.0.1" passlib email-validator z3-solver \
      || warn "context-fabric pip install had warnings — context services may not start"
  fi

  mkdir -p "$ROOT/.singularity"
  if [ ! -f "$ROOT/.singularity/llm-providers.json" ]; then
    cat > "$ROOT/.singularity/llm-providers.json" <<'JSON'
{
  "defaultProvider": "mock",
  "defaultModel": "mock-fast",
  "allowedProviders": ["mock"],
  "providers": {
    "mock": {
      "enabled": true,
      "defaultModel": "mock-fast",
      "supportsTools": false,
      "costTier": "mock"
    }
  }
}
JSON
  fi
  if [ ! -f "$ROOT/.singularity/llm-models.json" ]; then
    cat > "$ROOT/.singularity/llm-models.json" <<'JSON'
[
  {
    "id": "mock",
    "label": "Mock offline",
    "provider": "mock",
    "model": "mock-fast",
    "default": true,
    "maxOutputTokens": 800,
    "supportsTools": false,
    "costTier": "mock"
  },
  {
    "id": "mock-fast",
    "label": "Mock — fast happy path",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  },
  {
    "id": "mock-fail-429",
    "label": "Mock chaos — 429 rate-limited",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  },
  {
    "id": "mock-fail-503",
    "label": "Mock chaos — 503 unavailable",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  },
  {
    "id": "mock-fail-529",
    "label": "Mock chaos — 529 overloaded",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  },
  {
    "id": "mock-fail-529-2",
    "label": "Mock chaos — first 2 calls 529 then happy",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  },
  {
    "id": "mock-timeout",
    "label": "Mock chaos — sleep past UPSTREAM_TIMEOUT_SEC",
    "provider": "mock",
    "model": "mock-fast",
    "default": false,
    "maxOutputTokens": 4000,
    "supportsTools": true,
    "costTier": "free"
  }
]
JSON
  fi

  # ── 3. Install dependencies (only if missing) ────────────────────────────
  ensure_install() {
    local dir="$1"
    local mgr="${2:-npm}"
    if [ ! -d "$dir/node_modules" ]; then
      info "installing $dir via $mgr…"
      ( cd "$dir" && $mgr install >/dev/null 2>&1 ) || { err "$mgr install failed in $dir"; exit 1; }
    fi
  }
  ensure_install agent-and-tools          npm
  ensure_install agent-and-tools/web      npm
  ensure_install workgraph-studio         pnpm
  ensure_install audit-governance-service npm
  if [ -z "$SKIP_LOCAL_RUNTIME" ]; then
    ensure_install mcp-server             npm
  fi

  # Build the agent-and-tools workspace libraries (@agentandtools/shared, db,
  # tool-registry). The apps import them by their package "main" (dist/index.js),
  # so they MUST be compiled before `npm run dev`, or agent/tool/composer/web all
  # crash with: Cannot find module .../@agentandtools/shared/dist/index.js.
  if [ ! -f agent-and-tools/packages/shared/dist/index.js ]; then
    info "building agent-and-tools workspace libraries…"
    ( cd agent-and-tools && npm run build --if-present \
        --workspace=packages/shared --workspace=packages/db --workspace=packages/tool-registry >/dev/null 2>&1 ) \
      || warn "agent-and-tools library build had warnings — agent/tool/composer services may not start"
  fi

  agent_runtime_hardening_migrations=(
    "20260702160000_capability_learning_status"
    "20260703120000_capability_active_identity_unique"
    "20260703123000_capability_knowledge_source_identity"
    "20260703124500_capability_source_identity"
    "20260703130000_capability_code_symbol_identity"
    "20260703131500_agent_capability_binding_identity"
    "20260703133000_agent_template_active_identity"
    "20260703134500_capability_learning_candidate_identity"
    "20260703140000_agent_skill_active_identity"
    "20260703141000_agent_skill_source_identity"
    "20260703142000_agent_template_skill_source_identity"
    "20260703143000_capability_code_embedding_identity"
    "20260704110000_capability_learning_worker_lock"
    "20260704113000_capability_archive_reconcile"
  )

  # ── 4. Push schemas + seed ────────────────────────────────────────────────
  info "applying agent-runtime schema…"
  ( cd agent-and-tools/apps/agent-runtime \
    && DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" npx prisma db push --skip-generate >/dev/null 2>&1 ) \
    || warn "agent-runtime schema push had warnings"
  # Generate the Prisma client INDEPENDENTLY of the db push above. `prisma
  # generate` needs no database; chaining it after db push with && meant a push
  # failure silently skipped generate, leaving the service with no client — it
  # then crashes at boot with "Cannot find module '../../generated/prisma-client'".
  # A generate failure is fatal to the service, so make it loud (err, not warn).
  ( cd agent-and-tools/apps/agent-runtime \
    && DISABLE_ERD=true DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" npx prisma generate >/dev/null 2>&1 ) \
    || err "agent-runtime 'prisma generate' FAILED — the service will NOT boot. Fix: (cd agent-and-tools/apps/agent-runtime && DISABLE_ERD=true npx prisma generate)"

  # Prisma db push cannot express partial unique indexes, reconciliation
  # updates, or idempotent operational cleanup. Apply those raw SQL migrations
  # explicitly so bare-metal setup gets the same hardening invariants as a
  # migrated database without requiring a full migration baseline reset.
  info "applying agent-runtime hardening migrations…"
  for migration_name in "${agent_runtime_hardening_migrations[@]}"; do
    psql "$DATABASE_URL_AGENT_TOOLS" -v ON_ERROR_STOP=1 -q \
      -f "agent-and-tools/apps/agent-runtime/prisma/migrations/${migration_name}/migration.sql" >/dev/null 2>&1 \
      || warn "agent-runtime hardening migration ${migration_name} had warnings"
  done

  ( cd agent-and-tools/apps/agent-runtime \
    && psql "$DATABASE_URL_AGENT_TOOLS" -v ON_ERROR_STOP=1 -q -f prisma/post-push.sql >/dev/null 2>&1 ) \
    || warn "agent-runtime post-push SQL had warnings"

  # The folded-in tool-service routes (agent-service /api/v1/tools, executions,
  # discovery, runners) + seedCoreToolkit use a RAW `tool` schema that Prisma db
  # push does NOT create (it only covers the public.* models). Under Docker this
  # comes from packages/db/init.sql via the postgres entrypoint; on bare-metal we
  # apply it here, or tool.tools never exists and the Tools page is empty.
  # Idempotent (CREATE ... IF NOT EXISTS). agent-service also self-heals this at
  # boot (ensureToolSchema), so this is belt-and-suspenders.
  info "applying tool schema (packages/db/tool-schema.sql)…"
  psql "$DATABASE_URL_AGENT_TOOLS" -q -f agent-and-tools/packages/db/tool-schema.sql >/dev/null 2>&1 \
    || warn "tool schema may already exist — continuing"

  # Seed the common platform-baseline agent templates (one ACTIVE template per
  # role, capabilityId=NULL). Capability onboarding clones each role's agent from
  # these; without them onboarding warns "No common <ROLE> base template found"
  # and creates empty draft placeholders. Idempotent (prisma/seed.ts upserts).
  info "seeding agent-runtime baseline templates…"
  ( cd agent-and-tools/apps/agent-runtime \
    && DATABASE_URL="$DATABASE_URL_AGENT_TOOLS" npm run prisma:seed >/dev/null 2>&1 ) \
    || warn "agent-runtime prisma:seed had warnings — run it manually: (cd agent-and-tools/apps/agent-runtime && DATABASE_URL=\"$DATABASE_URL_AGENT_TOOLS\" npm run prisma:seed)"

  # M30 — composer's OWNED tables live on `singularity_composer`. Push
  # composer's schema against that DB. The runtime-reader client only needs
  # `prisma generate` (no DDL on agent-runtime's DB).
  info "applying prompt-composer schema (DB: singularity_composer)…"
  ( cd agent-and-tools/apps/prompt-composer \
    && DATABASE_URL="$DATABASE_URL_COMPOSER" npx prisma db push --schema=prisma/schema.prisma --skip-generate >/dev/null 2>&1 ) \
    || warn "prompt-composer owned schema push had warnings"
  # Generate independently of db push (see agent-runtime note above).
  ( cd agent-and-tools/apps/prompt-composer \
    && DATABASE_URL="$DATABASE_URL_COMPOSER" npx prisma generate --schema=prisma/schema.prisma >/dev/null 2>&1 ) \
    || err "prompt-composer 'prisma generate' FAILED — the service will NOT boot. Fix: (cd agent-and-tools/apps/prompt-composer && npx prisma generate --schema=prisma/schema.prisma)"

  info "seeding prompt-composer base prompt profiles…"
  ( cd agent-and-tools/apps/prompt-composer \
    && DATABASE_URL="$DATABASE_URL_COMPOSER" npm run seed >/dev/null 2>&1 ) \
    || warn "prompt-composer seed had warnings"

  info "generating composer's runtime-reader client (read-only against singularity)…"
  ( cd agent-and-tools/apps/prompt-composer \
    && DATABASE_URL_RUNTIME_READ="$DATABASE_URL_RUNTIME_READ" npx prisma generate --schema=prisma/runtime-read.prisma >/dev/null 2>&1 ) \
    || warn "prompt-composer runtime-reader generate had warnings"

  info "applying workgraph-api schema…"
  # `prisma db push` syncs the DECLARATIVE schema (tables/columns/regular indexes). Any
  # migration carrying RAW SQL db push can't model — partial indexes, RLS functions/policies
  # — must be psql-applied here too (the Docker path gets these via `prisma migrate deploy`).
  # These migration files are idempotent, so applying them after db push is safe. Add new
  # raw-SQL migrations to this list.
  ( cd workgraph-studio/apps/api \
    && DATABASE_URL="$DATABASE_URL_WORKGRAPH_ADMIN" npx prisma db push --skip-generate >/dev/null 2>&1 \
    && psql "$DATABASE_URL_WORKGRAPH_ADMIN" -v ON_ERROR_STOP=1 -q -f prisma/migrations/20260619123000_tenant_rls_policy_scaffold/migration.sql >/dev/null 2>&1 \
    && psql "$DATABASE_URL_WORKGRAPH_ADMIN" -v ON_ERROR_STOP=1 -q -f prisma/migrations/20260626120000_node_attempt_fence_and_blueprint_key/migration.sql >/dev/null 2>&1 \
    && psql "$DATABASE_URL_WORKGRAPH_ADMIN" -v ON_ERROR_STOP=1 -q -f prisma/migrations/20260701120000_add_tenant_id_to_standalone_tables/migration.sql >/dev/null 2>&1 \
    && DATABASE_URL="$DATABASE_URL_WORKGRAPH_ADMIN" npx prisma generate >/dev/null 2>&1 ) \
    || warn "workgraph schema push had warnings"

  info "provisioning Workgraph non-bypass app role…"
  PGPASSWORD="$db_pass" psql -v ON_ERROR_STOP=1 -h "$db_host" -p "$db_port" -U "$db_user" -d workgraph <<SQL >/dev/null
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${WORKGRAPH_APP_DB_USER}') THEN
    CREATE ROLE ${WORKGRAPH_APP_DB_USER} LOGIN PASSWORD '${WORKGRAPH_APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSE
    ALTER ROLE ${WORKGRAPH_APP_DB_USER} LOGIN PASSWORD '${WORKGRAPH_APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END\$\$;
GRANT CONNECT ON DATABASE workgraph TO ${WORKGRAPH_APP_DB_USER};
GRANT USAGE ON SCHEMA public TO ${WORKGRAPH_APP_DB_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${WORKGRAPH_APP_DB_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${WORKGRAPH_APP_DB_USER};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${WORKGRAPH_APP_DB_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${db_user} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${WORKGRAPH_APP_DB_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${db_user} IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${WORKGRAPH_APP_DB_USER};
ALTER DEFAULT PRIVILEGES FOR ROLE ${db_user} IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO ${WORKGRAPH_APP_DB_USER};
SQL

  # Seed workgraph demo data — agents, the SDLC + bug-fix workbench workflows,
  # sample workflows, routing policies, and a completed blueprint session with
  # artifacts (prisma/seed.ts → seed-demo-workflows.ts). Mirrors what Docker
  # seeds; without this the designer/workbench come up empty.
  info "seeding workgraph demo workflows + artifacts…"
  ( cd workgraph-studio/apps/api \
    && DATABASE_URL="$DATABASE_URL_WORKGRAPH_ADMIN" npm run prisma:seed >/dev/null 2>&1 ) \
    || warn "workgraph prisma:seed had warnings — run it manually: (cd workgraph-studio/apps/api && DATABASE_URL=\"$DATABASE_URL_WORKGRAPH_ADMIN\" npm run prisma:seed)"

  # The top-level "SDLC Delivery" workflow lives in separate self-running seeds
  # (NOT prisma/seed.ts): seed-sdlc-workbench.ts creates the "SDLC implementation
  # loop" (profile=workbench, M102 catalog artifacts), then seed-sdlc-main.ts
  # wraps it as the Main entry (START → CALL_WORKFLOW(loop) → GIT_PUSH → END) plus
  # a feature→SDLC routing policy. Seed both into the demo capability + Platform
  # Team so they appear next to the demo workflows (the workbench seed's own
  # defaults point at ids that don't exist on a fresh DB). Idempotent. Without
  # this the Workflow Manager has the demo workflows but no SDLC Delivery entry.
  info "seeding SDLC Delivery workflow…"
  # Routing for the copilot nodes: default bare-metal talks to the configured MCP
  # over HTTP (prefer_laptop=false); office/laptop-bridge installs opt in.
  SEED_PL="${SEED_PREFER_LAPTOP:-$([ "${PREFER_LAPTOP_LLM:-}" = "true" ] && echo true || echo false)}"
  ( cd workgraph-studio/apps/api \
    && SEED_CAPABILITY_ID=11111111-2222-3333-4444-555555555555 SEED_TEAM_ID=50000000-0000-0000-0000-000000000001 \
       DATABASE_URL="$DATABASE_URL_WORKGRAPH_ADMIN" npx ts-node --transpile-only prisma/seed-sdlc-workbench.ts >/dev/null 2>&1 \
    && SEED_CAPABILITY_ID=11111111-2222-3333-4444-555555555555 SEED_TEAM_ID=50000000-0000-0000-0000-000000000001 \
       DATABASE_URL="$DATABASE_URL_WORKGRAPH_ADMIN" npx ts-node --transpile-only prisma/seed-sdlc-main.ts >/dev/null 2>&1 \
    && SEED_CAPABILITY_ID=11111111-2222-3333-4444-555555555555 SEED_TEAM_ID=50000000-0000-0000-0000-000000000001 \
       SEED_PREFER_LAPTOP="$SEED_PL" SEED_GOVERNANCE_MODE="${SEED_GOVERNANCE_MODE:-fail_open}" \
       DATABASE_URL="$DATABASE_URL_WORKGRAPH_ADMIN" npx ts-node --transpile-only prisma/seed-sdlc-copilot.ts >/dev/null 2>&1 \
    && DATABASE_URL="$DATABASE_URL_WORKGRAPH_ADMIN" npx ts-node --transpile-only prisma/seed-workbench-parents.ts >/dev/null 2>&1 ) \
    || warn "SDLC Delivery seed had warnings — run manually: (cd workgraph-studio/apps/api && SEED_CAPABILITY_ID=11111111-2222-3333-4444-555555555555 SEED_TEAM_ID=50000000-0000-0000-0000-000000000001 DATABASE_URL=\"\$DATABASE_URL_WORKGRAPH_ADMIN\" npx ts-node --transpile-only prisma/seed-sdlc-workbench.ts && … seed-sdlc-main.ts)"

  # ── 5. Python deps ─────────────────────────────────────────────────────────
  # Installed into .venv above (PEP 668-safe). Verify the import surface is
  # present so a failure here is loud rather than a mid-boot crash.
  if ! "$VENV/bin/python" -c "import fastapi, uvicorn, sqlalchemy, asyncpg, greenlet, bcrypt, jwt, psycopg" 2>/dev/null; then
    warn "some python deps are missing in .venv — iam/context services may not start (re-run 'up', or pip install into .venv)"
  fi

  # ── 6. Boot ───────────────────────────────────────────────────────────────
  mkdir -p "$LOG_DIR"
  : > "$PID_FILE"

  boot() {
    local name="$1"; shift
    local cmd="$*"
    local log_file="$LOG_DIR/${name}.log"
    if command -v setsid >/dev/null 2>&1; then
      setsid bash -c "$cmd" >> "$log_file" 2>&1 < /dev/null &
    else
      nohup bash -c "$cmd" >> "$log_file" 2>&1 < /dev/null &
    fi
    echo $! >> "$PID_FILE"
    sleep 0.3
    local pid
    pid=$(tail -n 1 "$PID_FILE")
    if ! kill -0 "$pid" 2>/dev/null; then
      err "${name} exited during startup (PID ${pid})"
      if [ -s "$log_file" ]; then
        warn "last ${name} log lines:"
        tail -n 40 "$log_file" | sed 's/^/  │ /' >&2 || true
        [ "$name" = "platform-web" ] && platform_web_cache_error_hint "$log_file"
      else
        warn "${name} did not write a log before exiting"
      fi
      return 1
    fi
    ok "${name} (PID ${pid})  → tail -f logs/${name}.log"
  }
  info "booting services…"
  boot iam-service      "cd singularity-iam-service  && DATABASE_URL=\"postgresql+asyncpg://${db_user}:${db_pass}@${db_host}:${db_port}/singularity_iam\" JWT_SECRET=\"$JWT_SECRET\" JWT_EXPIRE_MINUTES=720 LOCAL_SUPER_ADMIN_EMAIL=\"$LOCAL_SUPER_ADMIN_EMAIL\" LOCAL_SUPER_ADMIN_PASSWORD=\"$LOCAL_SUPER_ADMIN_PASSWORD\" CORS_ORIGINS='[\"http://localhost:5180\"]' python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8100"
  wait_http iam-service "http://localhost:8100/api/v1/health" 45
  ensure_platform_web_service_token || true

  info "applying SQL seed data…"
  ( "$ROOT/seed/apply.sh" "$db_user" "$db_pass" "$db_host" "$db_port" >/dev/null 2>&1 ) \
    || warn "seed/apply.sh had warnings — run it manually: seed/apply.sh $db_user"

  boot audit-gov        "cd audit-governance-service  && DATABASE_URL=\"$DATABASE_URL_AUDIT_GOV\" PORT=8500 AUDIT_GOV_SERVICE_TOKEN=\"$AUDIT_GOV_SERVICE_TOKEN\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" npm run dev"
  sleep 2
  # SKIP_LOCAL_RUNTIME=1 — runtime infra is external, remote, or started by
  # bin/bare-metal-runtime.sh.
  if [ "${SKIP_LOCAL_RUNTIME:-0}" != "1" ]; then
  boot llm-gateway      "cd context-fabric && LLM_PROVIDER_CONFIG_PATH=\"$LLM_PROVIDER_CONFIG_PATH\" LLM_MODEL_CATALOG_PATH=\"$LLM_MODEL_CATALOG_PATH\" ALLOW_CALLER_PROVIDER_OVERRIDE=false python3 -m uvicorn services.llm_gateway_service.app.main:app --host 0.0.0.0 --port 8001"
  fi
  sleep 1

  # Phase 4 — tool-service merged into agent-service (one process on :3001 serving
  # both /api/v1/agents and /api/v1/tools). TOOL_SERVER_ENDPOINT_ALLOWLIST carried
  # over from the former tool-service boot.
  boot agent-service    "cd agent-and-tools/apps/agent-service   && PORT=3001 DATABASE_URL=\"$DATABASE_URL_AGENT_TOOLS\" IAM_SERVICE_URL=\"$IAM_SERVICE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" AUDIT_GOV_SERVICE_TOKEN=\"$AUDIT_GOV_SERVICE_TOKEN\" LEARNING_SERVICE_TOKEN=\"$LEARNING_SERVICE_TOKEN\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" TOOL_SERVER_ENDPOINT_ALLOWLIST=\"$TOOL_SERVER_ENDPOINT_ALLOWLIST\" JWT_SECRET=\"$JWT_SECRET\" npm run dev"
  boot agent-runtime    "cd agent-and-tools/apps/agent-runtime   && PORT=3003 DATABASE_URL=\"$DATABASE_URL_AGENT_TOOLS\" IAM_SERVICE_URL=\"$IAM_SERVICE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" AUDIT_GOV_SERVICE_TOKEN=\"$AUDIT_GOV_SERVICE_TOKEN\" CONTEXT_FABRIC_URL=\"$CONTEXT_FABRIC_URL\" CONTEXT_FABRIC_SERVICE_TOKEN=\"$CONTEXT_FABRIC_SERVICE_TOKEN\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" JWT_SECRET=\"$JWT_SECRET\" LLM_GATEWAY_URL=\"$LLM_GATEWAY_URL\" WORLD_MODEL_DISTILL_MODEL_ALIAS=\"${WORLD_MODEL_DISTILL_MODEL_ALIAS:-claude-haiku-4-5-20251001}\" npm run dev"
  boot prompt-composer  "cd agent-and-tools/apps/prompt-composer && PORT=3004 DATABASE_URL=\"$DATABASE_URL_COMPOSER\" DATABASE_URL_RUNTIME_READ=\"$DATABASE_URL_RUNTIME_READ\" CONTEXT_FABRIC_URL=\"$CONTEXT_FABRIC_URL\" CONTEXT_FABRIC_SERVICE_TOKEN=\"$CONTEXT_FABRIC_SERVICE_TOKEN\" PROMPT_COMPOSER_SERVICE_TOKEN=\"$PROMPT_COMPOSER_SERVICE_TOKEN\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" AUDIT_GOV_SERVICE_TOKEN=\"$AUDIT_GOV_SERVICE_TOKEN\" LEARNING_SERVICE_TOKEN=\"$LEARNING_SERVICE_TOKEN\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" CAPSULE_COMPILE_MODEL_ALIAS=mock JWT_SECRET=\"$JWT_SECRET\" npm run dev"

  # MCP_SANDBOX_ROOT defaults to /workspace (the Docker mount path); on bare
  # metal that dir can't be created at the FS root, so every workspace tool
  # (apply_patch, run_command, copilot_execute, …) fails with
  # "ENOENT: mkdir '/workspace'". Point it at a real local, writable dir —
  # OUTSIDE the platform repo. copilot_execute runs `copilot -p --allow-all`,
  # which with an empty/un-materialized sandbox will wander UP the tree; if the
  # sandbox sat under $ROOT it would escape into the platform repo and edit it.
  # $HOME/.singularity/mcp-workspace has no parent repo to escape into.
  local MCP_WS="${SINGULARITY_MCP_WORKSPACE:-$HOME/.singularity/mcp-workspace}"
  mkdir -p "$MCP_WS"
  # COPILOT_PROVIDER_* (BYOK): if set in your environment, forward them so the
  # Copilot CLI that copilot_execute spawns uses your own provider (e.g. Anthropic)
  # instead of the GitHub Copilot quota. Export COPILOT_PROVIDER_TYPE=anthropic,
  # COPILOT_PROVIDER_BASE_URL, COPILOT_PROVIDER_API_KEY, COPILOT_MODEL then re-run up.
  if [ "${SKIP_LOCAL_RUNTIME:-0}" != "1" ]; then
    ensure_runtime_id
    ensure_runtime_token || true
    MCP_COMMON="cd mcp-server && PORT=7100 MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" MCP_DEFAULT_GOVERNANCE_MODE=\"$MCP_DEFAULT_GOVERNANCE_MODE\" MCP_TOOL_GRANT_MODE=\"$MCP_TOOL_GRANT_MODE\" MCP_REQUIRE_EFFECTIVE_CAPABILITIES=\"$MCP_REQUIRE_EFFECTIVE_CAPABILITIES\" TOOL_GRANT_SIGNING_SECRET=\"$TOOL_GRANT_SIGNING_SECRET\" LLM_GATEWAY_URL=\"$LLM_GATEWAY_URL\" MCP_COMMAND_EXECUTION_MODE=process MCP_SANDBOX_ROOT=\"$MCP_WS\" MCP_LLM_PROVIDER_CONFIG_PATH=\"$LLM_PROVIDER_CONFIG_PATH\" MCP_LLM_MODEL_CATALOG_PATH=\"$LLM_MODEL_CATALOG_PATH\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" AUDIT_GOV_SERVICE_TOKEN=\"$AUDIT_GOV_SERVICE_TOKEN\" LEARNING_SERVICE_TOKEN=\"$LEARNING_SERVICE_TOKEN\" CONTEXT_FABRIC_SERVICE_TOKEN=\"$CONTEXT_FABRIC_SERVICE_TOKEN\" PROMPT_COMPOSER_SERVICE_TOKEN=\"$PROMPT_COMPOSER_SERVICE_TOKEN\" ${COPILOT_PROVIDER_TYPE:+COPILOT_PROVIDER_TYPE=\"$COPILOT_PROVIDER_TYPE\" }${COPILOT_PROVIDER_BASE_URL:+COPILOT_PROVIDER_BASE_URL=\"$COPILOT_PROVIDER_BASE_URL\" }${COPILOT_PROVIDER_API_KEY:+COPILOT_PROVIDER_API_KEY=\"$COPILOT_PROVIDER_API_KEY\" }${COPILOT_MODEL:+COPILOT_MODEL=\"$COPILOT_MODEL\" }${MCP_GIT_PUSH_ENABLED:+MCP_GIT_PUSH_ENABLED=\"$MCP_GIT_PUSH_ENABLED\" }${MCP_GIT_AUTH_MODE:+MCP_GIT_AUTH_MODE=\"$MCP_GIT_AUTH_MODE\" }${GITHUB_TOKEN:+GITHUB_TOKEN=\"$GITHUB_TOKEN\" }${GH_TOKEN:+GH_TOKEN=\"$GH_TOKEN\" }"
    if [ -n "${SINGULARITY_RUNTIME_TOKEN:-}" ]; then
      boot mcp-server "$MCP_COMMON RUNTIME_DIAL_IN_MODE=true LAPTOP_MODE=true RUNTIME_DIAL_IN_SERVE_HTTP=true RUNTIME_BRIDGE_URL=\"$RUNTIME_BRIDGE_URL\" LAPTOP_BRIDGE_URL=\"$RUNTIME_BRIDGE_URL\" SINGULARITY_RUNTIME_TOKEN=\"$SINGULARITY_RUNTIME_TOKEN\" SINGULARITY_DEVICE_TOKEN=\"$SINGULARITY_RUNTIME_TOKEN\" SINGULARITY_RUNTIME_ID=\"${SINGULARITY_RUNTIME_ID:-baremetal-mcp-runtime}\" SINGULARITY_DEVICE_ID=\"${SINGULARITY_RUNTIME_ID:-baremetal-mcp-runtime}\" SINGULARITY_RUNTIME_NAME=\"${SINGULARITY_RUNTIME_NAME:-bare-metal-mcp-runtime}\" SINGULARITY_DEVICE_NAME=\"${SINGULARITY_RUNTIME_NAME:-bare-metal-mcp-runtime}\" SINGULARITY_RUNTIME_TYPE=mcp SINGULARITY_TENANT_ID=\"${SINGULARITY_TENANT_ID:-}\" SINGULARITY_USER_ID=\"${SINGULARITY_USER_ID:-}\" SINGULARITY_RUNTIME_CAPABILITY_TAGS=\"${SINGULARITY_RUNTIME_CAPABILITY_TAGS:-mcp,tools,llm}\" npm run dev"
    else
      warn "SINGULARITY_RUNTIME_TOKEN is not set; MCP starts in direct HTTP debug mode. Enable RUNTIME_HTTP_FALLBACK_ENABLED=true for Context Fabric to use it."
      boot mcp-server "$MCP_COMMON npm run dev"
    fi
  fi
  # context-api / context-memory import `context_fabric_shared` (in
  # context-fabric/shared/) and the `services.` namespace — so run them from the
  # context-fabric root with shared on PYTHONPATH and a fully-qualified module
  # path, exactly like llm-gateway. (Booting from the service subdir is why they
  # were crashing with ModuleNotFoundError.)
  # JWT_SECRET: context-api verifies Runtime Bridge tokens IAM signs. Direct
  # MCP/LLM HTTP fallback is disabled unless RUNTIME_HTTP_FALLBACK_ENABLED=true.
  boot context-api      "cd context-fabric && PYTHONPATH=\"$ROOT/context-fabric/shared\" DATABASE_URL=\"$DATABASE_URL_AUDIT_GOV\" CONTEXT_FABRIC_DATABASE_URL=\"$CONTEXT_FABRIC_DATABASE_URL\" CALL_LOG_DATABASE_URL=\"$CALL_LOG_DATABASE_URL\" EVENTS_STORE_DATABASE_URL=\"$EVENTS_STORE_DATABASE_URL\" CONTEXT_MEMORY_DATABASE_URL=\"$CONTEXT_MEMORY_DATABASE_URL\" PORT=8000 IAM_BASE_URL=\"$IAM_BASE_URL\" IAM_SERVICE_TOKEN=\"$CONTEXT_FABRIC_SERVICE_TOKEN\" IAM_BOOTSTRAP_USERNAME=\"$LOCAL_SUPER_ADMIN_EMAIL\" IAM_BOOTSTRAP_PASSWORD=\"$LOCAL_SUPER_ADMIN_PASSWORD\" PROMPT_COMPOSER_SERVICE_TOKEN=\"$PROMPT_COMPOSER_SERVICE_TOKEN\" CONTEXT_FABRIC_SERVICE_TOKEN=\"$CONTEXT_FABRIC_SERVICE_TOKEN\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" CONTEXT_MEMORY_URL=\"$CONTEXT_MEMORY_URL\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" RUNTIME_HTTP_FALLBACK_ENABLED=\"$RUNTIME_HTTP_FALLBACK_ENABLED\" JWT_SECRET=\"$JWT_SECRET\" DEFAULT_GOVERNANCE_MODE=\"$DEFAULT_GOVERNANCE_MODE\" CF_TOOL_GRANT_ENABLED=\"$CF_TOOL_GRANT_ENABLED\" TOOL_GRANT_SIGNING_SECRET=\"$TOOL_GRANT_SIGNING_SECRET\" ${PREFER_LAPTOP_LLM:+PREFER_LAPTOP_LLM=\"$PREFER_LAPTOP_LLM\" }python3 -m uvicorn services.context_api_service.app.main:app --host 0.0.0.0 --port 8000"
  if [ -n "$BARE_METAL_FULL" ]; then
    boot context-memory "cd context-fabric && PYTHONPATH=\"$ROOT/context-fabric/shared\" CONTEXT_FABRIC_DATABASE_URL=\"$CONTEXT_FABRIC_DATABASE_URL\" CONTEXT_MEMORY_DATABASE_URL=\"$CONTEXT_MEMORY_DATABASE_URL\" PORT=8002 IAM_BASE_URL=\"$IAM_BASE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" python3 -m uvicorn services.context_memory_service.app.main:app --host 0.0.0.0 --port 8002"
  fi
  if [ "${FORMAL_VERIFICATION_ENABLED:-false}" = "true" ] || [ -n "$BARE_METAL_FULL" ]; then
    boot formal-verifier "cd context-fabric/services/formal_verifier_service && PORT=8010 CONTEXT_FABRIC_DATABASE_URL=\"$CONTEXT_FABRIC_DATABASE_URL\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8010"
  fi
  sleep 3

  boot workgraph-api    "cd workgraph-studio/apps/api && PORT=8080 DATABASE_URL=\"$DATABASE_URL_WORKGRAPH_RUNTIME\" WORKGRAPH_RUNTIME_DATABASE_URL=\"$DATABASE_URL_WORKGRAPH_RUNTIME\" WORKGRAPH_DATABASE_URL_ADMIN=\"$DATABASE_URL_WORKGRAPH_ADMIN\" JWT_SECRET=\"$JWT_SECRET\" AUTH_PROVIDER=iam IAM_BASE_URL=\"$IAM_BASE_URL\" AGENT_RUNTIME_URL=\"$AGENT_RUNTIME_URL\" TOOL_SERVICE_URL=\"$TOOL_SERVICE_URL\" AGENT_SERVICE_URL=\"$AGENT_SERVICE_URL\" PROMPT_COMPOSER_URL=\"$PROMPT_COMPOSER_URL\" CONTEXT_FABRIC_URL=\"$CONTEXT_FABRIC_URL\" CONTEXT_FABRIC_SERVICE_TOKEN=\"$CONTEXT_FABRIC_SERVICE_TOKEN\" CONTEXT_MEMORY_URL=\"$CONTEXT_MEMORY_URL\" FORMAL_VERIFIER_URL=\"$FORMAL_VERIFIER_URL\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" MCP_TOOL_GRANT_MODE=\"$MCP_TOOL_GRANT_MODE\" DEFAULT_GOVERNANCE_MODE=\"$DEFAULT_GOVERNANCE_MODE\" WORKGRAPH_FORCE_GOVERNED_CODING=\"$WORKGRAPH_FORCE_GOVERNED_CODING\" CONTEXT_FABRIC_GOVERN_SIDE_CALLERS=\"$CONTEXT_FABRIC_GOVERN_SIDE_CALLERS\" WORKGRAPH_INTERNAL_TOKEN=\"$WORKGRAPH_INTERNAL_TOKEN\" WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS=\"$WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS\" WORKGRAPH_INCOMING_EVENT_SECRETS=\"$WORKGRAPH_INCOMING_EVENT_SECRETS\" WORKBENCH_DEFAULT_MODEL_ALIAS=mock AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" npm run dev"
  # The unified platform web app owns every UI route on :5180. It proxies backend
  # calls through Next rewrites and keeps users in one shell:
  # /operations, /agents, /agents/studio, /workflows, /workbench, /foundry,
  # and /identity. The old split Vite apps are legacy/debug-only now.
  # Next dev and next build share .next; stale production/dev chunks there cause
  # intermittent "vendor-chunks/* not found" and React manifest errors. Bare-metal
  # always runs the dev server, so clear the cache before launch.
  clean_platform_web_cache
  boot platform-web     "cd agent-and-tools/web        && PORT=5180 IAM_BASE_URL=\"$IAM_BASE_URL\" IAM_HEALTH_URL=\"http://localhost:8100/api/v1/health\" IAM_BOOTSTRAP_USERNAME=\"$LOCAL_SUPER_ADMIN_EMAIL\" IAM_BOOTSTRAP_PASSWORD=\"$LOCAL_SUPER_ADMIN_PASSWORD\" TENANT_ISOLATION_MODE=\"$TENANT_ISOLATION_MODE\" REQUIRE_TENANT_ID=\"$REQUIRE_TENANT_ID\" IAM_SERVICE_TOKEN_TENANT_IDS=\"$IAM_SERVICE_TOKEN_TENANT_IDS\" AUDIT_GOV_URL=\"$AUDIT_GOV_URL\" AUDIT_GOV_SERVICE_TOKEN=\"$AUDIT_GOV_SERVICE_TOKEN\" MCP_SERVER_URL=\"$MCP_SERVER_URL\" MCP_BEARER_TOKEN=\"$MCP_BEARER_TOKEN\" LLM_GATEWAY_URL=\"$LLM_GATEWAY_URL\" AGENT_RUNTIME_URL=\"$AGENT_RUNTIME_URL\" TOOL_SERVICE_URL=\"$TOOL_SERVICE_URL\" AGENT_SERVICE_URL=\"$AGENT_SERVICE_URL\" PROMPT_COMPOSER_URL=\"$PROMPT_COMPOSER_URL\" PROMPT_COMPOSER_SERVICE_TOKEN=\"$PROMPT_COMPOSER_SERVICE_TOKEN\" WORKGRAPH_API_URL=\"http://localhost:8080\" WORKGRAPH_PROXY_SERVICE_AUTH=true WORKGRAPH_PROXY_SERVICE_TOKEN=\"$WORKGRAPH_PROXY_SERVICE_TOKEN\" CONTEXT_FABRIC_URL=\"$CONTEXT_FABRIC_URL\" NEXT_PUBLIC_WORKGRAPH_WEB_URL=\"/workflows\" npm run dev"

  # Append-only helper for anyone who starts the legacy/debug UIs manually.
  _ensure_kv() { # $1=file  $2=KEY=VALUE
    local f="$1" kv="$2" key="${2%%=*}"
    mkdir -p "$(dirname "$f")"; touch "$f"
    grep -q "^${key}=" "$f" 2>/dev/null || printf '%s\n' "$kv" >> "$f"
  }
  _set_kv() { # $1=file  $2=KEY=VALUE
    local f="$1" kv="$2" key="${2%%=*}"
    mkdir -p "$(dirname "$f")"; touch "$f"
    if grep -q "^${key}=" "$f" 2>/dev/null; then
      tmp="${f}.tmp.$$"
      sed "s#^${key}=.*#${kv}#" "$f" > "$tmp" && mv "$tmp" "$f"
    else
      printf '%s\n' "$kv" >> "$f"
    fi
  }
  for _app in workgraph-studio/apps/web workgraph-studio/apps/blueprint-workbench; do
    _f="$ROOT/$_app/.env.local"
    _ensure_kv "$_f" "VITE_IAM_BASE_URL=$IAM_BASE_URL"
    _ensure_kv "$_f" "VITE_LINK_OPERATIONS_PORTAL=http://localhost:5180/operations"
    _ensure_kv "$_f" "VITE_LINK_AGENT_ADMIN=http://localhost:5180/agents"
    _ensure_kv "$_f" "VITE_LINK_WORKGRAPH_DESIGNER=http://localhost:5180/workflows"
    _ensure_kv "$_f" "VITE_LINK_BLUEPRINT_WORKBENCH=http://localhost:5180/workbench"
    _ensure_kv "$_f" "VITE_LINK_CODE_FOUNDRY=http://localhost:5180/foundry"
    # The run pages (RunViewer/WorkDetail/NodeRunModal "Open WorkbenchNeo") read
    # VITE_BLUEPRINT_WORKBENCH_URL — NOT the _LINK_ var the AppSwitcher uses.
    # Without it they fall back to same-origin '/workbench/'. Point legacy
    # callers at the unified platform route.
    _ensure_kv "$_f" "VITE_BLUEPRINT_WORKBENCH_URL=http://localhost:5180/workbench"
    _ensure_kv "$_f" "VITE_LINK_IAM_ADMIN=http://localhost:5180/identity"
  done
  # Platform web is Next.js (NEXT_PUBLIC_* prefix). Keep all app links same-origin.
  _AW="$ROOT/agent-and-tools/web/.env.local"
  _set_kv "$_AW" "NEXT_PUBLIC_LINK_WORKGRAPH_DESIGNER=/workflows"
  _set_kv "$_AW" "NEXT_PUBLIC_LINK_BLUEPRINT_WORKBENCH=/workbench"
  _set_kv "$_AW" "NEXT_PUBLIC_LINK_CODE_FOUNDRY=/foundry"
  _set_kv "$_AW" "NEXT_PUBLIC_LINK_IAM_ADMIN=/identity"
  _set_kv "$_AW" "NEXT_PUBLIC_LINK_OPERATIONS_PORTAL=/operations"

  # The blue Blueprint Workbench cockpit now runs IN-PROCESS as platform-web's
  # /workbench route (same origin, :5180) — no separate :5176 vite server and no
  # :8085 nginx gateway. "Open Workbench" resolves to the blue cockpit directly.

  echo
  ok "platform services booted — run '$0 smoke' in ~30s to verify, then open:"
  echo "    http://localhost:5180              (unified platform web)"
  echo "    http://localhost:5180/agents/studio (Agent Studio)"
  echo "    http://localhost:5180/workflows     (workflows and runs)"
  echo "    http://localhost:5180/workbench     (Blueprint Workbench — blue cockpit, in-process)"
  echo "    http://localhost:5180/foundry       (Code Foundry)"
  echo "    http://localhost:5180/identity      (IAM admin + governance authoring)"
  echo "    http://localhost:8100    (real IAM API; ${LOCAL_SUPER_ADMIN_EMAIL} / configured bootstrap password)"
  echo
  dim "stop everything:   $0 down"
  dim "tail any service:  tail -f logs/<name>.log"
}

cmd_down() {
  normalize_runtime_mode
  if [ ! -f "$PID_FILE" ]; then
    warn "no $PID_FILE found — nothing to stop"
    return 0
  fi
  info "stopping services…"
  while read -r pid; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
      kill_process_tree "$pid" "bare-metal pidfile process"
      dim "  killed $pid"
    fi
  done < "$PID_FILE"
  # Hard sweep — anything still hogging our ports gets terminated. When runtime
  # infra is split/remote, leave those ports alone.
  local ports=(
    "${BARE_METAL_APP_PORT_SPECS[@]}"
    "${BARE_METAL_OPTIONAL_PORT_SPECS[@]}"
  )
  if [ "${SINGULARITY_FREE_LEGACY_PORTS:-1}" != "0" ]; then
    ports+=("${BARE_METAL_LEGACY_UI_PORT_SPECS[@]}")
  fi
  if [ -z "$SKIP_LOCAL_RUNTIME" ]; then
    ports+=("${BARE_METAL_RUNTIME_PORT_SPECS[@]}")
  fi
  free_port_specs "bare-metal" "${ports[@]}"
  free_stale_platform_web_legacy_port
  rm -f "$PID_FILE"
  ok "stack down."
}

cmd_smoke() {
  normalize_runtime_mode
  local fail=0
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    . "$ENV_FILE"
  fi
  local checks=(
    "http://localhost:8100/api/v1/health|200,304|5" \
    "http://localhost:8500/health|200,304|5" \
    "http://localhost:8000/health|200,304|5" \
    "http://localhost:8080/health|200,304|5" \
    "http://localhost:3003/healthz/strict|200,304|10" \
    "http://localhost:5180/api/runtime/agents/templates?scope=common&limit=3|200,401,403|10" \
    "http://localhost:5180/healthz|200,304|10" \
    "http://localhost:5180/|200,304|20" \
    "http://localhost:5180/agents/studio|200,304|20" \
    "http://localhost:5180/workflows|200,304|20" \
    "http://localhost:5180/workbench|200,304|20" \
    "http://localhost:5180/foundry|200,304|20" \
    "http://localhost:5180/identity|200,304|20"
  )
  if [ -z "$SKIP_LOCAL_RUNTIME" ]; then
    checks+=("http://localhost:8001/health|200,304|5" "http://localhost:7100/health|200,304|5")
  fi
  if [ -n "$BARE_METAL_FULL" ]; then
    checks+=("http://localhost:8002/health|200,304|5")
  fi
  if [ "${FORMAL_VERIFICATION_ENABLED:-false}" = "true" ] || [ -n "$BARE_METAL_FULL" ]; then
    checks+=("http://localhost:8010/health|200,304|5")
  fi
  local check url allowed timeout code
  for check in "${checks[@]}"; do
    IFS="|" read -r url allowed timeout <<< "$check"
    code=$(http_code "$url" "$timeout")
    if [[ ",$allowed," == *",$code,"* ]]; then
      printf "  ${C_GREEN}%s${C_END}  %s\n" "$code" "$url"
    else
      printf "  ${C_RED}%s${C_END}  %s\n" "$code" "$url"
      fail=$((fail + 1))
    fi
  done
  echo
  if [ "$fail" != "0" ]; then
    err "$fail endpoint(s) failing — check logs/"
    exit 1
  fi

  ok "all healthy."
  info "checking Context Fabric profile evidence contract..."
  python3 bin/check-context-profile-evidence.py
  ok "Context Fabric profile evidence contract passed."
  info "checking Workgraph tenant database posture..."
  if [ -n "${DATABASE_URL_WORKGRAPH_RUNTIME:-}" ]; then
    python3 bin/check-workgraph-db-tenant-isolation.py --database-url "$DATABASE_URL_WORKGRAPH_RUNTIME"
  else
    python3 bin/check-workgraph-db-tenant-isolation.py --schema-only
  fi
  ok "Workgraph tenant database posture check passed."
  case "${BARE_METAL_DEEP_SMOKE:-}" in
    1|true|TRUE|yes|YES)
      info "running deep Platform Web route/API/browser parity checks..."
      python3 bin/check-platform-web-routes.py
      python3 bin/check-platform-api-parity.py
      node bin/check-platform-web-ui.mjs
      ok "deep Platform Web route/API/browser parity checks passed."
      info "running deep Platform Web lifecycle checks..."
      python3 bin/check-audit-governance-lifecycle.py
      python3 bin/check-workbench-lifecycle.py
      python3 bin/check-workflow-lifecycle.py
      python3 bin/check-foundry-lifecycle.py
      python3 bin/check-agent-profile-lifecycle.py
      ok "deep Platform Web lifecycle checks passed."
      ;;
    *)
      echo "${C_DIM}deep parity checks: BARE_METAL_DEEP_SMOKE=1 $0 smoke  # routes + API proxy + browser hydration + audit/Workbench/workflow/Foundry/Agent Studio lifecycle${C_END}"
      ;;
  esac
  case "${BARE_METAL_TRACE_SPINE:-${SINGULARITY_DOCTOR_TRACE_SPINE:-}}" in
    1|true|TRUE|yes|YES)
      info "running trace spine evidence gate..."
      bash bin/test-trace-spine.sh
      ok "trace spine evidence gate passed."
      ;;
    *)
      echo "${C_DIM}trace spine gate: BARE_METAL_TRACE_SPINE=1 $0 smoke  # requires context-api, audit-gov, and Docker split-DB inspection; MCP resources are checked when reachable${C_END}"
      ;;
  esac
}

cmd_status() {
  if [ ! -f "$PID_FILE" ]; then
    warn "no PIDs recorded; run '$0 up <db_user>'"
    return 0
  fi
  printf "%-18s %-8s %s\n" "SERVICE" "PID" "STATE"
  while read -r pid; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then state="${C_GREEN}running${C_END}"; else state="${C_RED}exited${C_END}"; fi
    cmd=$(ps -p "$pid" -o command= 2>/dev/null | head -c 80)
    printf "%-18s %-8s %b\n" "$(basename "$(echo "$cmd" | awk '{print $NF}')" .ts)" "$pid" "$state"
  done < "$PID_FILE"
}

cmd_logs() {
  local svc="${1:?usage: $0 logs <service> — try one of: $(ls "$LOG_DIR" 2>/dev/null | sed 's/.log//' | tr '\n' ' ')}"
  tail -f "$LOG_DIR/${svc}.log"
}

# ── Dispatch ───────────────────────────────────────────────────────────────
# ── reset-db ────────────────────────────────────────────────────────────────
# Drop every platform database for a clean slate. DESTRUCTIVE. Services holding
# a connection block a drop, so run 'down' first (DROP … WITH (FORCE) also
# terminates lingering sessions on PG 13+). Then 'up' recreates + reseeds.
cmd_reset_db() {
  local db_user="${1:?usage: $0 reset-db <db_user> [db_password] [db_host] [db_port]}"
  local db_pass="${2:-${PGPASSWORD:-postgres}}"
  local db_host="${3:-localhost}"
  local db_port="${4:-5432}"
  require psql
  warn "DROPPING all Singularity databases on ${db_user}@${db_host}:${db_port} — ALL DATA WILL BE LOST."
  local db
  for db in singularity singularity_composer workgraph audit_governance singularity_iam singularity_context_fabric singularity_codegen; do
    if PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" -d postgres \
         -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE);" >/dev/null 2>&1; then
      dim "  dropped $db"
    else
      warn "  could not drop $db — stop connected services first ('$0 down') and retry"
    fi
  done
  ok "databases dropped — run '$0 up <db_user>' to recreate fresh."
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  up)       cmd_up "$@" ;;
  down)     cmd_down ;;
  clean-web-cache|clean-platform-web-cache) clean_platform_web_cache ;;
  reset-db) cmd_reset_db "$@" ;;
  smoke)    cmd_smoke ;;
  status)   cmd_status ;;
  logs)     cmd_logs "$@" ;;
  *)
    cat <<USAGE
Singularity bare-metal launcher.

Preferred split:
  bin/bare-metal-apps.sh up <db_user> [db_password] [db_host] [db_port]
                            start all platform apps except MCP and LLM Gateway.
  bin/bare-metal-runtime.sh up
                            start only local llm-gateway and mcp-server.

Compatibility all-in-one:
  $0 up <db_user> [db_password] [db_host] [db_port]
                            create DBs, install deps, push schemas, seed,
                            boot platform services. Idempotent.
                            Set SKIP_LOCAL_RUNTIME=1 to skip local
                            llm-gateway and mcp-server. Legacy BOX_ONLY=1
                            also defaults PREFER_LAPTOP_LLM=true.

  $0 reset-db <db_user> [db_password] [db_host] [db_port]
                            DROP all platform databases (clean slate). DESTRUCTIVE.
                            Run '$0 down' first, then '$0 up' to recreate fresh.

  $0 clean-web-cache        remove stale Platform Web .next output.
                            Use after Next vendor-chunk/module errors.

  $0 smoke                  curl every /health endpoint — green when healthy.
  $0 status                 list running PIDs.
  $0 logs <service>         tail one service's log (e.g. workgraph-api).
  $0 down                   kill every booted process + free our ports.

Defaults: db_password from \$PGPASSWORD env (else 'postgres'),
          db_host=localhost, db_port=5432.
USAGE
    exit 1
    ;;
esac
