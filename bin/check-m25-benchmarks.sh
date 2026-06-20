#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSER_DIR="$ROOT/agent-and-tools/apps/prompt-composer"
BENCHMARK="$COMPOSER_DIR/src/modules/compose/m25-retrieval-benchmark.contract.test.ts"

if [[ ! -f "$BENCHMARK" ]]; then
  echo "FAIL missing M25 retrieval benchmark contract: $BENCHMARK" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "FAIL npm is required to run the M25 retrieval benchmark contract" >&2
  exit 1
fi

echo "M25 retrieval benchmark contract"
(cd "$COMPOSER_DIR" && npm run test:m25-benchmark)
echo "M25 benchmark checks passed."
