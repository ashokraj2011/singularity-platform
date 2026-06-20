#!/usr/bin/env bash
# Validate every supported Docker Compose profile and the key topology
# invariants that keep the consolidated Platform Web/Core stack usable.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

C_GREEN=$'\033[1;32m'
C_RED=$'\033[1;31m'
C_END=$'\033[0m'

profiles=(
  core
  full
  backend-split
  composer-only
  gateway-only
  llm-gateway
  mcp
  verification
  compression
  frontend-legacy
  deprecated
)

legacy_frontends=(
  portal
  edge-gateway
  agent-web
  workgraph-web
  blueprint-workbench
  user-and-capability
  code-foundry-web
)

failures=0

ok() {
  printf '%sOK%s %s\n' "$C_GREEN" "$C_END" "$*"
}

fail() {
  printf '%sFAIL%s %s\n' "$C_RED" "$C_END" "$*" >&2
  failures=$((failures + 1))
}

profile_services() {
  local profile="$1"
  COMPOSE_PROFILES="$profile" docker compose config --services 2>&1
}

has_service() {
  local services="$1" service="$2"
  printf '%s\n' "$services" | grep -qx "$service"
}

expect_has() {
  local profile="$1" services="$2" service="$3"
  if has_service "$services" "$service"; then
    ok "$profile includes $service"
  else
    fail "$profile missing required service $service"
  fi
}

expect_not_has() {
  local profile="$1" services="$2" service="$3"
  if has_service "$services" "$service"; then
    fail "$profile unexpectedly includes $service"
  else
    ok "$profile excludes $service"
  fi
}

expect_single_platform_web() {
  local profile="$1" services="$2"
  expect_has "$profile" "$services" platform-web
  for service in "${legacy_frontends[@]}"; do
    expect_not_has "$profile" "$services" "$service"
  done
}

for profile in "${profiles[@]}"; do
  if ! output="$(profile_services "$profile")"; then
    fail "$profile compose config failed: $(printf '%s' "$output" | head -1)"
    continue
  fi
  ok "$profile compose config"

  case "$profile" in
    core)
      expect_single_platform_web "$profile" "$output"
      expect_has "$profile" "$output" platform-core
      expect_has "$profile" "$output" wg-postgres-bootstrap
      expect_not_has "$profile" "$output" agent-service
      expect_not_has "$profile" "$output" tool-service
      expect_not_has "$profile" "$output" agent-runtime
      expect_not_has "$profile" "$output" prompt-composer
      ;;
    full)
      expect_single_platform_web "$profile" "$output"
      expect_has "$profile" "$output" platform-core
      expect_has "$profile" "$output" llm-gateway
      expect_has "$profile" "$output" mcp-server
      expect_has "$profile" "$output" wg-postgres-bootstrap
      expect_not_has "$profile" "$output" agent-service
      expect_not_has "$profile" "$output" tool-service
      expect_not_has "$profile" "$output" agent-runtime
      expect_not_has "$profile" "$output" prompt-composer
      ;;
    backend-split)
      expect_single_platform_web "$profile" "$output"
      expect_not_has "$profile" "$output" platform-core
      expect_has "$profile" "$output" agent-service
      expect_has "$profile" "$output" tool-service
      expect_has "$profile" "$output" agent-runtime
      expect_has "$profile" "$output" prompt-composer
      expect_has "$profile" "$output" wg-postgres-bootstrap
      ;;
    composer-only)
      expect_has "$profile" "$output" at-postgres
      expect_has "$profile" "$output" at-postgres-bootstrap
      expect_has "$profile" "$output" llm-gateway
      expect_has "$profile" "$output" prompt-composer
      expect_not_has "$profile" "$output" platform-core
      ;;
    gateway-only)
      expect_has "$profile" "$output" at-postgres
      expect_has "$profile" "$output" llm-gateway
      expect_not_has "$profile" "$output" platform-web
      ;;
    deprecated)
      expect_has "$profile" "$output" at-postgres
      expect_has "$profile" "$output" at-postgres-bootstrap
      expect_has "$profile" "$output" llm-gateway
      expect_has "$profile" "$output" context-memory
      ;;
    frontend-legacy)
      expect_not_has "$profile" "$output" platform-web
      expect_has "$profile" "$output" portal
      expect_has "$profile" "$output" workgraph-web
      expect_has "$profile" "$output" blueprint-workbench
      expect_has "$profile" "$output" user-and-capability
      expect_has "$profile" "$output" code-foundry-web
      expect_has "$profile" "$output" edge-gateway
      ;;
  esac
done

if ! laptop_direct_config="$(docker compose -f docker-compose.yml -f docker-compose.laptop-direct.yml config 2>&1)"; then
  fail "laptop-direct compose overlay failed"
else
  ok "laptop-direct compose overlay"
  laptop_direct_services="$(printf '%s\n' "$laptop_direct_config" | docker compose -f docker-compose.yml -f docker-compose.laptop-direct.yml config --services 2>/dev/null || true)"
  expect_has "laptop-direct" "$laptop_direct_services" platform-web
  expect_not_has "laptop-direct" "$laptop_direct_services" portal
  if printf '%s\n' "$laptop_direct_config" | grep -q "host.docker.internal:7100" &&
     printf '%s\n' "$laptop_direct_config" | grep -q "host.docker.internal:8001"; then
    ok "laptop-direct points Platform Web/Core at host MCP and LLM gateway"
  else
    fail "laptop-direct missing host MCP/LLM gateway overrides"
  fi
  if grep -q "PORTAL_LINK_\\|edge-gateway\\|8085" docker-compose.laptop-direct.yml; then
    fail "laptop-direct still contains legacy portal/edge-gateway links"
  else
    ok "laptop-direct contains no legacy portal/edge-gateway links"
  fi
fi

if ! LAPTOP_HOST=127.0.0.1 MCP_BEARER_TOKEN=demo-bearer-token-must-be-min-16-chars \
  docker compose -f docker-compose.yml -f docker-compose.remote.yml config --services >/dev/null; then
  fail "remote compose overlay failed"
else
  ok "remote compose overlay"
fi

if [ "$failures" -gt 0 ]; then
  printf '%s compose profile check(s) failed.\n' "$failures" >&2
  exit 1
fi

ok "compose profile matrix passed"
