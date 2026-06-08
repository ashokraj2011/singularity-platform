#!/usr/bin/env bash
#
# Switch the Singularity llm-gateway to GitHub Copilot / GitHub Models — or
# revert to Anthropic. Works for BOTH docker and baremetal deployments.
#
# Pure config: edits the two gateway config files + the gateway secret, then
# restarts the gateway (+ context-api) so they re-read the (cached) config.
#
#   ./switch-llm-to-copilot.sh --token <TOKEN>
#   ./switch-llm-to-copilot.sh --mode baremetal --token <TOKEN>
#   ./switch-llm-to-copilot.sh --endpoint copilot-editor --model gpt-4o --token <T>
#   ./switch-llm-to-copilot.sh --revert
#
# Deployment:
#   --mode <m>             docker | baremetal | auto   (default: auto-detect)
#   --providers-config P   path to llm-providers.json  (default: ./.singularity, or $LLM_PROVIDER_CONFIG_PATH on baremetal)
#   --models-config P      path to llm-models.json     (default: ./.singularity, or $LLM_MODEL_CATALOG_PATH on baremetal)
#   --env-file P           secrets file for COPILOT_TOKEN (default: ./.env.llm-secrets)
#   --gateway-url U        gateway base url for verify  (default: http://localhost:8001)
#   --restart-cmd "CMD"    explicit restart command (overrides mode default)
#   --gateway-unit U       systemd unit (baremetal)     (default: singularity-llm-gateway)
#   --context-unit U       systemd unit (baremetal)     (default: singularity-context-api)
#   --mcp-unit U           systemd unit (baremetal)     (default: singularity-mcp-server)
#
# Provider:
#   --token <T>            token → written to the env file (or export COPILOT_TOKEN)
#   --endpoint <e>         github-models (default) | copilot-editor
#   --model <m>            model id (default per endpoint)
#   --no-default           add copilot but DON'T make it the platform default
#   --no-restart           edit config only; don't restart anything
#   --revert               restore Anthropic (Haiku) as the default
#   -h | --help
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# defaults
MODE="auto"; PROVIDERS_FLAG=""; MODELS_FLAG=""; ENVFILE_FLAG=""
GATEWAY_URL="http://localhost:8001"; RESTART_CMD=""
GATEWAY_UNIT="singularity-llm-gateway"; CONTEXT_UNIT="singularity-context-api"; MCP_UNIT="singularity-mcp-server"
ENDPOINT="github-models"; MODEL=""; TOKEN="${COPILOT_TOKEN:-}"
MAKE_DEFAULT=1; RESTART=1; REVERT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)             MODE="${2:-}"; shift 2 ;;
    --providers-config) PROVIDERS_FLAG="${2:-}"; shift 2 ;;
    --models-config)    MODELS_FLAG="${2:-}"; shift 2 ;;
    --env-file)         ENVFILE_FLAG="${2:-}"; shift 2 ;;
    --gateway-url)      GATEWAY_URL="${2:-}"; shift 2 ;;
    --restart-cmd)      RESTART_CMD="${2:-}"; shift 2 ;;
    --gateway-unit)     GATEWAY_UNIT="${2:-}"; shift 2 ;;
    --context-unit)     CONTEXT_UNIT="${2:-}"; shift 2 ;;
    --mcp-unit)         MCP_UNIT="${2:-}"; shift 2 ;;
    --token)            TOKEN="${2:-}"; shift 2 ;;
    --endpoint)         ENDPOINT="${2:-}"; shift 2 ;;
    --model)            MODEL="${2:-}"; shift 2 ;;
    --no-default)       MAKE_DEFAULT=0; shift ;;
    --no-restart)       RESTART=0; shift ;;
    --revert)           REVERT=1; shift ;;
    -h|--help)          grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null || { echo "ERROR: jq is required (brew install jq / apt-get install jq)"; exit 1; }
command -v curl >/dev/null || { echo "ERROR: curl is required"; exit 1; }

compose() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }

# ── deployment mode ─────────────────────────────────────────────────────────
if [ "$MODE" = "auto" ]; then
  if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'singularity-llm-gateway'; then
    MODE="docker"
  else
    MODE="baremetal"
  fi
fi
[ "$MODE" = "docker" ] || [ "$MODE" = "baremetal" ] || { echo "ERROR: --mode must be docker | baremetal | auto"; exit 2; }

# ── resolve config paths (docker → mounted source; baremetal → env or source) ─
resolve() { # $1 flag  $2 envvar-value  $3 default
  if [ -n "$1" ]; then echo "$1"
  elif [ "$MODE" = "baremetal" ] && [ -n "$2" ] && [ -f "$2" ]; then echo "$2"
  else echo "$3"; fi
}
PROVIDERS="$(resolve "$PROVIDERS_FLAG" "${LLM_PROVIDER_CONFIG_PATH:-}" "$ROOT/.singularity/llm-providers.json")"
MODELS="$(resolve "$MODELS_FLAG" "${LLM_MODEL_CATALOG_PATH:-}" "$ROOT/.singularity/llm-models.json")"
SECRETS="${ENVFILE_FLAG:-$ROOT/.env.llm-secrets}"

[ -f "$PROVIDERS" ] || { echo "ERROR: providers config not found: $PROVIDERS (use --providers-config)"; exit 1; }
[ -f "$MODELS" ]    || { echo "ERROR: models config not found: $MODELS (use --models-config)"; exit 1; }
echo "● mode=$MODE  providers=$PROVIDERS  models=$MODELS  env-file=$SECRETS"

stamp="$(date +%Y%m%d-%H%M%S)"
backup() { [ -f "$1" ] && cp "$1" "$1.bak.$stamp" || true; }

verify() {
  echo "⏳ waiting for gateway health at $GATEWAY_URL …"
  for _ in $(seq 1 30); do curl -fsS "$GATEWAY_URL/health" >/dev/null 2>&1 && break || sleep 1; done
  echo "── $GATEWAY_URL/llm/providers ──"
  curl -fsS "$GATEWAY_URL/llm/providers" 2>/dev/null | jq '.' 2>/dev/null \
    || echo "(gateway not reachable at $GATEWAY_URL — check it's running, or pass --gateway-url)"
}

restart() {
  [ "$RESTART" = "1" ] || { echo "↷ skipping restart (--no-restart). Restart the gateway + context-api to apply."; return; }
  # llm-gateway routes providers; context-api + mcp-server (Agent Execution
  # Runtime) also read the same provider/model config — restart all that exist.
  if [ -n "$RESTART_CMD" ]; then
    echo "↻ custom restart: $RESTART_CMD"; bash -c "$RESTART_CMD"
  elif [ "$MODE" = "docker" ]; then
    have=""; svcs="$(compose --profile full config --services 2>/dev/null || true)"
    for s in llm-gateway context-api mcp-server; do printf '%s\n' "$svcs" | grep -qx "$s" && have="$have $s"; done
    [ -n "$have" ] || have=" llm-gateway context-api"
    echo "↻ docker: recreating$have …"
    compose --profile full up -d --force-recreate $have
  else
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "^${GATEWAY_UNIT}"; then
      units=""; for u in "$GATEWAY_UNIT" "$CONTEXT_UNIT" "$MCP_UNIT"; do systemctl list-unit-files 2>/dev/null | grep -q "^${u}" && units="$units $u"; done
      echo "↻ systemd: restarting$units …"
      sudo systemctl restart $units || echo "  (systemctl restart failed — restart manually)"
    else
      echo "⚠️  baremetal: restart the gateway + context-api + mcp-server so they re-read config (cached at load):"
      echo "      • systemd:  sudo systemctl restart $GATEWAY_UNIT $CONTEXT_UNIT $MCP_UNIT"
      echo "      • pm2:      pm2 restart llm-gateway context-api mcp-server"
      echo "      • CLI:      ./singularity.sh restart mcp-server   # + restart the gateway + context-api"
      echo "      • or re-run with: --restart-cmd \"<your restart command>\""
    fi
  fi
  verify
}

# ── revert ──────────────────────────────────────────────────────────────────
if [ "$REVERT" = "1" ]; then
  echo "⟲ reverting to Anthropic (Haiku) default …"
  backup "$PROVIDERS"; backup "$MODELS"
  jq '
    .defaultProvider = "anthropic" | .defaultModel = "claude-haiku-4-5-20251001"
    | .allowedProviders = ((.allowedProviders // []) - ["copilot"])
    | (if .providers.copilot then .providers.copilot.enabled = false else . end)
  ' "$PROVIDERS" > "$PROVIDERS.tmp" && mv "$PROVIDERS.tmp" "$PROVIDERS"
  jq '
    map(if .id=="copilot" then {
      id:"copilot", label:"Compatibility alias: Copilot -> Anthropic Claude Haiku",
      provider:"anthropic", model:"claude-haiku-4-5-20251001", default:false,
      maxOutputTokens:8000, supportsTools:true, costTier:"low",
      description:"Backward-compatible alias; routes through Anthropic.",
      inputPricePerMtok:1.0, outputPricePerMtok:5.0 } else . end)
    | map(.default = (.id=="claude-haiku-4-5-20251001"))
  ' "$MODELS" > "$MODELS.tmp" && mv "$MODELS.tmp" "$MODELS"
  echo "✓ reverted (backups: *.bak.$stamp)"; restart; exit 0
fi

# ── switch to copilot ───────────────────────────────────────────────────────
case "$ENDPOINT" in
  github-models)  BASEURL="https://models.github.ai/inference"; [ -n "$MODEL" ] || MODEL="openai/gpt-4o" ;;
  copilot-editor) BASEURL="https://api.githubcopilot.com";       [ -n "$MODEL" ] || MODEL="gpt-4o"
                  echo "⚠️  copilot-editor: api.githubcopilot.com also needs Editor-Version / Copilot-Integration-Id headers,"
                  echo "    which the openai_compat adapter does not yet send — it will 400/403 without an adapter tweak." ;;
  *) echo "ERROR: --endpoint must be github-models or copilot-editor"; exit 2 ;;
esac
echo "→ provider=copilot  endpoint=$ENDPOINT  baseUrl=$BASEURL  model=$MODEL  default=$([ $MAKE_DEFAULT = 1 ] && echo yes || echo no)"

# 1) token → env file (never echoed)
if [ -n "$TOKEN" ]; then
  backup "$SECRETS"; [ -f "$SECRETS" ] || touch "$SECRETS"
  if grep -q '^COPILOT_TOKEN=' "$SECRETS"; then
    awk -v v="$TOKEN" '/^COPILOT_TOKEN=/{print "COPILOT_TOKEN=" v; next} {print}' "$SECRETS" > "$SECRETS.tmp" && mv "$SECRETS.tmp" "$SECRETS"
  else
    printf 'COPILOT_TOKEN=%s\n' "$TOKEN" >> "$SECRETS"
  fi
  echo "✓ COPILOT_TOKEN written to $SECRETS"
  [ "$MODE" = "baremetal" ] && echo "  (baremetal: ensure the gateway process loads $SECRETS — e.g. systemd EnvironmentFile, or source it before start)"
elif ! grep -qE '^COPILOT_TOKEN=.+' "$SECRETS" 2>/dev/null; then
  echo "⚠️  no token provided and COPILOT_TOKEN is empty — provider will report 'not ready' (503) until set."
fi

# 2) providers.json
backup "$PROVIDERS"
jq --arg base "$BASEURL" --arg model "$MODEL" --argjson mkdef "$MAKE_DEFAULT" '
  .allowedProviders = (((.allowedProviders // []) + ["copilot"]) | unique)
  | .providers.copilot = {
      enabled:true, baseUrl:$base, credentialEnv:"COPILOT_TOKEN",
      defaultModel:$model, supportsTools:true, costTier:"medium",
      description:"GitHub Copilot / GitHub Models (OpenAI-compatible)." }
  | (if $mkdef==1 then .defaultProvider="copilot" | .defaultModel=$model else . end)
' "$PROVIDERS" > "$PROVIDERS.tmp" && mv "$PROVIDERS.tmp" "$PROVIDERS"

# 3) models.json — repoint the `copilot` alias
backup "$MODELS"
jq --arg model "$MODEL" --argjson mkdef "$MAKE_DEFAULT" '
  ( [ .[] | select(.id=="copilot") ] | length ) as $has
  | ( { id:"copilot", label:"GitHub Copilot", provider:"copilot", model:$model,
        default:false, maxOutputTokens:8000, supportsTools:true, costTier:"medium",
        description:"GitHub Copilot / GitHub Models (OpenAI-compatible)." } ) as $entry
  | map(if .id=="copilot" then $entry else . end)
  | (if $has==0 then . + [$entry] else . end)
  | (if $mkdef==1 then map(.default = (.id=="copilot")) else . end)
' "$MODELS" > "$MODELS.tmp" && mv "$MODELS.tmp" "$MODELS"

jq -e . "$PROVIDERS" >/dev/null && jq -e . "$MODELS" >/dev/null
echo "✓ config updated (backups: *.bak.$stamp)"
echo "  • allowedProviders: $(jq -c '.allowedProviders' "$PROVIDERS")"
echo "  • default: $(jq -r '.defaultProvider+" / "+.defaultModel' "$PROVIDERS")"
restart
echo "✓ done."
