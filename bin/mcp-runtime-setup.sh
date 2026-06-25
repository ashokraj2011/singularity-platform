#!/usr/bin/env bash
set -euo pipefail

# Laptop/runtime-host setup for MCP + local LLM Gateway.
#
# This is the operator-friendly wrapper for the split topology:
#   cloud/server: platform apps + Context Fabric
#   laptop:       llm-gateway + mcp-server dial-in runtime
#
# It stores local-only secrets in gitignored files, starts both runtime
# processes, verifies Context Fabric sees the MCP runtime, and prints the LLM
# providers/models available from the local gateway.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
PID_FILE="${MCP_RUNTIME_PID_FILE:-$ROOT/.pids.runtime}"
LAPTOP_ENV_FILE="$ROOT/.env.laptop"
SECRETS_FILE="$ROOT/.env.llm-secrets"
DEVICE_TOKEN_FILE="${DEVICE_TOKEN_FILE:-$ROOT/.singularity/laptop-device-token}"
PROVIDERS_FILE="${LLM_PROVIDER_CONFIG_PATH:-$ROOT/.singularity/llm-providers.json}"
MODELS_FILE="${LLM_MODEL_CATALOG_PATH:-$ROOT/.singularity/llm-models.json}"

C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m';  C_DIM=$'\033[2m';      C_END=$'\033[0m'
info()  { echo "${C_BLUE}>${C_END} $*"; }
ok()    { echo "${C_GREEN}OK${C_END} $*"; }
warn()  { echo "${C_YELLOW}WARN${C_END} $*"; }
err()   { echo "${C_RED}ERR${C_END} $*" >&2; }
dim()   { echo "${C_DIM}$*${C_END}"; }

usage() {
  cat <<'USAGE'
Usage:
  bin/mcp-runtime-setup.sh connect [options]
  bin/mcp-runtime-setup.sh status [--context-fabric-url URL]
  bin/mcp-runtime-setup.sh down
  bin/mcp-runtime-setup.sh logs [llm-gateway|mcp-server]

Connect a laptop/runtime host to cloud Context Fabric and show usable LLMs.

Required for first connect, unless --runtime-token is supplied:
  --iam-user-id ID             IAM user id / JWT sub that will launch runs
  --jwt-secret SECRET          Shared JWT_SECRET used by cloud Context Fabric

Cloud/runtime options:
  --context-fabric-url URL     e.g. http://cloud.example.com:8000
  --bridge-url URL             e.g. wss://cloud.example.com/api/runtime-bridge/connect
  --runtime-token JWT          Existing IAM runtime/device token
  --tenant-id ID               Optional tenant id claim/hello metadata
  --runtime-id ID              Stable runtime id (default mcp-runtime-<user>)
  --runtime-name NAME          Display name in Operations
  --workspace PATH             MCP sandbox workspace

Local tokens and provider keys:
  --github-token TOKEN         Git clone/push token for MCP tools
  --anthropic-api-key KEY      Enables Anthropic in local LLM Gateway
  --openai-api-key KEY         Enables OpenAI-compatible provider
  --openrouter-api-key KEY     Enables OpenRouter provider
  --copilot-token TOKEN        Enables Copilot LLM provider only with --copilot-base-url
  --copilot-base-url URL       OpenAI-compatible Copilot bridge, e.g. http://localhost:4141/v1
  --copilot-bin PATH           GitHub Copilot CLI path for copilot_execute

Provider/model options:
  --default-provider NAME      anthropic | openai | openrouter | copilot | mock
  --default-model MODEL        Provider model id
  --openai-base-url URL        Default https://api.openai.com/v1
  --openrouter-base-url URL    Default https://openrouter.ai/api/v1
  --anthropic-base-url URL     Default https://api.anthropic.com

Examples:
  bin/mcp-runtime-setup.sh connect \
    --context-fabric-url http://cloud.example.com:8000 \
    --iam-user-id 2eff2916-9761-4301-a173-5b97fd9e0e36 \
    --jwt-secret "$JWT_SECRET" \
    --github-token "$GITHUB_TOKEN" \
    --anthropic-api-key "$ANTHROPIC_API_KEY"

  node bin/copilot-cli-server.js --port 4141
  bin/mcp-runtime-setup.sh connect \
    --context-fabric-url http://cloud.example.com:8000 \
    --iam-user-id "$IAM_USER_ID" \
    --jwt-secret "$JWT_SECRET" \
    --copilot-token copilot-local \
    --copilot-base-url http://localhost:4141/v1 \
    --default-provider copilot \
    --default-model gpt-4o

Environment variables with the same names also work and avoid shell history.
USAGE
}

require() {
  command -v "$1" >/dev/null 2>&1 || { err "missing binary: $1"; exit 1; }
}

load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  set -a
  # shellcheck source=/dev/null
  . "$file"
  set +a
}

upsert_env() {
  local file="$1" key="$2" value="$3"
  [ -n "$value" ] || return 0
  mkdir -p "$(dirname "$file")"
  touch "$file"
  chmod 600 "$file" 2>/dev/null || true
  local tmp="${file}.tmp.$$"
  if [ -f "$file" ]; then
    grep -v "^${key}=" "$file" > "$tmp" 2>/dev/null || true
  else
    : > "$tmp"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

derive_bridge_url() {
  local cf="${1%/}"
  case "$cf" in
    https://*) printf 'wss://%s/api/runtime-bridge/connect\n' "${cf#https://}" ;;
    http://*)  printf 'ws://%s/api/runtime-bridge/connect\n' "${cf#http://}" ;;
    ws://*|wss://*) printf '%s\n' "$cf" ;;
    *) printf 'ws://%s/api/runtime-bridge/connect\n' "$cf" ;;
  esac
}

derive_context_url() {
  local bridge="${1%/}"
  case "$bridge" in
    wss://*) bridge="https://${bridge#wss://}" ;;
    ws://*)  bridge="http://${bridge#ws://}" ;;
  esac
  bridge="${bridge%/api/runtime-bridge/connect}"
  bridge="${bridge%/api/laptop-bridge/connect}"
  printf '%s\n' "$bridge"
}

http_code() {
  local url="$1" timeout="${2:-4}" code
  code="$(curl -s -o /dev/null -w "%{http_code}" --max-time "$timeout" "$url" 2>/dev/null || true)"
  printf '%s' "${code:-000}"
}

free_port() {
  local port="$1" label="$2" pids pid cmd
  command -v lsof >/dev/null 2>&1 || return 0
  pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    cmd="$(ps -p "$pid" -o comm= 2>/dev/null || echo "?")"
    case "$cmd" in
      *docker*|*Docker*|*vpnkit*)
        warn "port $port ($label) is Docker-owned (pid $pid); leaving it alone"
        continue
        ;;
    esac
    dim "freeing $label on :$port (pid $pid, $cmd)"
    kill "$pid" 2>/dev/null || true
    sleep 0.4
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  done
}

json_claim() {
  local token="$1" field="$2"
  TOKEN="$token" FIELD="$field" node <<'NODE' 2>/dev/null || true
const token = process.env.TOKEN || "";
const field = process.env.FIELD || "";
try {
  const payload = JSON.parse(Buffer.from((token.split(".")[1] || ""), "base64url").toString("utf8"));
  const value = payload[field];
  if (value !== undefined && value !== null) process.stdout.write(String(value));
} catch {}
NODE
}

mint_runtime_token() {
  local user_id="$1" jwt_secret="$2" runtime_id="$3" runtime_name="$4" tenant_id="$5"
  mkdir -p "$(dirname "$DEVICE_TOKEN_FILE")"
  JWT_SECRET="$jwt_secret" \
  IAM_USER_ID="$user_id" \
  RUNTIME_ID="$runtime_id" \
  RUNTIME_NAME="$runtime_name" \
  TENANT_ID="$tenant_id" \
  node <<'NODE' > "$DEVICE_TOKEN_FILE"
const crypto = require("crypto");
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const body = {
  kind: "runtime",
  sub: process.env.IAM_USER_ID,
  runtime_id: process.env.RUNTIME_ID,
  runtime_type: "mcp",
  device_id: process.env.RUNTIME_ID,
  device_name: process.env.RUNTIME_NAME,
  runtime_scope: "user",
  allowed_frame_types: ["tool-run", "model-run", "code-context", "invoke"],
  capability_tags: ["mcp", "tools", "llm"],
  iat: now,
  exp: now + 90 * 24 * 3600,
};
if (process.env.TENANT_ID) body.tenant_id = process.env.TENANT_ID;
const header = b64({ alg: "HS256", typ: "JWT" });
const payload = b64(body);
const sig = crypto.createHmac("sha256", process.env.JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
process.stdout.write(`${header}.${payload}.${sig}`);
NODE
  chmod 600 "$DEVICE_TOKEN_FILE"
}

ensure_provider_files() {
  mkdir -p "$ROOT/.singularity"
  [ -f "$PROVIDERS_FILE" ] || cp "$ROOT/.singularity/llm-providers.json.default" "$PROVIDERS_FILE" 2>/dev/null || true
  [ -f "$MODELS_FILE" ] || cp "$ROOT/.singularity/llm-models.json.default" "$MODELS_FILE" 2>/dev/null || true
}

configure_provider_catalog() {
  ensure_provider_files
  load_env_file "$SECRETS_FILE"
  PROVIDERS_FILE="$PROVIDERS_FILE" \
  MODELS_FILE="$MODELS_FILE" \
  DEFAULT_PROVIDER="${DEFAULT_PROVIDER:-}" \
  DEFAULT_MODEL="${DEFAULT_MODEL:-}" \
  ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}" \
  OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}" \
  OPENROUTER_BASE_URL="${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}" \
  COPILOT_BASE_URL="${COPILOT_BASE_URL:-}" \
  node <<'NODE'
const fs = require("fs");

const providersPath = process.env.PROVIDERS_FILE;
const modelsPath = process.env.MODELS_FILE;

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); }
  catch { return fallback; }
}

const cfg = readJson(providersPath, { defaultProvider: "mock", defaultModel: "mock-fast", allowedProviders: ["mock"], providers: {} });
cfg.providers = cfg.providers && typeof cfg.providers === "object" ? cfg.providers : {};

const present = {
  anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  openai: Boolean(process.env.OPENAI_API_KEY),
  openrouter: Boolean(process.env.OPENROUTER_API_KEY),
  copilot: Boolean(process.env.COPILOT_TOKEN && process.env.COPILOT_BASE_URL),
};

if (present.anthropic) {
  cfg.providers.anthropic = {
    enabled: true,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    credentialEnv: "ANTHROPIC_API_KEY",
    defaultModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    supportsTools: true,
    costTier: "medium",
    description: "Anthropic Messages API provider for laptop LLM Gateway.",
  };
}

if (present.openai) {
  cfg.providers.openai = {
    enabled: true,
    baseUrl: process.env.OPENAI_BASE_URL,
    credentialEnv: "OPENAI_API_KEY",
    defaultModel: process.env.OPENAI_MODEL || "gpt-4o",
    supportsTools: true,
    costTier: "medium",
    description: "OpenAI or OpenAI-compatible provider for laptop LLM Gateway.",
  };
}

if (present.openrouter) {
  cfg.providers.openrouter = {
    enabled: true,
    baseUrl: process.env.OPENROUTER_BASE_URL,
    credentialEnv: "OPENROUTER_API_KEY",
    defaultModel: process.env.OPENROUTER_MODEL || "openai/gpt-4o",
    supportsTools: true,
    costTier: "medium",
    description: "OpenRouter provider for laptop LLM Gateway.",
  };
}

if (present.copilot) {
  cfg.providers.copilot = {
    enabled: true,
    baseUrl: process.env.COPILOT_BASE_URL.replace(/\/$/, ""),
    credentialEnv: "COPILOT_TOKEN",
    defaultModel: process.env.COPILOT_MODEL || "gpt-4o",
    supportsTools: true,
    costTier: "medium",
    description: "OpenAI-compatible Copilot bridge for laptop LLM Gateway.",
  };
}

cfg.providers.mock = cfg.providers.mock || { enabled: true, defaultModel: "mock-fast", supportsTools: true };
if (cfg.providers.mock.enabled === undefined) cfg.providers.mock.enabled = true;

const order = ["anthropic", "openai", "openrouter", "copilot", "mock"];
let defaultProvider = (process.env.DEFAULT_PROVIDER || "").toLowerCase();
if (!defaultProvider) defaultProvider = order.find((name) => present[name]) || cfg.defaultProvider || "mock";
if (!cfg.providers[defaultProvider] || cfg.providers[defaultProvider].enabled === false) defaultProvider = order.find((name) => cfg.providers[name] && cfg.providers[name].enabled !== false) || "mock";

cfg.defaultProvider = defaultProvider;
cfg.allowedProviders = order.filter((name) => cfg.providers[name] && cfg.providers[name].enabled !== false && (name === "mock" || present[name]));
if (!cfg.allowedProviders.includes("mock")) cfg.allowedProviders.push("mock");

const defaultModel = process.env.DEFAULT_MODEL || (cfg.providers[defaultProvider] && cfg.providers[defaultProvider].defaultModel) || "mock-fast";
cfg.defaultModel = defaultModel;

fs.writeFileSync(providersPath, JSON.stringify(cfg, null, 2) + "\n");

let models = readJson(modelsPath, []);
if (!Array.isArray(models)) models = [];
models = models.map((entry) => entry && typeof entry === "object" ? { ...entry, default: false } : entry);
const alias = defaultModel;
let row = models.find((entry) => entry && entry.id === alias);
if (!row) {
  row = {
    id: alias,
    label: `${alias} (${defaultProvider})`,
    maxOutputTokens: 8000,
    supportsTools: true,
    costTier: defaultProvider === "mock" ? "free" : "standard",
  };
  models.unshift(row);
}
row.provider = defaultProvider;
row.model = defaultModel;
row.default = true;
if (!row.label) row.label = `${alias} (${defaultProvider})`;
fs.writeFileSync(modelsPath, JSON.stringify(models, null, 2) + "\n");
NODE
}

ensure_gateway_python() {
  local py="${SINGULARITY_PYTHON:-python3}" venv
  if [ -x "$ROOT/context-fabric/.venv/bin/python" ]; then
    venv="$ROOT/context-fabric/.venv"
  elif [ -x "$ROOT/.venv/bin/python" ]; then
    venv="$ROOT/.venv"
  else
    venv="$ROOT/context-fabric/.venv"
    info "creating Python environment for LLM Gateway at context-fabric/.venv"
    "$py" -m venv "$venv"
  fi
  if ! "$venv/bin/python" -c "import fastapi, uvicorn, httpx, pydantic, pydantic_settings" >/dev/null 2>&1; then
    info "installing LLM Gateway Python dependencies"
    "$venv/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
    "$venv/bin/python" -m pip install --quiet -r "$ROOT/context-fabric/services/llm_gateway_service/requirements.txt"
  fi
  printf '%s\n' "$venv/bin/python"
}

ensure_node_deps() {
  if [ ! -d "$ROOT/mcp-server/node_modules" ]; then
    info "installing mcp-server dependencies"
    ( cd "$ROOT/mcp-server" && npm install >/dev/null 2>&1 )
  fi
}

boot_process() {
  local name="$1"; shift
  local cmd="$*"
  mkdir -p "$LOG_DIR"
  ( bash -c "$cmd" >> "$LOG_DIR/${name}.log" 2>&1 & printf '%s %s\n' "$name" "$!" >> "$PID_FILE" )
  sleep 0.4
  local pid
  pid="$(tail -n 1 "$PID_FILE" | awk '{print $2}')"
  ok "$name started (pid $pid) -> logs/${name}.log"
}

stop_runtime() {
  if [ -f "$PID_FILE" ]; then
    while read -r name pid; do
      [ -n "${pid:-}" ] || continue
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        dim "stopped $name ($pid)"
      fi
    done < "$PID_FILE"
  fi
  free_port 8001 llm-gateway
  free_port 7100 mcp-server
  rm -f "$PID_FILE"
}

wait_for_gateway() {
  local i code
  for i in $(seq 1 45); do
    code="$(http_code "${LLM_GATEWAY_URL%/}/health" 3)"
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  return 1
}

wait_for_bridge() {
  local status_url="$1" runtime_id="$2" i body
  for i in $(seq 1 45); do
    body="$(curl -s --max-time 5 "$status_url" 2>/dev/null || true)"
    if [ -n "$body" ]; then
      BODY="$body" RUNTIME_ID="$runtime_id" node <<'NODE' >/dev/null 2>&1 && return 0 || true
const body = JSON.parse(process.env.BODY || "{}");
const text = JSON.stringify(body);
const runtimeId = process.env.RUNTIME_ID || "";
if (runtimeId && text.includes(runtimeId)) process.exit(0);
if (!runtimeId && Number(body.count || 0) > 0) process.exit(0);
process.exit(1);
NODE
    fi
    sleep 1
  done
  return 1
}

print_bridge_status() {
  local status_url="$1" runtime_id="${2:-}"
  local body
  body="$(curl -s --max-time 6 "$status_url" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    warn "could not read Context Fabric runtime status at $status_url"
    return 0
  fi
  BODY="$body" RUNTIME_ID="$runtime_id" node <<'NODE'
const body = JSON.parse(process.env.BODY || "{}");
const runtimeId = process.env.RUNTIME_ID || "";
const text = JSON.stringify(body);
const connected = runtimeId ? text.includes(runtimeId) : Number(body.count || 0) > 0;
console.log(`Runtime bridge: ${connected ? "CONNECTED" : "not connected yet"} (count=${body.count ?? "unknown"})`);
if (runtimeId) console.log(`Runtime id: ${runtimeId}`);
function walk(value, rows = []) {
  if (Array.isArray(value)) value.forEach((v) => walk(v, rows));
  else if (value && typeof value === "object") {
    if (value.runtime_id || value.device_id) rows.push(value);
    Object.values(value).forEach((v) => walk(v, rows));
  }
  return rows;
}
const rows = walk(body).filter((row, idx, arr) => {
  const id = row.runtime_id || row.device_id;
  return id && arr.findIndex((other) => (other.runtime_id || other.device_id) === id) === idx;
});
for (const row of rows.slice(0, 8)) {
  const id = row.runtime_id || row.device_id;
  const frames = row.supported_frame_types || row.supportedFrames || row.frame_types || [];
  const last = row.last_heartbeat_at || row.lastHeartbeatAt || row.connected_at || "";
  console.log(`- ${id} type=${row.runtime_type || row.runtimeType || "?"} user=${row.user_id || row.userId || row.sub || "?"} frames=${Array.isArray(frames) ? frames.join(",") : frames} ${last}`);
}
NODE
}

print_llm_status() {
  local providers models
  local gateway_url="${LLM_GATEWAY_URL:-http://localhost:8001}"
  providers="$(curl -s --max-time 6 "${gateway_url%/}/llm/providers" 2>/dev/null || true)"
  models="$(curl -s --max-time 6 "${gateway_url%/}/llm/models" 2>/dev/null || true)"
  if [ -z "$providers" ]; then
    warn "could not read LLM providers from ${gateway_url%/}/llm/providers"
    return 0
  fi
  PROVIDERS_JSON="$providers" MODELS_JSON="$models" node <<'NODE'
const providers = JSON.parse(process.env.PROVIDERS_JSON || "{}");
let models = {};
try { models = JSON.parse(process.env.MODELS_JSON || "{}"); } catch {}
console.log("");
console.log("LLM Gateway:");
console.log(`- default provider: ${providers.default_provider || providers.defaultProvider || "unknown"}`);
console.log(`- default model alias: ${providers.default_model_alias || providers.defaultModelAlias || "unknown"}`);
for (const p of providers.providers || []) {
  const warnings = Array.isArray(p.warnings) && p.warnings.length ? ` warnings=${p.warnings.join("; ")}` : "";
  console.log(`- provider ${p.name}: ready=${Boolean(p.ready)} allowed=${Boolean(p.allowed)} model=${p.default_model || p.defaultModel || "-"}${warnings}`);
}
const rows = Array.isArray(models.models) ? models.models : [];
if (rows.length) {
  console.log("");
  console.log("Usable model aliases:");
  for (const m of rows.filter((row) => row.ready !== false).slice(0, 12)) {
    console.log(`- ${m.id} -> ${m.provider}/${m.model}${m.default ? " (default)" : ""}`);
  }
}
NODE
}

cmd_connect() {
  require node
  require npm
  require curl

  local context_url="${CONTEXT_FABRIC_URL:-}"
  local bridge_url="${RUNTIME_BRIDGE_URL:-${LAPTOP_BRIDGE_URL:-}}"
  local iam_user_id="${IAM_USER_ID:-${SINGULARITY_USER_ID:-}}"
  local jwt_secret="${JWT_SECRET:-}"
  local runtime_token="${SINGULARITY_RUNTIME_TOKEN:-${SINGULARITY_DEVICE_TOKEN:-}}"
  local tenant_id="${SINGULARITY_TENANT_ID:-}"
  local runtime_id="${SINGULARITY_RUNTIME_ID:-}"
  local runtime_name="${SINGULARITY_RUNTIME_NAME:-mcp-runtime-laptop}"
  local workspace="${MCP_SANDBOX_ROOT:-$HOME/sg-laptop-workspace}"
  local github_token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  local anthropic_key="${ANTHROPIC_API_KEY:-}"
  local openai_key="${OPENAI_API_KEY:-}"
  local openrouter_key="${OPENROUTER_API_KEY:-}"
  local copilot_token="${COPILOT_TOKEN:-}"
  local copilot_base_url="${COPILOT_BASE_URL:-}"
  local copilot_bin="${COPILOT_BIN:-}"
  local default_provider="${DEFAULT_PROVIDER:-}"
  local default_model="${DEFAULT_MODEL:-}"
  local openai_base_url="${OPENAI_BASE_URL:-}"
  local openrouter_base_url="${OPENROUTER_BASE_URL:-}"
  local anthropic_base_url="${ANTHROPIC_BASE_URL:-}"

  while [ $# -gt 0 ]; do
    case "$1" in
      --context-fabric-url|--context-url) context_url="${2:?missing value}"; shift 2 ;;
      --bridge-url|--runtime-bridge-url) bridge_url="${2:?missing value}"; shift 2 ;;
      --iam-user-id|--user-id) iam_user_id="${2:?missing value}"; shift 2 ;;
      --jwt-secret) jwt_secret="${2:?missing value}"; shift 2 ;;
      --runtime-token) runtime_token="${2:?missing value}"; shift 2 ;;
      --tenant-id) tenant_id="${2:?missing value}"; shift 2 ;;
      --runtime-id) runtime_id="${2:?missing value}"; shift 2 ;;
      --runtime-name|--device-name) runtime_name="${2:?missing value}"; shift 2 ;;
      --workspace|--sandbox-root) workspace="${2:?missing value}"; shift 2 ;;
      --github-token|--gh-token) github_token="${2:?missing value}"; shift 2 ;;
      --anthropic-api-key) anthropic_key="${2:?missing value}"; shift 2 ;;
      --openai-api-key) openai_key="${2:?missing value}"; shift 2 ;;
      --openrouter-api-key) openrouter_key="${2:?missing value}"; shift 2 ;;
      --copilot-token) copilot_token="${2:?missing value}"; shift 2 ;;
      --copilot-base-url) copilot_base_url="${2:?missing value}"; shift 2 ;;
      --copilot-bin) copilot_bin="${2:?missing value}"; shift 2 ;;
      --default-provider) default_provider="${2:?missing value}"; shift 2 ;;
      --default-model) default_model="${2:?missing value}"; shift 2 ;;
      --openai-base-url) openai_base_url="${2:?missing value}"; shift 2 ;;
      --openrouter-base-url) openrouter_base_url="${2:?missing value}"; shift 2 ;;
      --anthropic-base-url) anthropic_base_url="${2:?missing value}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) err "unknown option: $1"; usage; exit 1 ;;
    esac
  done

  if [ -z "$bridge_url" ]; then
    context_url="${context_url:-http://localhost:8000}"
    bridge_url="$(derive_bridge_url "$context_url")"
  fi
  context_url="${context_url:-$(derive_context_url "$bridge_url")}"
  local status_url="${context_url%/}/api/runtime-bridge/status"

  if [ -z "$runtime_token" ] && [ -s "$DEVICE_TOKEN_FILE" ]; then
    runtime_token="$(tr -d '\n' < "$DEVICE_TOKEN_FILE")"
  fi
  if [ -z "$runtime_id" ] && [ -n "$runtime_token" ]; then
    runtime_id="$(json_claim "$runtime_token" runtime_id)"
  fi
  if [ -z "$runtime_id" ]; then
    runtime_id="mcp-runtime-${iam_user_id:-$(hostname -s 2>/dev/null || echo local)}"
  fi

  if [ -n "$runtime_token" ]; then
    mkdir -p "$(dirname "$DEVICE_TOKEN_FILE")"
    printf '%s\n' "$runtime_token" > "$DEVICE_TOKEN_FILE"
    chmod 600 "$DEVICE_TOKEN_FILE"
  elif [ -n "$iam_user_id" ] && [ -n "$jwt_secret" ]; then
    info "minting local runtime JWT for user $iam_user_id"
    mint_runtime_token "$iam_user_id" "$jwt_secret" "$runtime_id" "$runtime_name" "$tenant_id"
    runtime_token="$(tr -d '\n' < "$DEVICE_TOKEN_FILE")"
  else
    err "need --runtime-token, or both --iam-user-id and --jwt-secret"
    exit 1
  fi

  upsert_env "$LAPTOP_ENV_FILE" CONTEXT_FABRIC_URL "$context_url"
  upsert_env "$LAPTOP_ENV_FILE" RUNTIME_BRIDGE_URL "$bridge_url"
  upsert_env "$LAPTOP_ENV_FILE" LAPTOP_BRIDGE_URL "$bridge_url"
  upsert_env "$LAPTOP_ENV_FILE" SINGULARITY_RUNTIME_ID "$runtime_id"
  upsert_env "$LAPTOP_ENV_FILE" SINGULARITY_RUNTIME_NAME "$runtime_name"
  upsert_env "$LAPTOP_ENV_FILE" SINGULARITY_TENANT_ID "$tenant_id"
  upsert_env "$LAPTOP_ENV_FILE" MCP_SANDBOX_ROOT "$workspace"
  upsert_env "$LAPTOP_ENV_FILE" LLM_GATEWAY_URL "http://localhost:8001"
  upsert_env "$LAPTOP_ENV_FILE" DEFAULT_PROVIDER "$default_provider"
  upsert_env "$LAPTOP_ENV_FILE" DEFAULT_MODEL "$default_model"
  upsert_env "$LAPTOP_ENV_FILE" OPENAI_BASE_URL "$openai_base_url"
  upsert_env "$LAPTOP_ENV_FILE" OPENROUTER_BASE_URL "$openrouter_base_url"
  upsert_env "$LAPTOP_ENV_FILE" ANTHROPIC_BASE_URL "$anthropic_base_url"
  upsert_env "$LAPTOP_ENV_FILE" COPILOT_BASE_URL "$copilot_base_url"
  if [ -n "$github_token" ]; then
    upsert_env "$LAPTOP_ENV_FILE" GITHUB_TOKEN "$github_token"
    upsert_env "$LAPTOP_ENV_FILE" GH_TOKEN "$github_token"
    upsert_env "$LAPTOP_ENV_FILE" MCP_GIT_AUTH_MODE "token"
    upsert_env "$LAPTOP_ENV_FILE" MCP_GIT_PUSH_ENABLED "true"
  fi
  upsert_env "$LAPTOP_ENV_FILE" COPILOT_BIN "$copilot_bin"

  upsert_env "$SECRETS_FILE" ANTHROPIC_API_KEY "$anthropic_key"
  upsert_env "$SECRETS_FILE" OPENAI_API_KEY "$openai_key"
  upsert_env "$SECRETS_FILE" OPENROUTER_API_KEY "$openrouter_key"
  upsert_env "$SECRETS_FILE" COPILOT_TOKEN "$copilot_token"

  export CONTEXT_FABRIC_URL="$context_url"
  export RUNTIME_BRIDGE_URL="$bridge_url"
  export LAPTOP_BRIDGE_URL="$bridge_url"
  export LLM_GATEWAY_URL="http://localhost:8001"
  export LLM_PROVIDER_CONFIG_PATH="$PROVIDERS_FILE"
  export LLM_MODEL_CATALOG_PATH="$MODELS_FILE"
  export DEFAULT_PROVIDER="$default_provider"
  export DEFAULT_MODEL="$default_model"
  export OPENAI_BASE_URL="${openai_base_url:-https://api.openai.com/v1}"
  export OPENROUTER_BASE_URL="${openrouter_base_url:-https://openrouter.ai/api/v1}"
  export ANTHROPIC_BASE_URL="${anthropic_base_url:-https://api.anthropic.com}"
  export COPILOT_BASE_URL="$copilot_base_url"
  export SINGULARITY_RUNTIME_TOKEN="$runtime_token"
  export SINGULARITY_DEVICE_TOKEN="$runtime_token"
  export SINGULARITY_RUNTIME_ID="$runtime_id"
  export SINGULARITY_DEVICE_ID="$runtime_id"
  export SINGULARITY_RUNTIME_NAME="$runtime_name"
  export SINGULARITY_DEVICE_NAME="$runtime_name"
  export SINGULARITY_RUNTIME_TYPE=mcp
  export SINGULARITY_TENANT_ID="$tenant_id"
  export MCP_SANDBOX_ROOT="$workspace"

  configure_provider_catalog
  load_env_file "$SECRETS_FILE"
  load_env_file "$LAPTOP_ENV_FILE"

  local python_bin
  python_bin="$(ensure_gateway_python)"
  ensure_node_deps

  info "stopping any existing local runtime on :8001/:7100"
  stop_runtime
  : > "$PID_FILE"
  mkdir -p "$workspace"
  [ -d "$workspace/.git" ] || git -C "$workspace" init -q 2>/dev/null || true

  info "starting laptop LLM Gateway"
  boot_process llm-gateway "cd \"$ROOT/context-fabric\" && env LLM_PROVIDER_CONFIG_PATH=\"$PROVIDERS_FILE\" LLM_MODEL_CATALOG_PATH=\"$MODELS_FILE\" ALLOW_CALLER_PROVIDER_OVERRIDE=false ANTHROPIC_API_KEY=\"${ANTHROPIC_API_KEY:-}\" OPENAI_API_KEY=\"${OPENAI_API_KEY:-}\" OPENROUTER_API_KEY=\"${OPENROUTER_API_KEY:-}\" COPILOT_TOKEN=\"${COPILOT_TOKEN:-}\" \"$python_bin\" -m uvicorn services.llm_gateway_service.app.main:app --host 0.0.0.0 --port 8001"

  if ! wait_for_gateway; then
    err "LLM Gateway did not become healthy. Check logs/llm-gateway.log"
    exit 1
  fi

  info "starting MCP runtime dial-in"
  boot_process mcp-server "cd \"$ROOT/mcp-server\" && env PORT=7100 RUNTIME_DIAL_IN_MODE=true LAPTOP_MODE=true RUNTIME_BRIDGE_URL=\"$bridge_url\" LAPTOP_BRIDGE_URL=\"$bridge_url\" SINGULARITY_RUNTIME_TOKEN=\"$runtime_token\" SINGULARITY_DEVICE_TOKEN=\"$runtime_token\" SINGULARITY_RUNTIME_ID=\"$runtime_id\" SINGULARITY_DEVICE_ID=\"$runtime_id\" SINGULARITY_RUNTIME_NAME=\"$runtime_name\" SINGULARITY_DEVICE_NAME=\"$runtime_name\" SINGULARITY_RUNTIME_TYPE=mcp SINGULARITY_TENANT_ID=\"$tenant_id\" MCP_BEARER_TOKEN=\"${MCP_BEARER_TOKEN:-demo-bearer-token-must-be-min-16-chars}\" LLM_GATEWAY_URL=\"http://localhost:8001\" MCP_COMMAND_EXECUTION_MODE=process MCP_SANDBOX_ROOT=\"$workspace\" MCP_LLM_PROVIDER_CONFIG_PATH=\"$PROVIDERS_FILE\" MCP_LLM_MODEL_CATALOG_PATH=\"$MODELS_FILE\" GITHUB_TOKEN=\"${GITHUB_TOKEN:-}\" GH_TOKEN=\"${GH_TOKEN:-}\" MCP_GIT_AUTH_MODE=\"${MCP_GIT_AUTH_MODE:-}\" MCP_GIT_PUSH_ENABLED=\"${MCP_GIT_PUSH_ENABLED:-}\" COPILOT_BIN=\"${COPILOT_BIN:-copilot}\" npm run dev"

  echo
  if wait_for_bridge "$status_url" "$runtime_id"; then
    ok "MCP runtime is connected to Context Fabric"
  else
    warn "MCP runtime has not appeared in Context Fabric yet"
    warn "Check $status_url and logs/mcp-server.log"
  fi
  print_bridge_status "$status_url" "$runtime_id"
  print_llm_status

  echo
  ok "runtime setup complete"
  echo "  Context Fabric: $context_url"
  echo "  Runtime bridge: $bridge_url"
  echo "  LLM Gateway:    http://localhost:8001"
  echo "  Logs:           tail -f logs/mcp-server.log logs/llm-gateway.log"
}

cmd_status() {
  local context_override="" bridge_override=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --context-fabric-url|--context-url) context_override="${2:?missing value}"; shift 2 ;;
      --bridge-url|--runtime-bridge-url) bridge_override="${2:?missing value}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) err "unknown status option: $1"; exit 1 ;;
    esac
  done
  load_env_file "$LAPTOP_ENV_FILE"
  local context_url="${context_override:-${CONTEXT_FABRIC_URL:-}}"
  local bridge_url="${bridge_override:-${RUNTIME_BRIDGE_URL:-${LAPTOP_BRIDGE_URL:-}}}"
  export LLM_GATEWAY_URL="${LLM_GATEWAY_URL:-http://localhost:8001}"
  if [ -z "$context_url" ] && [ -n "$bridge_url" ]; then context_url="$(derive_context_url "$bridge_url")"; fi
  context_url="${context_url:-http://localhost:8000}"
  local status_url="${context_url%/}/api/runtime-bridge/status"
  local runtime_id="${SINGULARITY_RUNTIME_ID:-}"
  if [ -z "$runtime_id" ] && [ -s "$DEVICE_TOKEN_FILE" ]; then
    runtime_id="$(json_claim "$(tr -d '\n' < "$DEVICE_TOKEN_FILE")" runtime_id)"
  fi
  echo "Processes:"
  if [ -f "$PID_FILE" ]; then
    while read -r name pid; do
      [ -n "${pid:-}" ] || continue
      if kill -0 "$pid" 2>/dev/null; then
        echo "- $name pid=$pid running"
      else
        echo "- $name pid=$pid exited"
      fi
    done < "$PID_FILE"
  else
    echo "- no $PID_FILE"
  fi
  echo
  print_bridge_status "$status_url" "$runtime_id"
  print_llm_status
}

cmd_down() {
  info "stopping laptop MCP/LLM runtime"
  stop_runtime
  ok "runtime stopped"
}

cmd_logs() {
  local svc="${1:-mcp-server}"
  case "$svc" in
    llm-gateway|mcp-server) tail -f "$LOG_DIR/${svc}.log" ;;
    *) err "usage: $0 logs [llm-gateway|mcp-server]"; exit 1 ;;
  esac
}

load_env_file "$LAPTOP_ENV_FILE"
load_env_file "$SECRETS_FILE"

cmd="${1:-connect}"
case "$cmd" in
  connect|up) shift || true; cmd_connect "$@" ;;
  status) shift || true; cmd_status "$@" ;;
  down|stop) shift || true; cmd_down ;;
  logs) shift || true; cmd_logs "$@" ;;
  help|-h|--help) usage ;;
  --*) cmd_connect "$@" ;;
  *) err "unknown command: $cmd"; usage; exit 1 ;;
esac
