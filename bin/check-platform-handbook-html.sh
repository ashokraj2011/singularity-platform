#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

tmp="$(mktemp /tmp/singularity-platform-handbook.XXXXXX.html)"
cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT

node bin/render-platform-handbook-html.mjs --output "$tmp" >/dev/null

if ! cmp -s docs/platform-handbook.html "$tmp"; then
  echo "FAIL docs/platform-handbook.html is stale relative to docs/platform-handbook.md" >&2
  echo "Run: node bin/render-platform-handbook-html.mjs" >&2
  exit 1
fi

echo "OK platform handbook HTML is current"
