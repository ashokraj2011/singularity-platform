#!/usr/bin/env bash
# Verify bare-metal scripts preserve the current platform topology:
#   - Platform Web owns UI on :5180.
#   - LLM Gateway and MCP are optional/remote-capable when SKIP_LOCAL_RUNTIME=1.
#   - bare-metal env generation respects operator-provided runtime URLs/tokens.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

C_GREEN=$'\033[1;32m'
C_RED=$'\033[1;31m'
C_END=$'\033[0m'

failures=0

ok() { printf '%sOK%s %s\n' "$C_GREEN" "$C_END" "$*"; }
fail() { printf '%sFAIL%s %s\n' "$C_RED" "$C_END" "$*" >&2; failures=$((failures + 1)); }

python3 - <<'PY'
from pathlib import Path
import sys

bare = Path("bin/bare-metal.sh").read_text()
apps = Path("bin/bare-metal-apps.sh").read_text()
runtime = Path("bin/bare-metal-runtime.sh").read_text()
doctor = Path("bin/doctor.sh").read_text()
setup = Path("bin/setup.sh").read_text()
copilot = Path("bin/llm-use-copilot.sh").read_text()
docker_core = Path("bin/docker-core.sh").read_text()
apply_schemas = Path("bin/apply-schemas.sh").read_text()
web_package = Path("agent-and-tools/web/package.json").read_text()
web_dockerfile = Path("agent-and-tools/web/Dockerfile").read_text()
standalone_guard = Path("agent-and-tools/web/scripts/check-standalone-bundle.mjs").read_text()
healthz_route = Path("agent-and-tools/web/src/app/healthz/route.ts")
runtime_infra_route = Path("agent-and-tools/web/src/app/api/runtime-infrastructure/route.ts").read_text()
platform_topology_route = Path("agent-and-tools/web/src/app/api/platform-topology/route.ts").read_text()

checks: dict[str, bool] = {}

checks["bare-metal-apps is platform-only wrapper"] = (
    'export SKIP_LOCAL_RUNTIME=1' in apps
    and 'exec "$ROOT/bin/bare-metal.sh" "$@"' in apps
)
checks["bare-metal-runtime has independent pid file"] = (
    'PID_FILE="$ROOT/.pids.runtime"' in runtime
    and 'PID_FILE="$ROOT/.pids"\n' not in runtime
)
checks["bare-metal-runtime frees only llm/mcp ports"] = (
    'RUNTIME_PORT_SPECS=(' in runtime
    and '"8001:llm-gateway"' in runtime
    and '"7100:mcp-server"' in runtime
    and '5180' not in runtime
    and '3001' not in runtime
)
checks["bare-metal-runtime boots only llm-gateway and mcp-server"] = (
    'record_boot_pid llm-gateway "$pid"' in runtime
    and 'record_boot_pid mcp-server "$pid"' in runtime
    and 'boot platform-web' not in runtime
    and 'boot workgraph-api' not in runtime
    and 'boot agent-runtime' not in runtime
)
checks["setup uses split bare-metal launchers"] = (
    'bin/bare-metal-apps.sh up "$PG_USER" "$PG_PASS" "$PG_HOST" "$PG_PORT"' in setup
    and 'bin/bare-metal-runtime.sh up' in setup
    and 'BOX_ONLY="$BOX_ONLY_MODE" bin/bare-metal.sh up' not in setup
)
checks["setup stops split launchers before reset"] = (
    'bin/bare-metal-runtime.sh down >/dev/null 2>&1 || true' in setup
    and 'bin/bare-metal-apps.sh down >/dev/null 2>&1 || true' in setup
)
checks["setup box-only uses runtime bridge default"] = (
    'bin/bare-metal-apps.sh up "$PG_USER" "$PG_PASS" "$PG_HOST" "$PG_PORT"' in setup
    and 'PREFER_LAPTOP_LLM="${PREFER_LAPTOP_LLM:-true}" bin/bare-metal-apps.sh up' not in setup
)
checks["copilot switcher recognizes split runtime pid file"] = (
    '.pids.runtime' in copilot
    and '[ -f "$ROOT/.pids.runtime" ] || [ -f "$ROOT/.pids" ]' in copilot
)
checks["platform-web package scripts honor launcher PORT"] = (
    'next dev -p ${PORT:-3000}' in web_package
    and 'next start -p ${PORT:-3000}' in web_package
)
checks["bare-metal clears only stale repo-owned platform-web :3000"] = (
    'free_stale_platform_web_legacy_port' in bare
    and 'SINGULARITY_FREE_STALE_PLATFORM_WEB_PORT' in bare
    and '$ROOT/agent-and-tools/web' in bare
    and 'warn "port $port is in use by pid $pid ($cmd) but is not this repo' in bare
    and '"3000:' not in bare.split('BARE_METAL_APP_PORT_SPECS=(', 1)[1].split(')', 1)[0]
)
checks["bare-metal port sweep kills repo-owned process tree"] = (
    'repo_owned_process_root' in bare
    and 'kill_process_tree' in bare
    and 'target="$(repo_owned_process_root "$pid")"' in bare
    and 'kill_process_tree "$target" "$label on :$port"' in bare
    and 'kill_process_tree "$pid" "bare-metal pidfile process"' in bare
)
checks["bare-metal applies agent-runtime hardening migrations"] = (
    'agent_runtime_hardening_migrations=(' in bare
    and '20260703120000_capability_active_identity_unique' in bare
    and '20260704110000_capability_learning_worker_lock' in bare
    and '20260704113000_capability_archive_reconcile' in bare
    and 'applying agent-runtime hardening migrations' in bare
    and 'prisma/migrations/${migration_name}/migration.sql' in bare
)
checks["docker schema applier applies agent-runtime hardening migrations"] = (
    'applying agent-runtime hardening migrations (partial indexes + archive reconciliation)' in apply_schemas
    and '20260703120000_capability_active_identity_unique' in apply_schemas
    and '20260704110000_capability_learning_worker_lock' in apply_schemas
    and '20260704113000_capability_archive_reconcile' in apply_schemas
    and 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "prisma/migrations/${migration_name}/migration.sql"' in apply_schemas
)
checks["docker schema applier does not hide piped docker exec failures"] = (
    'set -euo pipefail' in apply_schemas
)
checks["bare-metal boot fails fast with service log tail"] = (
    'if ! kill -0 "$pid" 2>/dev/null; then' in bare
    and 'err "${name} exited during startup (PID ${pid})"' in bare
    and 'warn "last ${name} log lines:"' in bare
    and 'tail -n 40 "$log_file"' in bare
)
checks["bare-metal cleans stale platform-web Next cache before boot"] = (
    'clean_platform_web_cache()' in bare
    and 'rm -rf "$web_dir/.next"' in bare
    and 'clean-web-cache|clean-platform-web-cache) clean_platform_web_cache ;;' in bare
    and 'Use after Next vendor-chunk/module errors.' in bare
    and 'clean_platform_web_cache\n  boot platform-web' in bare
)
checks["bare-metal explains platform-web stale Next chunk crashes"] = (
    'platform_web_cache_error_hint()' in bare
    and 'vendor-chunks|Cannot find module.*\\\\.next|_buildManifest|_ssgManifest|react-loadable-manifest' in bare
    and 'platform-web log looks like a stale Next cache/chunk mismatch.' in bare
    and 'bin/bare-metal-apps.sh down && bin/bare-metal.sh clean-web-cache && bin/bare-metal-apps.sh up' in bare
    and '[ "$name" = "platform-web" ] && platform_web_cache_error_hint "$log_file"' in bare
)
checks["platform-web docker fails fast on incomplete Next standalone bundle"] = (
    not web_dockerfile.startswith("# syntax=docker/dockerfile")
    and 'COPY agent-and-tools/web/scripts/check-standalone-bundle.mjs /app/check-standalone-bundle.mjs' in web_dockerfile
    and 'COPY --from=next-builder /app/agent-and-tools/web/.next/static ./web/.next/static' in web_dockerfile
    and 'COPY --from=next-builder /app/agent-and-tools/web/public ./web/public' in web_dockerfile
    and 'SERVER_ROOT="$(node /app/check-standalone-bundle.mjs /app --print-root)"' in web_dockerfile
    and 'cd "$SERVER_ROOT"' in web_dockerfile
    and 'HOSTNAME=0.0.0.0 PORT=3000 node server.js &' in web_dockerfile
    and 'platform-web standalone bundle is incomplete' in standalone_guard
    and 'platform-web standalone bundle is missing compiled server chunks or static assets' in standalone_guard
    and 'path.join(base, "web")' in standalone_guard
    and 'source.matchAll(/require\\(' in standalone_guard
    and 'path.resolve(path.dirname(file), match[2])' in standalone_guard
    and '.next/server/chunks/*.js' in standalone_guard
    and '.next/static/*' in standalone_guard
    and 'rebuild platform-web from a clean workspace/image cache' in standalone_guard
)
checks["plain docker validates platform-web image before start"] = (
    'validate_platform_web_image()' in docker_core
    and 'docker run --rm --entrypoint node "$IMG_PLATFORM_WEB" /app/check-standalone-bundle.mjs /app --print-root' in docker_core
    and 'platform-web image failed standalone bundle validation' in docker_core
    and 'fix: bin/docker-core.sh build --yes' in docker_core
    and 'validate_platform_web_image\n  if [ "$WITH_AUDIT" = "1" ]' in docker_core
)
checks["plain docker preflights base images with bounded pull"] = (
    'bin/docker-core.sh preflight [--with-audit]' in docker_core
    and 'pull_image_with_timeout()' in docker_core
    and 'subprocess.run(' in docker_core
    and 'timeout=timeout' in docker_core
    and 'DOCKER_CORE_IMAGE_PULL_TIMEOUT_SEC' in docker_core
    and 'DOCKER_CORE_SKIP_IMAGE_PREFLIGHT' in docker_core
    and '"node:20-alpine"' in docker_core
    and '"node:22-alpine"' in docker_core
    and '"python:3.11-slim"' in docker_core
    and '"python:3.12-slim"' in docker_core
    and '"pgvector/pgvector:pg16"' in docker_core
    and '"postgres:16-alpine"' in docker_core
    and '"minio/minio:latest"' in docker_core
    and 'run_preflight()' in docker_core
    and 'platform-web image is not built yet; run: bin/docker-core.sh build --yes' in docker_core
    and 'plain Docker preflight passed' in docker_core
    and 'preflight)\n    parse_flags "$@"' in docker_core
    and 'preflight_docker_images "$@"\n  if [ "$force" = "1" ]' in docker_core
)
checks["bare-metal smoke accepts guarded platform APIs and Next cold compile"] = (
    'http://localhost:5180/api/runtime/agents/templates?scope=common&limit=3|200,401,403|10' in bare
    and 'http://localhost:5180/workflows|200,304|20' in bare
    and 'http://localhost:5180/healthz|200,304|10' in bare
    and '[[ ",$allowed," == *",$code,"* ]]' in bare
    and healthz_route.exists()
)
checks["bare-metal env preserves dependent variable references"] = (
    'export DATABASE_URL_RUNTIME_READ="\\$DATABASE_URL_AGENT_TOOLS"' in bare
    and 'export CONTEXT_FABRIC_DATABASE_URL="\\$DATABASE_URL_CONTEXT_FABRIC"' in bare
    and 'export CALL_LOG_DATABASE_URL="\\$DATABASE_URL_CONTEXT_FABRIC"' in bare
    and 'export PROMPT_COMPOSER_SERVICE_TOKEN="\\${PROMPT_COMPOSER_SERVICE_TOKEN:-\\$WORKGRAPH_PROXY_SERVICE_TOKEN}"' in bare
    and 'export LAPTOP_BRIDGE_URL="\\$RUNTIME_BRIDGE_URL"' in bare
)
checks["bare-metal auto-mints platform-web service token"] = (
    'ensure_platform_web_service_token' in bare
    and '/auth/service-token' in bare
    and '"service_name": "platform-web"' in bare
    and 'set_env_export WORKGRAPH_PROXY_SERVICE_TOKEN "$WORKGRAPH_PROXY_SERVICE_TOKEN"' in bare
    and 'set_env_export PROMPT_COMPOSER_SERVICE_TOKEN "$PROMPT_COMPOSER_SERVICE_TOKEN"' in bare
    and 'LLM_GATEWAY_URL=\\"$LLM_GATEWAY_URL\\"' in bare
)
checks["platform-web IAM health rewrite accepts full health URL"] = (
    'function healthDestination' in Path("agent-and-tools/web/next.config.mjs").read_text()
    and 'const iamHealthDestination = healthDestination(configEnv("IAM_HEALTH_URL", "")' in Path("agent-and-tools/web/next.config.mjs").read_text()
    and 'destination: iamHealthDestination' in Path("agent-and-tools/web/next.config.mjs").read_text()
)
checks["platform-web treats MCP HTTP as explicit debug probe"] = (
    'flagEnabled(serverEnv("RUNTIME_HTTP_FALLBACK_ENABLED"))' in runtime_infra_route
    and 'flagEnabled(serverEnv("MCP_HTTP_DEBUG_PROBE_ENABLED"))' in runtime_infra_route
    and 'Direct MCP HTTP probe disabled. Normal traffic uses the Runtime Bridge WebSocket.' in runtime_infra_route
    and 'url: mcpHttpDebugEnabled ? configuredPlatformServiceUrl("mcp-server") : null' in runtime_infra_route
    and 'flagEnabled(serverEnv("RUNTIME_HTTP_FALLBACK_ENABLED"))' in platform_topology_route
    and 'flagEnabled(serverEnv("MCP_HTTP_DEBUG_PROBE_ENABLED"))' in platform_topology_route
    and 'url: mcpHttpDebugEnabled ? configuredPlatformServiceUrl("mcp-server") : null' in platform_topology_route
)

checks["bare-metal up base port sweep excludes llm/mcp"] = bool(
    'BARE_METAL_APP_PORT_SPECS=(' in bare
    and '"8001:llm-gateway"' not in bare.split('BARE_METAL_APP_PORT_SPECS=(', 1)[1].split(')', 1)[0]
    and '"7100:mcp-server"' not in bare.split('BARE_METAL_APP_PORT_SPECS=(', 1)[1].split(')', 1)[0]
)
checks["bare-metal up only sweeps llm/mcp outside split-runtime mode"] = (
    'if [ "${SKIP_LOCAL_RUNTIME:-}" != "1" ]; then\n    _ports_to_free+=("${BARE_METAL_RUNTIME_PORT_SPECS[@]}")' in bare
)

checks["bare-metal down base port sweep excludes llm/mcp"] = bool(
    'local ports=(\n    "${BARE_METAL_APP_PORT_SPECS[@]}"' in bare
    and '"8001:llm-gateway"' not in bare.split('BARE_METAL_APP_PORT_SPECS=(', 1)[1].split(')', 1)[0]
    and '"7100:mcp-server"' not in bare.split('BARE_METAL_APP_PORT_SPECS=(', 1)[1].split(')', 1)[0]
)
checks["bare-metal down only sweeps llm/mcp outside split-runtime mode"] = (
    'if [ -z "$SKIP_LOCAL_RUNTIME" ]; then\n    ports+=("${BARE_METAL_RUNTIME_PORT_SPECS[@]}")' in bare
)
checks["bare-metal runtime token is auto-minted through IAM"] = (
    'ensure_runtime_token' in bare
    and '/auth/device-token' in bare
    and 'token_kind": "runtime"' in bare
    and 'RUNTIME_TOKEN_FILE="$DEVICE_TOKEN_FILE"' in bare
    and 'ensure_runtime_token' in runtime
    and '/auth/device-token' in runtime
)

checks["bare-metal respects MCP_SERVER_URL"] = (
    'export MCP_SERVER_URL="${MCP_SERVER_URL:-http://localhost:7100}"' in bare
)
checks["bare-metal respects MCP_BEARER_TOKEN"] = (
    'export MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-$(config_value mcpRuntime.bearerToken demo-bearer-token-must-be-min-16-chars)}"' in bare
)
checks["bare-metal respects LLM_GATEWAY_URL"] = (
    'export LLM_GATEWAY_URL="${LLM_GATEWAY_URL:-http://localhost:8001}"' in bare
)
checks["agent-runtime uses configured LLM_GATEWAY_URL"] = (
    'LLM_GATEWAY_URL=\\"$LLM_GATEWAY_URL\\"' in bare
)
checks["bare-metal platform-web receives Workgraph proxy IAM JWT"] = (
    'WORKGRAPH_PROXY_SERVICE_TOKEN=\\"$WORKGRAPH_PROXY_SERVICE_TOKEN\\"' in bare
    and 'WORKGRAPH_PROXY_SERVICE_AUTH=true' in bare
)
checks["bare-metal platform-web receives tenant-scope env"] = (
    'TENANT_ISOLATION_MODE=\\"$TENANT_ISOLATION_MODE\\"' in bare
    and 'REQUIRE_TENANT_ID=\\"$REQUIRE_TENANT_ID\\"' in bare
    and 'IAM_SERVICE_TOKEN_TENANT_IDS=\\"$IAM_SERVICE_TOKEN_TENANT_IDS\\"' in bare
)
checks["bare-metal platform-web receives remaining server-side proxy service tokens"] = (
    'AUDIT_GOV_SERVICE_TOKEN=\\"$AUDIT_GOV_SERVICE_TOKEN\\"' in bare
    and 'WORKGRAPH_PROXY_SERVICE_TOKEN=\\"$WORKGRAPH_PROXY_SERVICE_TOKEN\\"' in bare
)
checks["bare-metal code generation is Workgraph-owned"] = (
    'boot code-foundry-api' not in bare
    and 'PORT=3005' not in bare
    and 'CODE_FOUNDRY_API_URL' not in bare
    and 'CREATE DATABASE singularity_codegen' not in bare
)
checks["bare-metal prompt/workgraph receive Context Fabric service token"] = (
    'export CONTEXT_FABRIC_SERVICE_TOKEN="${CONTEXT_FABRIC_SERVICE_TOKEN:-$(config_value tokens.contextFabricServiceToken dev-context-fabric-service-token)}"' in bare
    and 'cd agent-and-tools/apps/prompt-composer' in bare
    and 'CONTEXT_FABRIC_SERVICE_TOKEN=\\"$CONTEXT_FABRIC_SERVICE_TOKEN\\"' in bare
    and 'cd workgraph-studio/apps/api' in bare
)
checks["bare-metal wires Prompt Composer service token to composer callers"] = (
    'export PROMPT_COMPOSER_SERVICE_TOKEN="${PROMPT_COMPOSER_SERVICE_TOKEN:-$WORKGRAPH_PROXY_SERVICE_TOKEN}"' in bare
    and 'cd agent-and-tools/apps/prompt-composer' in bare
    and 'PROMPT_COMPOSER_SERVICE_TOKEN=\\"$PROMPT_COMPOSER_SERVICE_TOKEN\\"' in bare
    and 'cd mcp-server' in bare
    and 'CONTEXT_FABRIC_SERVICE_TOKEN=\\"$CONTEXT_FABRIC_SERVICE_TOKEN\\"' in bare
    and 'cd context-fabric' in bare
    and 'IAM_SERVICE_TOKEN=\\"$CONTEXT_FABRIC_SERVICE_TOKEN\\"' in bare
)
checks["bare-metal wires folded learning-service token"] = (
    'export LEARNING_SERVICE_TOKEN="\\${LEARNING_SERVICE_TOKEN:-\\$AUDIT_GOV_SERVICE_TOKEN}"' in bare
    and 'cd agent-and-tools/apps/agent-service' in bare
    and 'LEARNING_SERVICE_TOKEN=\\"$LEARNING_SERVICE_TOKEN\\"' in bare
    and 'cd agent-and-tools/apps/prompt-composer' in bare
    and 'cd mcp-server' in bare
)
checks["bare-metal context-api receives default governance mode"] = (
    'export DEFAULT_GOVERNANCE_MODE="${DEFAULT_GOVERNANCE_MODE:-$(config_value contextFabric.defaultGovernanceMode fail_open)}"' in bare
    and 'DEFAULT_GOVERNANCE_MODE=\\"$DEFAULT_GOVERNANCE_MODE\\"' in bare
)
checks["bare-metal defaults workflow agent tasks to governed execution"] = (
    'export WORKGRAPH_FORCE_GOVERNED_CODING="${WORKGRAPH_FORCE_GOVERNED_CODING:-$(config_value workgraph.forceGovernedCoding true)}"' in bare
    and 'WORKGRAPH_FORCE_GOVERNED_CODING=\\"$WORKGRAPH_FORCE_GOVERNED_CODING\\"' in bare
)
checks["bare-metal defaults side callers to governed single-turn"] = (
    'export CONTEXT_FABRIC_GOVERN_SIDE_CALLERS="${CONTEXT_FABRIC_GOVERN_SIDE_CALLERS:-$(config_value workgraph.governSideCallers true)}"' in bare
    and 'CONTEXT_FABRIC_GOVERN_SIDE_CALLERS=\\"$CONTEXT_FABRIC_GOVERN_SIDE_CALLERS\\"' in bare
)
checks["bare-metal context-api receives MCP tool-grant minting config"] = (
    'export CF_TOOL_GRANT_ENABLED="${CF_TOOL_GRANT_ENABLED:-$(config_value contextFabric.toolGrantEnabled false)}"' in bare
    and 'CF_TOOL_GRANT_ENABLED=\\"$CF_TOOL_GRANT_ENABLED\\"' in bare
    and 'TOOL_GRANT_SIGNING_SECRET=\\"$TOOL_GRANT_SIGNING_SECRET\\"' in bare
)
checks["bare-metal mcp-server receives governance and grant enforcement config"] = (
    'export MCP_DEFAULT_GOVERNANCE_MODE="${MCP_DEFAULT_GOVERNANCE_MODE:-$(config_value mcpRuntime.defaultGovernanceMode fail_open)}"' in bare
    and 'export MCP_TOOL_GRANT_MODE="${MCP_TOOL_GRANT_MODE:-$(config_value mcpRuntime.toolGrantMode off)}"' in bare
    and 'export MCP_REQUIRE_EFFECTIVE_CAPABILITIES="${MCP_REQUIRE_EFFECTIVE_CAPABILITIES:-$(config_value mcpRuntime.requireEffectiveCapabilities false)}"' in bare
    and 'MCP_DEFAULT_GOVERNANCE_MODE=\\"$MCP_DEFAULT_GOVERNANCE_MODE\\"' in bare
    and 'MCP_TOOL_GRANT_MODE=\\"$MCP_TOOL_GRANT_MODE\\"' in bare
    and 'MCP_REQUIRE_EFFECTIVE_CAPABILITIES=\\"$MCP_REQUIRE_EFFECTIVE_CAPABILITIES\\"' in bare
)
checks["bare-metal workgraph receives platform governance and grant mode"] = (
    'DEFAULT_GOVERNANCE_MODE=\\"$DEFAULT_GOVERNANCE_MODE\\"' in bare
    and 'WORKGRAPH_FORCE_GOVERNED_CODING=\\"$WORKGRAPH_FORCE_GOVERNED_CODING\\"' in bare
    and 'CONTEXT_FABRIC_GOVERN_SIDE_CALLERS=\\"$CONTEXT_FABRIC_GOVERN_SIDE_CALLERS\\"' in bare
    and 'MCP_TOOL_GRANT_MODE=\\"$MCP_TOOL_GRANT_MODE\\"' in bare
    and 'cd workgraph-studio/apps/api' in bare
)
checks["bare-metal workgraph receives internal and incoming-event secrets"] = (
    'provision_secret WORKGRAPH_INCOMING_EVENT_SECRET tokens.workgraphIncomingEventSecret 32' in bare
    and 'provision_secret WORKGRAPH_EVENT_SECRET_KEY    tokens.workgraphEventSecretKey      32' in bare
    and 'export WORKGRAPH_INCOMING_EVENT_SECRETS=' in bare
    and 'WORKGRAPH_INTERNAL_TOKEN=\\"$WORKGRAPH_INTERNAL_TOKEN\\"' in bare
    and 'WORKGRAPH_EVENT_SECRET_KEY=\\"$WORKGRAPH_EVENT_SECRET_KEY\\"' in bare
    and 'WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS=\\"$WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS\\"' in bare
    and 'WORKGRAPH_INCOMING_EVENT_SECRETS=\\"$WORKGRAPH_INCOMING_EVENT_SECRETS\\"' in bare
)
checks["bare-metal applies event operations tenant hardening migrations"] = (
    '20260710100000_harden_event_operations_tenant_scope/migration.sql' in bare
    and '20260710101000_harden_llm_routing_tenant_scope/migration.sql' in bare
    and '20260713100000_roadmap_gap_closure/migration.sql' in bare
    and '20260714100000_direct_llm_loop_strategies/migration.sql' in bare
)
checks["bare-metal applies spec-to-reconciliation migrations"] = (
    '20260715000000_m86_specification_versions/migration.sql' in bare
    and '20260716000000_m87_development_targets_submissions/migration.sql' in bare
    and '20260717000000_m88_reconciliation_runs/migration.sql' in bare
    and '20260718000000_m89_reconciliation_jobs/migration.sql' in bare
)
checks["bare-metal applies unified discovery migrations"] = (
    '20260719000000_m90_discovery_sessions/migration.sql' in bare
    and '20260720000000_m91_discovery_bridge/migration.sql' in bare
    and '20260721000000_m92_discovery_nodetype/migration.sql' in bare
)
checks["bare-metal applies finalize gate/fan-out migrations"] = (
    '20260724000000_m95_work_item_completion_gate/migration.sql' in bare
    and '20260725000000_m96_completion_program_fanout/migration.sql' in bare
)
checks["bare-metal forwards bounded local logs to the observability lake"] = (
    'boot log-forwarder' in bare
    and 'python3 bin/log-forwarder.py' in bare
    and '/api/v1/logs/health' in bare
)

services_block = doctor.split("runtime_services=", 1)[0]
runtime_block = doctor.split("runtime_services=", 1)[1] if "runtime_services=" in doctor else ""
checks["bare-metal doctor checks audit-gov as local service"] = (
    '"audit-gov|http://localhost:8500/health"' in services_block
)
checks["bare-metal doctor remediation uses split launchers"] = (
    'logs: bin/bare-metal-apps.sh logs $name' in doctor
    and 'start locally with bin/bare-metal-runtime.sh up' in doctor
    and 'restart Platform Web: bin/bare-metal-apps.sh down && bin/setup.sh --yes' in doctor
)
checks["bare-metal doctor fails unhealthy HTTP statuses"] = (
    'http_success(){' in doctor
    and 'elif ! http_success "$code"; then' in doctor
    and 'fail "$name unhealthy ($code)"' in doctor
    and 'warn "$name unhealthy ($code)"' in doctor
)
checks["bare-metal doctor explains strict health failures"] = (
    'agent_runtime_strict_hint(){' in doctor
    and 'archived_capability_lifecycle' in doctor
    and 'npx prisma migrate deploy' in doctor
    and 'npx prisma db push --skip-generate' in doctor
    and 'failed checks:' in doctor
)
checks["bare-metal doctor explains runtime registry failures"] = (
    'runtime_registry_hint(){' in doctor
    and 'required unhealthy:' in doctor
    and 'details = service.get("details")' in doctor
    and 'service.get("id") == "agent-runtime-strict"' in doctor
    and 'runtime_registry_hint "$runtime_status"' in doctor
)
checks["split runtime mode skips only llm-gateway and mcp-server"] = (
    '"llm-gateway|http://localhost:8001/health"' in runtime_block
    and '"mcp-server|http://localhost:7100/health"' in runtime_block
    and '"audit-gov|http://localhost:8500/health"' not in runtime_block
)
checks["BOX_ONLY remains split-runtime compatibility alias"] = (
    'SKIP_LOCAL_RUNTIME=1' in bare
    and 'PREFER_LAPTOP_LLM="${PREFER_LAPTOP_LLM:-true}"' not in bare
)
checks["bare-metal deep smoke includes route/API/browser parity"] = (
    'python3 bin/check-platform-web-routes.py' in bare
    and 'python3 bin/check-platform-api-parity.py' in bare
    and 'node bin/check-platform-web-ui.mjs' in bare
)
checks["bare-metal deep smoke still includes lifecycle parity"] = (
    'python3 bin/check-audit-governance-lifecycle.py' in bare
    and 'python3 bin/check-workbench-lifecycle.py' in bare
    and 'python3 bin/check-workflow-lifecycle.py' in bare
    and 'python3 bin/check-foundry-lifecycle.py' in bare
    and 'python3 bin/check-agent-profile-lifecycle.py' in bare
)

failed = [name for name, passed in checks.items() if not passed]
for name, passed in checks.items():
    print(f"{'OK' if passed else 'FAIL'} {name}")

if failed:
    sys.exit(1)
PY

if [ "$failures" -gt 0 ]; then
  printf '%s bare-metal topology check(s) failed.\n' "$failures" >&2
  exit 1
fi

ok "bare-metal topology check passed"
