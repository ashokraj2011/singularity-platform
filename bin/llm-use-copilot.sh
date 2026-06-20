#!/usr/bin/env bash
#
# llm-use-copilot.sh — route ALL LLM traffic through a GitHub Copilot
# headless (OpenAI-compatible) server, via the Singularity llm-gateway.
#
# Every service in the stack (context-fabric, mcp-server, agent-runtime, …)
# calls the central llm-gateway, and the gateway picks a provider from
# .singularity/llm-providers.json + resolves a model alias from
# .singularity/llm-models.json. This script flips BOTH so every request —
# whether it sends a model_alias (the agents do) or not — lands on Copilot:
#
#   1. .singularity/llm-providers.json  → add/enable a `copilot` provider
#      (baseUrl=<your headless server>, credentialEnv=COPILOT_TOKEN), add it to
#      allowedProviders, and set defaultProvider/defaultModel to copilot.
#   2. .singularity/llm-models.json     → repoint ALL model aliases to
#      provider=copilot / model=<your model> (so claude-* aliases route to
#      Copilot too — otherwise they'd still hit Anthropic).
#   3. .env.llm-secrets                 → set COPILOT_TOKEN (the gateway reads
#      provider creds only from this gitignored env_file).
#   4. restart the llm-gateway and verify it's serving Copilot. Works in BOTH
#      Docker (recreates the singularity-llm-gateway container) and BARE-METAL
#      (restarts the uvicorn process on :8001 with COPILOT_TOKEN; detected via
#      the repo-root .env.local + .pids.runtime that bin/bare-metal-runtime.sh
#      writes; the legacy .pids file is still recognized).
#
# Idempotent. Originals are backed up to *.copilot-bak on first run; re-run with
# --restore to flip everything back to the previous (Anthropic) config.
#
# Usage:
#   bin/llm-use-copilot.sh --base-url http://host.docker.internal:4141/v1 \
#                          --model gpt-4o [--token <copilot-token>]
#   bin/llm-use-copilot.sh --preset github-models --token <GITHUB_PAT>
#   bin/llm-use-copilot.sh --restore
#
# Notes:
#   * --preset is a shortcut for a known OpenAI-compatible endpoint (overridable
#     with --base-url/--model):
#       copilot-bridge (default) — you supply --base-url: a local OpenAI-compatible
#         Copilot server (e.g. copilot-api on :4141/v1).
#       github-models — GitHub-hosted models at https://models.github.ai/inference
#         (default model openai/gpt-4o). --token MUST be a GitHub PAT with the
#         `models` permission; Bearer-only, so it works with the gateway as-is.
#       copilot-editor — https://api.githubcopilot.com (default model gpt-4o). The
#         gateway adapter does NOT send the Editor-Version/Copilot-Integration-Id
#         headers this endpoint needs, so it will likely 400/403 without a tweak.
#   * --base-url must be reachable FROM the gateway container and is used as
#     `<base-url>/chat/completions`. If your headless server runs on the host,
#     use host.docker.internal; include the OpenAI path prefix (usually /v1).
#     The GitHub Copilot CLI `copilot --headless --port ...` TCP server is not
#     an OpenAI-compatible HTTP server; it will fail this script's preflight.
#   * --token is written to .env.llm-secrets. If your local server ignores auth,
#     any non-empty value works (the gateway requires the credential to be set
#     for the provider to be "ready"). Falls back to $COPILOT_TOKEN, else
#     "copilot-local".
#   * --model is the model name your headless server exposes (gpt-4o, gpt-4.1,
#     claude-3.7-sonnet, …).
#   * --skip-preflight bypasses the HTTP reachability check. Use only after
#     proving the endpoint works from inside the llm-gateway container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROVIDERS="$ROOT/.singularity/llm-providers.json"
CATALOG="$ROOT/.singularity/llm-models.json"
SECRETS="$ROOT/.env.llm-secrets"
GATEWAY_PORT="${LLM_GATEWAY_HOST_PORT:-8001}"

c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info() { c "36" "→ $1"; }
ok()   { c "32" "✓ $1"; }
warn() { c "33" "! $1"; }
die()  { c "31" "✗ $1"; exit 1; }

kill_non_docker_port() {
  local port="$1" pids pid cmd
  pids="$(lsof -ti :"$port" 2>/dev/null || true)"
  for pid in $pids; do
    cmd="$(ps -p "$pid" -o comm= 2>/dev/null || echo "?")"
    case "$cmd" in
      *docker*|*Docker*|*vpnkit*)
        warn "port $port is Docker-owned (pid $pid); leaving it alone"
        continue
        ;;
    esac
    kill -9 "$pid" 2>/dev/null || true
  done
}

BASE_URL=""; MODEL=""; TOKEN="${COPILOT_TOKEN:-}"; RESTORE=0; SKIP_PREFLIGHT=0; PRESET=""; GH_MODELS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="${2:?--base-url needs a value}"; shift 2 ;;
    --model)    MODEL="${2:?--model needs a value}"; shift 2 ;;
    --token)    TOKEN="${2:?--token needs a value}"; shift 2 ;;
    --preset)   PRESET="${2:?--preset needs a value}"; shift 2 ;;
    --skip-preflight) SKIP_PREFLIGHT=1; shift ;;
    --restore)  RESTORE=1; shift ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown arg: $1 (see --help)" ;;
  esac
done

# Presets fill base-url/model for known endpoints (explicit flags still win).
case "$PRESET" in
  ""|copilot-bridge) : ;;
  github-models)
    [ -n "$BASE_URL" ] || BASE_URL="https://models.github.ai/inference"
    [ -n "$MODEL" ]    || MODEL="openai/gpt-4o"
    SKIP_PREFLIGHT=1   # /models needs the PAT; skip the unauth reachability probe
    GH_MODELS=1 ;;
  copilot-editor)
    [ -n "$BASE_URL" ] || BASE_URL="https://api.githubcopilot.com"
    [ -n "$MODEL" ]    || MODEL="gpt-4o"
    warn "preset copilot-editor: api.githubcopilot.com needs Editor-Version/Copilot-Integration-Id headers the gateway does not send — it will likely 400/403." ;;
  *) die "unknown --preset: $PRESET (copilot-bridge | github-models | copilot-editor)" ;;
esac

command -v python3 >/dev/null || die "python3 is required"
if [ ! -f "$PROVIDERS" ] || [ ! -f "$CATALOG" ]; then
  die "gateway config not found ($PROVIDERS / $CATALOG).
   These files are gitignored — generate them first, then bring a stack up:
     ./singularity.sh config init --profile office-laptop
     ./singularity.sh config mcp-catalog --default-alias mock
     ./singularity.sh up                 # Docker   (bare-metal: bin/setup.sh)
   Tip: on bare-metal, bin/setup.sh does all of this AND points the gateway at
   your Copilot bridge in one step — you don't need to run this script yourself."
fi

recreate_and_verify() {
  # Bare-metal first: the split runtime launcher writes .pids.runtime, while the
  # legacy all-in-one launcher writes .pids. Detect these BEFORE Docker so a
  # Docker stack elsewhere on the same machine cannot steal the restart.
  if [ -f "$ROOT/.env.local" ] && { [ -f "$ROOT/.pids.runtime" ] || [ -f "$ROOT/.pids" ]; }; then
    info "bare-metal mode: restarting the llm-gateway process on :${GATEWAY_PORT}…"
    local pybin="$ROOT/.venv/bin/python"; [ -x "$pybin" ] || pybin="python3"
    # shellcheck source=/dev/null
    set -a; . "$ROOT/.env.local"; [ -f "$SECRETS" ] && . "$SECRETS"; set +a
    kill_non_docker_port "${GATEWAY_PORT}"
    mkdir -p "$ROOT/logs"
    ( cd "$ROOT/context-fabric" && \
        LLM_PROVIDER_CONFIG_PATH="$PROVIDERS" LLM_MODEL_CATALOG_PATH="$CATALOG" \
        COPILOT_TOKEN="${COPILOT_TOKEN:-${TOKEN:-}}" ALLOW_CALLER_PROVIDER_OVERRIDE=false \
        nohup "$pybin" -m uvicorn services.llm_gateway_service.app.main:app \
          --host 0.0.0.0 --port "${GATEWAY_PORT}" > "$ROOT/logs/llm-gateway.log" 2>&1 & )
  elif command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' | grep -qx 'singularity-llm-gateway'; then
    info "recreating the llm-gateway container…"
    ( cd "$ROOT" && docker compose --profile llm-gateway up -d --force-recreate --no-deps llm-gateway >/dev/null )
  else
    warn "no bare-metal (.env.local/.pids.runtime) state and no Docker llm-gateway container found."
    warn "config is written — restart your llm-gateway manually to apply it, then: curl :${GATEWAY_PORT}/llm/providers"
    return 0
  fi
  info "waiting for the gateway to come up…"
  local i body
  for i in $(seq 1 30); do
    body="$(curl -s -m 4 "http://localhost:${GATEWAY_PORT}/llm/providers" 2>/dev/null || true)"
    [ -n "$body" ] && break
    sleep 2
  done
  [ -n "$body" ] || die "gateway did not respond on :${GATEWAY_PORT} — check 'docker logs singularity-llm-gateway' or logs/llm-gateway.log"
  printf '%s' "$body" | python3 -c '
import sys, json
d = json.load(sys.stdin)
dp = d.get("default_provider")
provs = {p["name"]: p for p in d.get("providers", [])}
cop = provs.get("copilot", {})
print(f"   default_provider = {dp}")
ready = cop.get("ready")
allowed = cop.get("allowed")
model = cop.get("default_model")
print(f"   copilot: ready={ready} allowed={allowed} model={model}")
warnings = cop.get("warnings")
if warnings:
    print(f"   copilot warnings: {warnings}")
'
}

preflight_headless_http() {
  [ "$SKIP_PREFLIGHT" = "1" ] && { warn "skipping Copilot base URL preflight"; return 0; }
  local models_url="${BASE_URL%/}/models"
  info "checking Copilot headless HTTP endpoint: ${models_url}"
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx 'singularity-llm-gateway'; then
    local container_status
    container_status="$(docker exec -i singularity-llm-gateway python - "$models_url" <<'PY' 2>&1 || true
import sys, urllib.request
url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=6) as response:
        print(response.status)
except Exception as exc:
    print(f"ERROR {type(exc).__name__}: {exc}")
    sys.exit(1)
PY
)"
    if [ "$container_status" != "200" ]; then
      die "Copilot base URL is not reachable from the llm-gateway container (GET ${models_url} returned ${container_status:-no response})."
    fi
    ok "Copilot headless HTTP endpoint is reachable from llm-gateway"
    return 0
  fi

  warn "singularity-llm-gateway is not running; falling back to host-side preflight"
  local status
  status="$(curl -sS -m 6 -o /tmp/sg-copilot-models.$$ -w '%{http_code}' "$models_url" 2>/tmp/sg-copilot-curl.$$ || true)"
  if [ "$status" != "200" ]; then
    local err body
    err="$(cat /tmp/sg-copilot-curl.$$ 2>/dev/null || true)"
    body="$(head -c 300 /tmp/sg-copilot-models.$$ 2>/dev/null || true)"
    rm -f /tmp/sg-copilot-models.$$ /tmp/sg-copilot-curl.$$
    die "Copilot base URL is not an OpenAI-compatible HTTP endpoint (GET ${models_url} returned ${status:-no response}). ${err}${body:+ Body: $body}"
  fi
  rm -f /tmp/sg-copilot-models.$$ /tmp/sg-copilot-curl.$$
  ok "Copilot headless HTTP endpoint is reachable"
}

# ── restore ────────────────────────────────────────────────────────────────
if [ "$RESTORE" = "1" ]; then
  [ -f "$PROVIDERS.copilot-bak" ] || die "no backup found ($PROVIDERS.copilot-bak); nothing to restore"
  info "restoring previous LLM config from *.copilot-bak…"
  cp "$PROVIDERS.copilot-bak" "$PROVIDERS"
  cp "$CATALOG.copilot-bak"   "$CATALOG"
  ok "config restored"
  recreate_and_verify
  ok "done — gateway reverted to the pre-Copilot config"
  exit 0
fi

# ── flip to copilot ──────────────────────────────────────────────────────────
[ -n "$BASE_URL" ] || die "--base-url is required (e.g. http://host.docker.internal:4141/v1)"
[ -n "$MODEL" ]    || die "--model is required (e.g. gpt-4o)"
if [ -z "$TOKEN" ]; then
  [ "$GH_MODELS" = "1" ] && die "preset github-models needs a real GitHub PAT (models permission): pass --token <PAT>"
  TOKEN="copilot-local"; warn "no --token/\$COPILOT_TOKEN; using placeholder 'copilot-local' (fine if your server ignores auth)"
fi

preflight_headless_http

# Back up originals ONCE (so --restore returns to the true pre-Copilot state).
[ -f "$PROVIDERS.copilot-bak" ] || cp "$PROVIDERS" "$PROVIDERS.copilot-bak"
[ -f "$CATALOG.copilot-bak" ]   || cp "$CATALOG"   "$CATALOG.copilot-bak"
info "backups: $PROVIDERS.copilot-bak, $CATALOG.copilot-bak"

# 1) providers: add/enable copilot, make it the default.
BASE_URL="$BASE_URL" MODEL="$MODEL" python3 - "$PROVIDERS" <<'PY'
import json, os, sys
path = sys.argv[1]
cfg = json.load(open(path))
cfg["defaultProvider"] = "copilot"
cfg["defaultModel"] = os.environ["MODEL"]
allowed = cfg.setdefault("allowedProviders", [])
if "copilot" not in allowed: allowed.append("copilot")
cfg.setdefault("providers", {})["copilot"] = {
    "enabled": True,
    "baseUrl": os.environ["BASE_URL"].rstrip("/"),
    "credentialEnv": "COPILOT_TOKEN",
    "defaultModel": os.environ["MODEL"],
    "supportsTools": True,
    "costTier": "medium",
    "description": "GitHub Copilot headless (OpenAI-compatible) server.",
}
json.dump(cfg, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
ok "llm-providers.json → copilot enabled + default"

# 2) catalog: repoint EVERY alias to copilot/<model> so agent model_aliases
#    (claude-*, gpt-4o, …) all route through Copilot.
MODEL="$MODEL" python3 - "$CATALOG" <<'PY'
import json, os, sys
path = sys.argv[1]
models = json.load(open(path))
model = os.environ["MODEL"]
n = 0
for m in models:
    if isinstance(m, dict):
        m["provider"] = "copilot"
        m["model"] = model
        n += 1
# Add a clean, clearly-named alias for the model so the workbench's per-stage
# model picker shows the real Copilot model (e.g. "gpt-4o (Copilot)") instead of
# only the leftover "Mock …" labels — which confused operators into thinking the
# stack was still in mock mode after switching to Copilot.
alias_id = model.split("/")[-1]
if not any(isinstance(m, dict) and m.get("id") == alias_id for m in models):
    models.insert(0, {
        "id": alias_id,
        "label": f"{alias_id} (Copilot)",
        "provider": "copilot",
        "model": model,
        "default": False,
        "maxOutputTokens": 8000,
        "supportsTools": True,
        "costTier": "standard",
    })
    print(f"   added clean alias '{alias_id}' (Copilot)")
json.dump(models, open(path, "w"), indent=2)
open(path, "a").write("\n")
print(f"   repointed {n} model aliases → copilot/{model}")
PY
ok "llm-models.json → all aliases route to copilot (+ a clean '$MODEL' alias for the picker)"

# 3) secret: set COPILOT_TOKEN in the gitignored env_file the gateway reads.
touch "$SECRETS"
if grep -q '^COPILOT_TOKEN=' "$SECRETS" 2>/dev/null; then
  # portable in-place replace (BSD + GNU sed)
  python3 - "$SECRETS" "$TOKEN" <<'PY'
import sys, re
path, tok = sys.argv[1], sys.argv[2]
lines = open(path).read().splitlines()
out = [("COPILOT_TOKEN=" + tok) if l.startswith("COPILOT_TOKEN=") else l for l in lines]
open(path, "w").write("\n".join(out) + "\n")
PY
else
  printf 'COPILOT_TOKEN=%s\n' "$TOKEN" >> "$SECRETS"
fi
ok ".env.llm-secrets → COPILOT_TOKEN set"

# 4) recreate + verify.
recreate_and_verify

cat <<EOF

$(c 32 "✓ All LLM traffic now routes through Copilot.")
   provider  : copilot
   base URL  : ${BASE_URL%/}/chat/completions
   model     : ${MODEL}
   verify    : curl -s localhost:${GATEWAY_PORT}/llm/providers | python3 -m json.tool
   smoke     : curl -s -X POST localhost:${GATEWAY_PORT}/v1/chat/completions \\
                 -H 'content-type: application/json' \\
                 -d '{"model_alias":"${MODEL}","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
   revert    : bin/llm-use-copilot.sh --restore
EOF
