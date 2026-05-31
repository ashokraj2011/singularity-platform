#!/usr/bin/env bash
# M100 P0 — CI guard: no service tokens baked into frontend browser builds.
#
# Frontend `src/` ships to the browser. A service-token LITERAL (or a
# build-time VITE_*_TOKEN that embeds one into the bundle) is a credential
# leak — anyone can read it in DevTools. Service tokens must be injected
# server-side (a same-origin proxy: Vite dev proxy / nginx prod conf /
# workgraph-api passthrough), never carried by the client.
#
# This guard fails the build if a frontend src/ file contains:
#   1. a literal "*-service-token" string, or
#   2. a `VITE_*_TOKEN` reference (build-time token embedding).
#
# The browser may still hold the USER's auth JWT (access_token / id_token in
# localStorage from a login flow) — that's the user's own credential, not a
# shared service token, so those patterns are NOT matched here.
#
# Scope: frontend app source trees only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Frontend src dirs to scan. All fixed under M100 P0 — service tokens are
# injected server-side by each app's proxy, never baked into the bundle.
DIRS=(
  "singularity-portal/src"
  "workgraph-studio/apps/blueprint-workbench/src"
  "workgraph-studio/apps/web/src"
  "singularity-code-foundry/apps/code-foundry-web/src"
)

# Patterns that indicate a baked-in service credential.
#  - <word>-service-token literal (e.g. dev-audit-gov-service-token)
#  - VITE_<NAME>_TOKEN  (build-time embed)
PATTERN='[a-z0-9-]+-service-token|VITE_[A-Z0-9_]*TOKEN'

violations=0
for d in "${DIRS[@]}"; do
  [ -d "$d" ] || continue
  # rg if available, else grep -rE. Exclude comments is NOT done — a commented
  # token is still in the shipped bundle text, so we flag it too.
  if command -v rg >/dev/null 2>&1; then
    hits=$(rg -n --no-heading -e "$PATTERN" "$d" 2>/dev/null || true)
  else
    hits=$(grep -rnE "$PATTERN" "$d" 2>/dev/null || true)
  fi
  if [ -n "$hits" ]; then
    echo "FAIL: service-token / VITE_*_TOKEN literal found in $d:" >&2
    echo "$hits" | sed -E 's#(service-token).*#\1 …(redacted)#' >&2
    violations=$((violations + 1))
  fi
done

if [ "$violations" -gt 0 ]; then
  cat >&2 <<'EOF'

Frontend bundles must not embed service tokens. Route the call through a
same-origin proxy that injects Authorization server-side (see
blueprint-workbench vite.config.ts + Dockerfile for the audit-gov pattern,
M100 Phase 0). The user's own auth JWT is fine; shared service tokens are not.
EOF
  exit 1
fi

echo "OK — no service-token / VITE_*_TOKEN literals in frontend src."
