#!/usr/bin/env bash
set -euo pipefail

# Bare-metal platform-app launcher.
#
# Starts all product/application services except the deployable runtime
# infrastructure pair: llm-gateway and mcp-server. Use
# bin/bare-metal-runtime.sh when you want those two running locally.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SKIP_LOCAL_RUNTIME=1
exec "$ROOT/bin/bare-metal.sh" "$@"
