#!/usr/bin/env bash
# Syncs branding/*.png + tokens.css into every app's public/ directory.
# Run this once whenever the canonical brand files change.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT/branding"

C_GREEN=$'\033[1;32m'
C_RED=$'\033[1;31m'
C_YELLOW=$'\033[1;33m'
C_DIM=$'\033[2m'
C_END=$'\033[0m'

ok()   { echo -e "${C_GREEN}✓${C_END} $*"; }
warn() { echo -e "${C_YELLOW}!${C_END} $*"; }
err()  { echo -e "${C_RED}✗${C_END} $*" >&2; }

# Frontends that need the brand assets in their public/ root.
TARGETS=(
  "singularity-portal/public"
  "UserAndCapabillity/public"
  "agent-and-tools/web/public"
  "workgraph-studio/apps/web/public"
)

LOGO="$SRC/singularity-logo.png"
MARK="$SRC/singularity-mark.png"
TOKENS="$SRC/tokens.css"

if [ ! -f "$LOGO" ]; then
  err "missing $LOGO"
  err "Drop the full-lockup PNG at branding/singularity-logo.png and re-run."
  echo
  echo "See branding/README.md for naming + sizing."
  exit 1
fi

# Mark is optional — fall back to logo if absent.
if [ ! -f "$MARK" ]; then
  warn "no branding/singularity-mark.png — using singularity-logo.png as the favicon source."
  MARK="$LOGO"
fi

if [ ! -f "$TOKENS" ]; then
  err "missing $TOKENS"
  exit 1
fi

count=0
missing=0
for rel in "${TARGETS[@]}"; do
  dst="$ROOT/$rel"
  if [ ! -d "$(dirname "$dst")" ]; then
    warn "skip — parent dir not found: $rel"
    missing=$((missing + 1))
    continue
  fi
  mkdir -p "$dst"
  cp "$LOGO"   "$dst/singularity-logo.png"
  cp "$MARK"   "$dst/singularity-mark.png"
  cp "$MARK"   "$dst/favicon.png"
  cp "$TOKENS" "$dst/brand-tokens.css"
  ok "synced → $rel/"
  count=$((count + 1))
done

echo
ok "${count} app(s) updated."
[ "$missing" -gt 0 ] && warn "${missing} target dir(s) missing — investigate or remove from TARGETS."
echo
echo "${C_DIM}Reload the browser (or HMR will pick it up automatically) to see the new assets.${C_END}"
