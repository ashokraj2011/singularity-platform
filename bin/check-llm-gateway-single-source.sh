#!/usr/bin/env bash
# M33 — CI guard.
#
# Enforces the governed LLM egress policy:
#   1. The gateway owns the normal provider route. Explicit Direct LLM nodes
#      are the only approved exception and may egress from Context Fabric or
#      WorkGraph through their dedicated clients.
#   2. MCP owns the normal runtime relay. A small, explicit list of platform
#      diagnostics/embedding helpers may call the gateway directly.
#   3. Provider API keys are read only by the gateway or the approved Direct
#      LLM client; UI labels and setup documentation are not credentials.
#   4. Only the gateway service reads provider API keys (OPENAI_API_KEY,
#      ANTHROPIC_API_KEY, OPENROUTER_API_KEY, COPILOT_TOKEN, GOOGLE_API_KEY,
#      COHERE_API_KEY).
#   4. No service-side TypeScript / Python file references the legacy
#      provider-router env vars (LLM_PROVIDER, EMBEDDING_PROVIDER, etc.).
#   5. No service hard-codes mock model aliases instead of letting the gateway
#      resolve its externally configured default alias.
#
# Fails with a clear diff when a regression sneaks in.
#
# Exit 0 → clean. Exit non-zero → at least one banned reference outside the
# gateway service.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
header() { printf '\n=== %s ===\n' "$*"; }

EXCLUDE_DIRS=(
  --exclude-dir=node_modules
  --exclude-dir=.git
  --exclude-dir=dist
  --exclude-dir=generated
  --exclude-dir=.next
  --exclude-dir=__pycache__
  --exclude-dir=.venv
)

# Always-excluded paths:
#  - The gateway service itself owns the provider HTTP + keys.
#  - bin/configure-platform.py is a config-write tool (no runtime LLM call).
#  - mcp-server/src/healthz-strict.ts checks for these very keys; mentioning
#    them in a guard is necessary, not a leak.
#  - Generated client outputs (dist/, generated/), docs, .env, and this
#    guard itself are out of scope.
PATH_FILTER='context-fabric/services/llm_gateway_service/|context-fabric/services/context_api_service/app/governed/direct_llm_client\.py|workgraph-studio/apps/api/src/modules/workflow/runtime/executors/DirectLlmTaskExecutor\.ts|workgraph-studio/apps/api/src/modules/workflow/runtime/executors/DirectLlmToolLoop\.ts|(^|/)docs/|(^|/)\.singularity/|(^|/)docker-compose\.yml:|(^|/)\.env(\.[^:]*)?:|bin/check-llm-gateway-single-source\.sh:|bin/configure-platform\.py:|mcp-server/src/healthz-strict\.ts:|(^|/)agent-and-tools/web/src/|(^|/)workgraph-studio/apps/web/src/|(^|/)clients/singularity-desktop/|/dist/|/generated/|\.md:'

# Explicit direct-provider egress is a node-level feature, not a general
# service escape hatch. Keep this list narrow so a new provider call still
# fails the guard until it is reviewed and added deliberately.
DIRECT_PROVIDER_PATHS='context-fabric/services/context_api_service/app/governed/direct_llm_client\.py|workgraph-studio/apps/api/src/modules/workflow/runtime/executors/DirectLlmTaskExecutor\.ts|workgraph-studio/apps/api/src/modules/workflow/runtime/executors/DirectLlmToolLoop\.ts'

# These callers do not own provider credentials; they call the configured
# gateway for diagnostics/embeddings and are intentionally not MCP relays.
#
# Infrastructure LLM calls (world-model distillation, claim lowering, judging,
# summarisation) are exempt from prompt-composer/context-fabric by policy — they
# are not agent turns and composing them through the agent-context pipeline is
# meaningless. They remain bound to the single tagged gateway (model_alias), so
# they belong here rather than in DIRECT_PROVIDER_PATHS. Agent/task turns get no
# such exemption: those must go composer + context-fabric + tagged gateway.
DIRECT_GATEWAY_PATHS='agent-and-tools/packages/shared/src/llm-gateway/|agent-and-tools/apps/agent-runtime/src/modules/capabilities/bootstrap-phase3-distill\.ts|claim-registry/src/lib/gateway\.ts|audit-governance-service/src/engine/|audit-governance-service/test/|tools/capability-harness/|tests/chaos/|context-fabric/services/context_api_service/app/governed/llm_client\.py|context-fabric/services/context_api_service/app/governed/turn\.py|context-fabric/services/context_api_service/app/laptop_registry\.py|bin/copilot-cli-server\.js'

# Lines that are pure comments (// /* * # docstrings) don't introduce a
# runtime call — strip them when grepping. Be a bit lenient (we strip only
# leading-whitespace-then-comment patterns).
strip_comment_lines() {
  # input: file:line:content   output: same, minus pure-comment lines
  awk -F: 'BEGIN { OFS=FS }
    {
      content = $0
      # rebuild content after the third colon (file:line:rest)
      n = index($0, ":");
      if (n) {
        rest = substr($0, n+1);
        m = index(rest, ":");
        if (m) {
          body = substr(rest, m+1);
          # Trim leading whitespace.
          sub(/^[[:space:]]+/, "", body);
          # Skip pure comment lines.
          if (body ~ /^(\/\/|#|\*|\/\*)/) next;
        }
      }
      print
    }'
}

run_grep_check() {
  local label="$1"; shift
  local pattern="$1"; shift
  local globs=(--include='*.ts' --include='*.tsx' --include='*.py' --include='*.js' --include='*.mjs' --include='*.cjs')
  set +e
  hits="$(grep -rEn "$pattern" "${globs[@]}" "${EXCLUDE_DIRS[@]}" . 2>/dev/null \
    | grep -vE "$PATH_FILTER" \
    | strip_comment_lines || true)"
  set -e
  if [[ -n "$hits" ]]; then
    red "FAIL: $label"
    echo "$hits" >&2
    return 1
  fi
  green "OK: $label"
  return 0
}

failures=0

header "1. Banned provider HTTP endpoints"
run_grep_check "no service opens api.openai.com / api.anthropic.com / openrouter.ai / cohere / google generative outside the gateway" \
  'api\.openai\.com|api\.anthropic\.com|openrouter\.ai|api\.cohere\.|generativelanguage\.googleapis\.com|api\.githubcopilot\.com' \
  || failures=$((failures + 1))

header "1b. MCP-only llm-gateway runtime egress"
set +e
direct_llm_hits="$(grep -rEn \
  --include='*.ts' --include='*.tsx' --include='*.py' --include='*.js' --include='*.mjs' --include='*.cjs' \
  "${EXCLUDE_DIRS[@]}" \
  '/v1/chat/completions|/v1/embeddings|/v1/models/resolve' \
  . 2>/dev/null \
  | grep -vE "context-fabric/services/llm_gateway_service/|(^|/)mcp-server/|(^|/)docs/|(^|/)\.singularity/|(^|/)\.agent-and-tools/web/src/|(^|/)agent-and-tools/web/src/|(^|/)workgraph-studio/apps/web/src/|(^|/)clients/singularity-desktop/|bin/check-llm-gateway-single-source\.sh:|/dist/|/generated/|\.md:|$DIRECT_GATEWAY_PATHS" \
  | strip_comment_lines || true)"
set -e
if [[ -n "$direct_llm_hits" ]]; then
  red "FAIL: non-MCP service calls llm-gateway runtime endpoint directly"
  echo "$direct_llm_hits" >&2
  failures=$((failures + 1))
else
  green "OK: llm-gateway runtime endpoints are only called by MCP"
fi

if grep -En 'api\.openai\.com|api\.anthropic\.com|openrouter\.ai|api\.githubcopilot\.com|text-embedding-3-small' \
  context-fabric/services/llm_gateway_service/app/provider_config.py \
  context-fabric/services/llm_gateway_service/app/router.py >/tmp/sg-gateway-fallbacks.$$ 2>/dev/null; then
  red "FAIL: llm-gateway contains hard-coded provider URL/model fallbacks"
  cat /tmp/sg-gateway-fallbacks.$$ >&2
  failures=$((failures + 1))
else
  green "OK: llm-gateway has no hard-coded provider URL/model fallback"
fi
rm -f /tmp/sg-gateway-fallbacks.$$

header "2. Banned provider credentials"
run_grep_check "no provider API keys are read outside the gateway" \
  "process\\.env\\.(OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|COPILOT_TOKEN|GOOGLE_API_KEY|COHERE_API_KEY)|process\\.env\\[[[:space:]]*[\\\"'](OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|COPILOT_TOKEN|GOOGLE_API_KEY|COHERE_API_KEY)[\\\"']|os\\.environ(\\.get)?\\([[:space:]]*[\\\"'](OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|COPILOT_TOKEN|GOOGLE_API_KEY|COHERE_API_KEY)[\\\"']" \
  || failures=$((failures + 1))

header "3. Banned provider-router env vars"
run_grep_check "no service still routes by LLM_PROVIDER / EMBEDDING_PROVIDER / SUMMARIZER_PROVIDER / CAPSULE_COMPILE_PROVIDER / DEFAULT_MODEL_PROVIDER" \
  '\b(LLM_PROVIDER|EMBEDDING_PROVIDER|SUMMARIZER_PROVIDER|CAPSULE_COMPILE_PROVIDER|DEFAULT_MODEL_PROVIDER)\b' \
  || failures=$((failures + 1))

header "3b. Caller override defaults"
if grep -En 'allow_caller_provider_override:\s*bool\s*=\s*True|ALLOW_CALLER_PROVIDER_OVERRIDE",\s*"true"' \
  context-fabric/services/llm_gateway_service/app/config.py >/tmp/sg-caller-override.$$ 2>/dev/null; then
  red "FAIL: caller provider/model override defaults to true"
  cat /tmp/sg-caller-override.$$ >&2
  failures=$((failures + 1))
else
  green "OK: caller provider/model override defaults false"
fi
rm -f /tmp/sg-caller-override.$$

header "3c. Hard-coded mock model aliases"
set +e
alias_hits="$(grep -rEn \
  --include='*.ts' --include='*.tsx' --include='*.py' --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.yml' --include='*.yaml' \
  "${EXCLUDE_DIRS[@]}" \
  '\b[A-Z0-9_]*MODEL_ALIAS\b.*(\?\?|\|\|)[[:space:]]*["'\''"]mock["'\''"]|\b[a-z0-9_]*model_alias\b[[:space:]]*:[[:space:]]*str[[:space:]]*=[[:space:]]*["'\''"]mock["'\''"]|MODEL_ALIAS.*:-mock' \
  . 2>/dev/null \
  | grep -vE "$PATH_FILTER|/(test|tests)/|\.github/workflows/compose-smoke\.yml:" \
  | strip_comment_lines || true)"
set -e
if [[ -n "$alias_hits" ]]; then
  red "FAIL: service-side mock model alias defaults found"
  echo "$alias_hits" >&2
  failures=$((failures + 1))
else
  green "OK: no service-side mock model alias defaults"
fi

header "4. docker-compose: provider keys appear only on llm-gateway"
# Inspect each service block in the merged compose config. Any service other
# than `llm-gateway` that surfaces a non-empty provider key is a leak.
if command -v docker >/dev/null 2>&1 && docker compose config >/dev/null 2>&1; then
  set +e
  leaks="$(docker compose config 2>/dev/null | awk '
    /^  [a-z][a-z0-9_-]*:$/ { svc=$1; sub(/:$/, "", svc) }
    svc != "llm-gateway" && /^      (OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|COPILOT_TOKEN|GOOGLE_API_KEY|COHERE_API_KEY):/ {
      # only flag non-empty values
      v = $0
      sub(/^.*: */, "", v)
      gsub(/^"|"$/, "", v)
      if (length(v) > 0) print svc ": " $0
    }
  ')"
  set -e
  if [[ -n "$leaks" ]]; then
    red "FAIL: provider keys leaked into non-gateway services in docker-compose"
    echo "$leaks" >&2
    failures=$((failures + 1))
  else
    green "OK: provider keys are gated to llm-gateway in docker-compose"
  fi
else
  echo "(skipped — docker compose not available)"
fi

header "5. Local .singularity provider policy"
python3 - <<'PY' || failures=$((failures + 1))
from __future__ import annotations

import json
from pathlib import Path

supported = {"mock", "copilot", "openai", "openrouter", "anthropic"}
failures: list[str] = []

providers_path = Path(".singularity/llm-providers.json")
if providers_path.exists():
    data = json.loads(providers_path.read_text())
    default = str(data.get("defaultProvider", "")).lower()
    if default and default not in supported:
        failures.append(f"{providers_path}: defaultProvider={default} is unsupported")
    allowlist = {str(x).lower() for x in data.get("allowedProviders", [])}
    disallowed = sorted(allowlist - supported)
    if disallowed:
        failures.append(f"{providers_path}: allowedProviders contains unsupported providers {disallowed}")
    providers = data.get("providers", {})
    if isinstance(providers, dict):
        for name, body in providers.items():
            provider = str(name).lower()
            if provider not in supported:
                failures.append(f"{providers_path}: provider {provider} is unsupported")
                continue
            if not isinstance(body, dict) or body.get("enabled") is False or provider == "mock":
                continue
            if not str(body.get("baseUrl", "")).strip():
                failures.append(f"{providers_path}: enabled provider {provider} is missing baseUrl")

catalog_path = Path(".singularity/llm-models.json")
if catalog_path.exists():
    catalog = json.loads(catalog_path.read_text())
    if isinstance(catalog, list):
        for row in catalog:
            if not isinstance(row, dict):
                failures.append(f"{catalog_path}: catalog row is not an object")
                continue
            alias = str(row.get("id") or "").strip()
            provider = str(row.get("provider") or "").lower()
            model = str(row.get("model") or "").strip()
            if not alias:
                failures.append(f"{catalog_path}: model alias row is missing id")
            if provider not in supported:
                failures.append(f"{catalog_path}: alias {alias or '(missing id)'} uses unsupported provider {provider or '(missing provider)'}")
            if not model:
                failures.append(f"{catalog_path}: alias {alias or '(missing id)'} is missing model")

if failures:
    for failure in failures:
        print(f"FAIL: {failure}")
    raise SystemExit(1)
print("OK: local .singularity provider/model config is explicit and gateway-owned")
PY

echo
if (( failures > 0 )); then
  red "M33 single-gateway guard failed: $failures issue(s)."
  exit 1
fi
green "M33 single-gateway guard passed."
exit 0
