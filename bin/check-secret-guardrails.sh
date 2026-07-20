#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
warn=0

fail_msg() {
  echo "FAIL $*" >&2
  fail=1
}

warn_msg() {
  echo "WARN $*" >&2
  warn=1
}

tracked_file() {
  git ls-files --error-unmatch "$1" >/dev/null 2>&1
}

local_only_patterns=(
  ".env"
  ".singularity/config.local.json"
  ".singularity/llm-providers.json"
  ".singularity/llm-models.json"
  ".singularity/git-credentials"
)

while IFS= read -r -d '' file; do
  case "$file" in
    .singularity/*.env|.singularity/secrets/*|.singularity/keys/*|*.pem|*.key|id_rsa|id_ed25519)
      fail_msg "tracked local-only secret material: $file"
      ;;
  esac
done < <(git ls-files -z)

for file in "${local_only_patterns[@]}"; do
  if tracked_file "$file"; then
    fail_msg "tracked local-only config file: $file"
  fi
done

scan_regex='(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}|sk-ant-[A-Za-z0-9_-]{20,}|Bearer[[:space:]]+[A-Za-z0-9._~+/=-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|https?://[^[:space:]/:@]+:[^[:space:]@/]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----)'

allowed_secret_hit() {
  local file="$1"
  local line="$2"

  case "$file" in
    README.md|test-mcp.sh|test-mcp-approval.sh)
      [[ "$line" == *"demo-bearer-token-must-be-min-16-chars"* ]] && return 0
      ;;
	  singularity-code-foundry/apps/code-foundry-api/src/patchGuard/secretScan.ts)
	    [[ "$line" == *"/-----BEGIN PRIVATE KEY-----/"* ]] && return 0
	    ;;
    context-fabric/tests/test_governed_turn.py)
      [[ "$line" == *"Bearer abcdef0123456789ABCDEF"* ]] && return 0
      [[ "$line" == *"ghp_0123456789abcdefghijABCDEF"* ]] && return 0
      ;;
	  bin/check-secret-guardrails.sh)
	    [[ "$line" == *"PRIVATE KEY"* ]] && return 0
	    ;;
	  esac

  return 1
}

while IFS= read -r -d '' file; do
  case "$file" in
    bin/check-secret-guardrails.sh)
      continue
      ;;
    package-lock.json|pnpm-lock.yaml|yarn.lock)
      continue
      ;;
  esac
  if LC_ALL=C grep -E -n "$scan_regex" "$file" >/tmp/singularity-secret-hit.$$ 2>/dev/null; then
    unallowed_hits=()
    while IFS= read -r hit; do
      if ! allowed_secret_hit "$file" "$hit"; then
        unallowed_hits+=("$hit")
      fi
    done </tmp/singularity-secret-hit.$$
    if [[ "${#unallowed_hits[@]}" -gt 0 ]]; then
      fail_msg "secret-shaped value in tracked file: $file"
      printf '%s\n' "${unallowed_hits[@]:0:3}" >&2
    fi
  fi
done < <(git ls-files -z)
rm -f /tmp/singularity-secret-hit.$$

strip_quotes() {
  local value="$1"
  value="${value%%#*}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

secret_shaped_value() {
  local value="$1"
  [[ "$value" =~ (REPLACE_ME|PLACEHOLDER|example|EXAMPLE|\<.*\>|\.\.\.) ]] && return 1
  [[ "$value" =~ ^(gh[pousr]_|github_pat_|sk-|sk-ant-|sk-proj-) ]] && return 0
  [[ "$value" =~ ^Bearer[[:space:]]+ ]] && return 0
  [[ "$value" =~ ^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$ ]] && return 0
  [[ "$value" =~ ^https?://[^/[:space:]:@]+:[^@/[:space:]]+@ ]] && return 0
  [[ "$value" =~ "-----BEGIN "*"PRIVATE KEY-----" ]] && return 0
  return 1
}

is_weak_dev_secret() {
  local value="$1"
  [[ -z "$value" ]] && return 0
  [[ "$value" =~ ^(change-me|changeme|dev-|test-) ]] && return 0
  case "$value" in
    Admin1234!|change-me-in-production|change-me-now|changeme_dev_only_min_32_chars_long!!|dev-secret-change-in-prod-min-32-chars!!|demo-bearer-token-must-be-min-16-chars)
      return 0
      ;;
  esac
  return 1
}

env_value() {
  local file="$1" key="$2"
  awk -F= -v k="$key" '
    $0 !~ /^[[:space:]]*(#|$)/ {
      gsub(/^export[[:space:]]+/, "", $1)
      if ($1 == k) {
        sub(/^[^=]*=/, "", $0)
        print $0
      }
    }
  ' "$file" | tail -n 1
}

scan_env_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0

  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    warn_msg "duplicate key in local env file: $file:$key"
  done < <(awk -F= '
    $0 !~ /^[[:space:]]*(#|$)/ {
      gsub(/^export[[:space:]]+/, "", $1)
      count[$1] += 1
    }
    END {
      for (key in count) if (count[key] > 1) print key
    }
  ' "$file")

  local app_env environment node_env singularity_env prod_like
  app_env="$(strip_quotes "$(env_value "$file" APP_ENV)")"
  environment="$(strip_quotes "$(env_value "$file" ENVIRONMENT)")"
  node_env="$(strip_quotes "$(env_value "$file" NODE_ENV)")"
  singularity_env="$(strip_quotes "$(env_value "$file" SINGULARITY_ENV)")"
  prod_like=0
  local env_joined
  env_joined="$(printf '%s,%s,%s,%s' "$app_env" "$environment" "$node_env" "$singularity_env" | tr '[:upper:]' '[:lower:]')"
  case "$env_joined" in
    *prod*|*production*|*staging*) prod_like=1 ;;
  esac

  local key raw value
  while IFS= read -r key; do
    raw="$(env_value "$file" "$key")"
    value="$(strip_quotes "$raw")"
    [[ -n "$value" ]] || continue

    case "$file:$key" in
      .env:GITHUB_TOKEN|.env:GH_TOKEN|.env:MCP_GIT_TOKEN|.env:OPENAI_API_KEY|.env:OPENROUTER_API_KEY|.env:ANTHROPIC_API_KEY|.env:COPILOT_TOKEN|.env:COPILOT_PROVIDER_API_KEY|.env:AWS_SECRET_ACCESS_KEY|.env.local:GITHUB_TOKEN|.env.local:GH_TOKEN|.env.local:MCP_GIT_TOKEN|.env.local:OPENAI_API_KEY|.env.local:OPENROUTER_API_KEY|.env.local:ANTHROPIC_API_KEY|.env.local:COPILOT_TOKEN|.env.local:COPILOT_PROVIDER_API_KEY|.env.local:AWS_SECRET_ACCESS_KEY)
        if secret_shaped_value "$value"; then
          fail_msg "broad root env file contains credential material: $file:$key (move provider keys to .env.llm-secrets and git tokens to .env.laptop or mcp-server/.env)"
        fi
        ;;
    esac

    if [[ "$key" =~ (JWT_SECRET|SERVICE_TOKEN|BEARER_TOKEN|SIGNING_SECRET|SESSION_SECRET|SUPER_ADMIN_PASSWORD)$ ]]; then
      if [[ "$prod_like" -eq 1 ]] && is_weak_dev_secret "$value"; then
        fail_msg "production-class local env uses weak/default secret: $file:$key"
      elif is_weak_dev_secret "$value"; then
        warn_msg "development default secret in local env: $file:$key"
      fi
    fi
  done < <(awk -F= '
    $0 !~ /^[[:space:]]*(#|$)/ {
      gsub(/^export[[:space:]]+/, "", $1)
      print $1
    }
  ' "$file" | sort -u)
}

local_env_files=(
  ".env"
  ".env.local"
  ".env.laptop"
  ".env.llm-secrets"
  "mcp-server/.env"
  "agent-and-tools/web/.env.local"
  "singularity-iam-service/.env"
)

for file in "${local_env_files[@]}"; do
  scan_env_file "$file"
done

# ── Provider-key custody across compose files ───────────────────────────────
#
# llm_gateway_service/app/config.py claimed for a long time that the gateway is
# "the ONLY place provider keys are read". It was not: docker-compose.yml hands
# OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY to context-api too. A
# docstring is not a control, so this is the control.
#
# The rule: no service block in any compose file may receive a provider key,
# except the ones named below. Adding a key to a new service now fails CI
# instead of quietly widening the blast radius of a credential leak.
#
# WHY THE GATEWAY IS NOT IN THE ALLOWLIST AS A REQUIREMENT. It is allowed, but
# it does not actually declare these keys inline: M53 moved them to
# `.env.llm-secrets` via `env_file:`, precisely because compose's `environment:`
# block OVERRIDES `env_file:` and an empty var in the operator's shell was
# shadowing real values on every recreate. So the gateway block legitimately has
# ZERO provider keys in it, and asserting their presence would fight that fix.
# This check therefore bounds WHO MAY have them, not who must.
PROVIDER_KEY_RE='(OPENAI_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|COPILOT_PROVIDER_API_KEY|COPILOT_TOKEN|AZURE_OPENAI_API_KEY|GEMINI_API_KEY|MISTRAL_API_KEY|COHERE_API_KEY)'

# service name -> why it is allowed. Keep this list SHORT and justified; each
# entry is a service whose process can read a provider credential.
provider_key_allowed_service() {
  case "$1" in
    # The gateway itself. This is the intended custodian.
    llm-gateway|singularity-llm-gateway)
      return 0 ;;
    # NAMED EXCEPTION (tracked). context-api holds provider keys for the CF
    # direct-provider hatch in governed/direct_llm_client.py. The hatch is shut
    # unless CF_ALLOW_DIRECT_LLM is set, but the keys are in the process either
    # way, so this is a real second custodian and is recorded as one rather than
    # explained away. Closing it means deleting those keys from the context-api
    # block and retiring the hatch -- at which point this entry should go too.
    context-api)
      return 0 ;;
  esac
  return 1
}

scan_compose_provider_keys() {
  local file="$1"
  [[ -f "$file" ]] || return 0

  # Attribute each provider-key line to its enclosing service block. Compose
  # service names sit at a fixed indent directly under `services:`; anything
  # deeper belongs to the service last seen. Lines outside `services:` (YAML
  # anchors, x-extensions) are reported under a synthetic name so they cannot
  # slip through unattributed.
  while IFS='|' read -r lineno service key; do
    [[ -n "$key" ]] || continue
    if ! provider_key_allowed_service "$service"; then
      fail_msg "provider key outside the gateway custody boundary: $file:$lineno service='$service' key=$key (only llm-gateway may hold provider keys; context-api is the one tracked exception)"
    fi
  done < <(awk -v keyre="$PROVIDER_KEY_RE" '
    # Enter/leave the top-level services: mapping.
    /^services:[[:space:]]*$/ { in_services = 1; service = ""; service_indent = -1; next }
    /^[^[:space:]#]/ { if ($0 !~ /^services:/) { in_services = 0; service = "" } }

    {
      line = $0
      if (line ~ /^[[:space:]]*#/) next

      # A service name: the shallowest non-comment mapping key inside services:.
      if (in_services && match(line, /^[[:space:]]+/)) {
        indent = RLENGTH
        if (line ~ /^[[:space:]]+[A-Za-z0-9_.-]+:[[:space:]]*$/) {
          if (service_indent == -1 || indent < service_indent) {
            service_indent = indent
          }
          if (indent == service_indent) {
            name = line
            sub(/^[[:space:]]+/, "", name)
            sub(/:[[:space:]]*$/, "", name)
            service = name
          }
        }
      }

      # A provider key ASSIGNMENT. Anchored on "KEY:" at line start (after
      # indent) so a key NAME appearing inside a value -- e.g.
      # CONTEXT_FABRIC_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS: ${...:-OPENAI_API_KEY,...}
      # -- is correctly NOT treated as handing that service the key.
      if (match(line, /^[[:space:]]*-?[[:space:]]*[A-Za-z0-9_]+[[:space:]]*[:=]/)) {
        assigned = line
        sub(/^[[:space:]]*-?[[:space:]]*/, "", assigned)
        sub(/[[:space:]]*[:=].*$/, "", assigned)
        if (assigned ~ "^" keyre "$") {
          printf "%d|%s|%s\n", NR, (service == "" ? "(top-level)" : service), assigned
        }
      }
    }
  ' "$file")
}

while IFS= read -r compose_file; do
  scan_compose_provider_keys "$compose_file"
done < <(git ls-files | grep -E '(^|/)docker-compose[^/]*\.ya?ml$' || true)

if [[ "$fail" -ne 0 ]]; then
  echo "Secret guardrails failed. Move secrets to ignored local env/key files and commit only references such as env var names." >&2
  exit 1
fi

if [[ "$warn" -ne 0 ]]; then
  echo "OK secret guardrails passed with warnings"
  echo "Hint: run ./singularity.sh config rotate-secrets to replace development JWT/service/runtime defaults." >&2
else
  echo "OK secret guardrails passed"
fi
