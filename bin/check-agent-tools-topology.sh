#!/usr/bin/env bash
# Verify the agent/tools backend is in exactly one valid runtime topology:
#   1. consolidated platform-core, or
#   2. split debug services under the backend-split profile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

C_GREEN=$'\033[1;32m'
C_RED=$'\033[1;31m'
C_YELLOW=$'\033[1;33m'
C_END=$'\033[0m'

failures=0
warnings=0

ok() { printf '%sOK%s %s\n' "$C_GREEN" "$C_END" "$*"; }
warn() { printf '%sWARN%s %s\n' "$C_YELLOW" "$C_END" "$*"; warnings=$((warnings + 1)); }
fail() { printf '%sFAIL%s %s\n' "$C_RED" "$C_END" "$*" >&2; failures=$((failures + 1)); }

running_services="$(docker compose ps --services --status running 2>/dev/null || true)"

is_running() {
  printf '%s\n' "$running_services" | grep -qx "$1"
}

http_ok() {
  local port="$1"
  if command -v curl >/dev/null 2>&1; then
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://localhost:${port}/health" 2>/dev/null || true)" = "200" ]
  else
    python3 - "$port" <<'PY'
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    res = urlopen(Request(f"http://localhost:{sys.argv[1]}/health"), timeout=4)
    raise SystemExit(0 if res.status == 200 else 1)
except (HTTPError, URLError, OSError, TimeoutError):
    raise SystemExit(1)
PY
  fi
}

platform_core=0
is_running platform-core && platform_core=1

split_running=0
split_missing=""
for service in agent-service tool-service agent-runtime prompt-composer; do
  if is_running "$service"; then
    split_running=$((split_running + 1))
  else
    split_missing="$split_missing $service"
  fi
done

if [ "$platform_core" -eq 1 ] && [ "$split_running" -gt 0 ]; then
  fail "platform-core and split backend services are running together"
elif [ "$platform_core" -eq 1 ]; then
  ok "agent/tools topology: consolidated platform-core"
elif [ "$split_running" -eq 4 ]; then
  ok "agent/tools topology: backend-split"
elif [ "$split_running" -gt 0 ]; then
  fail "partial backend-split topology: running $split_running/4; missing:${split_missing}"
else
  fail "no agent/tools backend topology is running"
fi

for item in \
  "3001 agent-service" \
  "3002 tool-service" \
  "3003 agent-runtime" \
  "3004 prompt-composer"; do
  port="${item%% *}"
  name="${item#* }"
  if http_ok "$port"; then
    ok "$name health on :$port"
  else
    fail "$name health failed on :$port"
  fi
done

if [ "$platform_core" -eq 1 ] && command -v docker >/dev/null 2>&1; then
  node_processes="$(docker exec singularity-platform-core sh -c "ps -o comm= | grep -c '^node$'" 2>/dev/null || printf '0')"
  if [ "${node_processes:-0}" -ge 4 ]; then
    ok "platform-core has ${node_processes} node child processes"
  else
    fail "platform-core has ${node_processes:-0} node child processes; expected at least 4"
  fi
fi

if [ "$failures" -gt 0 ]; then
  printf '%s agent/tools topology check(s) failed.\n' "$failures" >&2
  exit 1
fi

if [ "$warnings" -gt 0 ]; then
  printf '%s agent/tools topology warning(s).\n' "$warnings" >&2
fi

ok "agent/tools topology check passed"
