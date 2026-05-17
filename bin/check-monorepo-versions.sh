#!/usr/bin/env bash
# M35.3 — CI guard for monorepo dependency consistency.
#
# Enforces that critical shared dependencies stay aligned across all TS
# workspaces. Major-version drift on Zod or Express has bitten us before
# (capability descriptors fail to parse on v3 ↔ v4 enum coercion; Express 4
# vs 5 has breaking middleware signature changes).
#
# The contract:
#   - Zod major version must be 3 everywhere (target: ^3.24.1)
#   - Express major version must be 4 everywhere (target: ^4.21.x)
#   - All workspaces should be on the same minor/patch within a major
#
# Exits 0 if consistent, non-zero with a diff if drift detected.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
header() { printf '\n=== %s ===\n' "$*"; }

# The expected target versions. Bump these when intentionally upgrading.
EXPECTED_ZOD_MAJOR=3
EXPECTED_EXPRESS_MAJOR=4

# Service package.json files we care about. These are the first-party
# Singularity services — not transitive deps under node_modules.
SERVICE_PACKAGES=(
  "agent-and-tools/apps/agent-service/package.json"
  "agent-and-tools/apps/tool-service/package.json"
  "agent-and-tools/apps/agent-runtime/package.json"
  "agent-and-tools/apps/prompt-composer/package.json"
  "mcp-server/package.json"
  "audit-governance-service/package.json"
  "platform-registry/package.json"
  "workgraph-studio/apps/api/package.json"
  "UserAndCapabillity/package.json"
)

EXIT_CODE=0

# Extract a dependency version from a package.json (looks in both
# dependencies and devDependencies). Returns "?" if not present.
get_dep_version() {
  local file="$1"
  local dep="$2"
  python3 -c "
import json, sys
try:
    with open('$file') as f:
        pkg = json.load(f)
    dep = '$dep'
    v = pkg.get('dependencies', {}).get(dep) or pkg.get('devDependencies', {}).get(dep)
    print(v if v else '?')
except Exception:
    print('?')
"
}

# Extract the major version number from a semver spec like ^3.24.1 → 3.
# Returns "?" for unparseable specs.
get_major() {
  local spec="$1"
  python3 -c "
import re, sys
spec = '$spec'.lstrip('^~>=<vV ').strip()
m = re.match(r'^(\d+)', spec)
print(m.group(1) if m else '?')
"
}

header "Zod version consistency"
ZOD_DRIFT=0
for pkg in "${SERVICE_PACKAGES[@]}"; do
  if [ ! -f "$pkg" ]; then
    yellow "  SKIP  $pkg (not found)"
    continue
  fi
  version=$(get_dep_version "$pkg" "zod")
  if [ "$version" = "?" ]; then
    printf "  ----  %-60s  (no zod dep)\n" "$pkg"
    continue
  fi
  major=$(get_major "$version")
  if [ "$major" != "$EXPECTED_ZOD_MAJOR" ]; then
    red   "  FAIL  $(printf '%-60s' "$pkg")  zod=$version (major=$major, expected=$EXPECTED_ZOD_MAJOR)"
    ZOD_DRIFT=1
    EXIT_CODE=1
  else
    green "  OK    $(printf '%-60s' "$pkg")  zod=$version"
  fi
done
if [ $ZOD_DRIFT -eq 0 ]; then
  green "All workspaces on zod v$EXPECTED_ZOD_MAJOR.x"
fi

header "Express version consistency"
EXPRESS_DRIFT=0
for pkg in "${SERVICE_PACKAGES[@]}"; do
  if [ ! -f "$pkg" ]; then
    continue
  fi
  version=$(get_dep_version "$pkg" "express")
  if [ "$version" = "?" ]; then
    printf "  ----  %-60s  (no express dep)\n" "$pkg"
    continue
  fi
  major=$(get_major "$version")
  if [ "$major" != "$EXPECTED_EXPRESS_MAJOR" ]; then
    red   "  FAIL  $(printf '%-60s' "$pkg")  express=$version (major=$major, expected=$EXPECTED_EXPRESS_MAJOR)"
    EXPRESS_DRIFT=1
    EXIT_CODE=1
  else
    green "  OK    $(printf '%-60s' "$pkg")  express=$version"
  fi
done
if [ $EXPRESS_DRIFT -eq 0 ]; then
  green "All workspaces on express v$EXPECTED_EXPRESS_MAJOR.x"
fi

header "Summary"
if [ $EXIT_CODE -eq 0 ]; then
  green "✅ Monorepo dependency versions are consistent."
  green "   zod target: v$EXPECTED_ZOD_MAJOR.x   express target: v$EXPECTED_EXPRESS_MAJOR.x"
else
  red "❌ Monorepo dependency drift detected."
  red "   Fix the FAIL entries above and re-run."
  red ""
  red "   To bump the expected version, edit EXPECTED_*_MAJOR at the top of:"
  red "   bin/check-monorepo-versions.sh"
fi

exit $EXIT_CODE
