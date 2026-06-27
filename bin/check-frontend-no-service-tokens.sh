#!/usr/bin/env bash
# M100 P0 — CI guard: no service tokens baked into frontend browser builds.
#
# Browser-facing frontend source must not embed shared service credentials.
# A service-token LITERAL, build-time VITE_*_TOKEN, or NEXT_PUBLIC_*_TOKEN
# reference is a credential leak — anyone can read it in DevTools. Service
# tokens must be injected server-side through same-origin proxies.
#
# This guard fails the build if a frontend src/ file contains:
#   1. a literal "*-service-token" string, or
#   2. a `VITE_*_TOKEN` or `NEXT_PUBLIC_*_TOKEN` reference.
#
# The browser may still hold the USER's auth JWT (access_token / id_token in
# localStorage from a login flow) — that's the user's own credential, not a
# shared service token, so those patterns are NOT matched here.
#
# Scope: frontend app source trees only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Browser-facing source dirs to scan. For Next.js, exclude server-only API
# routes and the server env guard; service defaults there are checked by
# server-side production guardrails, not shipped to browser bundles.
DIRS=(
  "agent-and-tools/web/src"
  "workgraph-studio/apps/blueprint-workbench/src"
  "workgraph-studio/apps/web/src"
)

RG_EXCLUDES=(
  --glob '!agent-and-tools/web/src/app/api/**'
  --glob '!agent-and-tools/web/src/lib/serverEnvGuard.ts'
)

# Patterns that indicate a baked-in service credential.
#  - <word>-service-token literal (e.g. dev-audit-gov-service-token)
#  - VITE_<NAME>_TOKEN or NEXT_PUBLIC_<NAME>_TOKEN (build-time embeds)
PATTERN='[a-z0-9-]+-service-token|VITE_[A-Z0-9_]*TOKEN|NEXT_PUBLIC_[A-Z0-9_]*TOKEN'

violations=0
for d in "${DIRS[@]}"; do
  [ -d "$d" ] || continue
  # rg if available, else grep -rE. Exclude comments is NOT done — a commented
  # token is still in the shipped bundle text, so we flag it too.
  if command -v rg >/dev/null 2>&1; then
    hits=$(rg -n --no-heading "${RG_EXCLUDES[@]}" -e "$PATTERN" "$d" 2>/dev/null || true)
  else
    hits=$(find "$d" \
      -path 'agent-and-tools/web/src/app/api' -prune -o \
      -path 'agent-and-tools/web/src/lib/serverEnvGuard.ts' -prune -o \
      -type f -print0 | xargs -0 grep -nE "$PATTERN" 2>/dev/null || true)
  fi
  if [ -n "$hits" ]; then
    echo "FAIL: service-token / VITE_*_TOKEN literal found in $d:" >&2
    echo "$hits" | sed -E 's#(service-token).*#\1 …(redacted)#' >&2
    violations=$((violations + 1))
  fi
done

if [ "$violations" -gt 0 ]; then
  cat >&2 <<'EOF'

Frontend bundles must not embed service tokens. Route privileged calls through
a same-origin proxy that injects Authorization server-side. The user's own auth
JWT is fine; shared service tokens are not.
EOF
  exit 1
fi

audit_proxy="agent-and-tools/web/src/app/api/audit-gov/[...path]/route.ts"
codegen_proxy="agent-and-tools/web/src/app/api/codegen/[...path]/route.ts"
composer_proxy="agent-and-tools/web/src/app/api/composer/[...path]/route.ts"
composer_shared="agent-and-tools/web/src/app/api/prompt-workbench/_shared/composer.ts"
proxy_guard_failures=0

if [ -f "$audit_proxy" ]; then
  if ! grep -F 'headers.delete("authorization")' "$audit_proxy" >/dev/null || \
     ! grep -F 'headers.set("authorization", `Bearer ${token}`)' "$audit_proxy" >/dev/null; then
    echo "FAIL: audit-governance proxy must strip browser Authorization and inject AUDIT_GOV_SERVICE_TOKEN server-side." >&2
    proxy_guard_failures=$((proxy_guard_failures + 1))
  fi
else
  echo "FAIL: missing audit-governance server proxy: $audit_proxy" >&2
  proxy_guard_failures=$((proxy_guard_failures + 1))
fi

if [ -f "$codegen_proxy" ]; then
  if ! grep -F 'WORKGRAPH_API_URL' "$codegen_proxy" >/dev/null || \
     grep -E 'FOUNDRY_TOKEN|CODEGEN_SERVICE_TOKEN|CODE_FOUNDRY_API_URL' "$codegen_proxy" >/dev/null; then
    echo "FAIL: Code generation proxy must route to Workgraph and must not require Foundry/codegen service tokens." >&2
    proxy_guard_failures=$((proxy_guard_failures + 1))
  fi
else
  echo "FAIL: missing Code Foundry server proxy: $codegen_proxy" >&2
  proxy_guard_failures=$((proxy_guard_failures + 1))
fi

if [ -f "$composer_proxy" ] && [ -f "$composer_shared" ]; then
  if ! grep -F 'composerAuthHeaders' "$composer_proxy" >/dev/null || \
     ! grep -F 'process.env.PROMPT_COMPOSER_SERVICE_TOKEN' "$composer_shared" >/dev/null || \
     ! grep -F 'process.env.WORKGRAPH_PROXY_SERVICE_TOKEN' "$composer_shared" >/dev/null; then
    echo "FAIL: Prompt Composer proxy must inject PROMPT_COMPOSER_SERVICE_TOKEN/WORKGRAPH_PROXY_SERVICE_TOKEN server-side." >&2
    proxy_guard_failures=$((proxy_guard_failures + 1))
  fi
else
  echo "FAIL: missing Prompt Composer server proxy: $composer_proxy" >&2
  proxy_guard_failures=$((proxy_guard_failures + 1))
fi

if [ "$proxy_guard_failures" -gt 0 ]; then
  cat >&2 <<'EOF'

Privileged backend hops must not leak shared credentials into browser bundles.
Service-token-gated APIs should use server-held credentials; Workgraph-owned
user routes such as /api/codegen should keep the verified user Authorization.
EOF
  exit 1
fi

echo "OK — no service-token / VITE_*_TOKEN / NEXT_PUBLIC_*_TOKEN literals in frontend src."
