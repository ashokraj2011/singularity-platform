#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0

tracked_file() {
  git ls-files --error-unmatch "$1" >/dev/null 2>&1
}

local_only_patterns=(
  ".env"
  ".singularity/config.local.json"
  ".singularity/llm-providers.json"
  ".singularity/mcp-models.json"
  ".singularity/git-credentials"
)

while IFS= read -r -d '' file; do
  case "$file" in
    .singularity/*.env|.singularity/secrets/*|.singularity/keys/*|*.pem|*.key|id_rsa|id_ed25519)
      echo "FAIL tracked local-only secret material: $file" >&2
      fail=1
      ;;
  esac
done < <(git ls-files -z)

for file in "${local_only_patterns[@]}"; do
  if tracked_file "$file"; then
    echo "FAIL tracked local-only config file: $file" >&2
    fail=1
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
      echo "FAIL secret-shaped value in tracked file: $file" >&2
      printf '%s\n' "${unallowed_hits[@]:0:3}" >&2
      fail=1
    fi
  fi
done < <(git ls-files -z)
rm -f /tmp/singularity-secret-hit.$$

if [[ "$fail" -ne 0 ]]; then
  echo "Secret guardrails failed. Move secrets to ignored local env/key files and commit only references such as env var names." >&2
  exit 1
fi

echo "OK secret guardrails passed"
