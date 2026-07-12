#!/usr/bin/env bash
set -euo pipefail

# Bare-metal platform-app launcher.
#
# Starts all product/application services except the deployable runtime
# infrastructure pair: llm-gateway and mcp-server. Use
# bin/bare-metal-runtime.sh when you want those two running locally.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "${1:-}" = "env-check" ] || [ "${1:-}" = "check-env" ]; then
  shift || true
  exec "$ROOT/bin/check-deployment-env.sh" server "$@"
fi
export SKIP_LOCAL_RUNTIME=1
exec "$ROOT/bin/bare-metal.sh" "$@"
