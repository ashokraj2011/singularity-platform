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
web_package = Path("agent-and-tools/web/package.json").read_text()

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
    'boot llm-gateway' in runtime
    and 'boot mcp-server' in runtime
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
    '"dev": "next dev -p ${PORT:-3000}"' in web_package
    and '"start": "next start -p ${PORT:-3000}"' in web_package
)
checks["bare-metal clears only stale repo-owned platform-web :3000"] = (
    'free_stale_platform_web_legacy_port' in bare
    and 'SINGULARITY_FREE_STALE_PLATFORM_WEB_PORT' in bare
    and '$ROOT/agent-and-tools/web' in bare
    and 'warn "port $port is in use by pid $pid ($cmd) but is not this repo' in bare
    and '"3000:' not in bare.split('BARE_METAL_APP_PORT_SPECS=(', 1)[1].split(')', 1)[0]
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
    'export LEARNING_SERVICE_TOKEN="${LEARNING_SERVICE_TOKEN:-$AUDIT_GOV_SERVICE_TOKEN}"' in bare
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
    'export WORKGRAPH_INCOMING_EVENT_SECRETS="${WORKGRAPH_INCOMING_EVENT_SECRETS:-$(config_value tokens.workgraphIncomingEventSecrets' in bare
    and 'WORKGRAPH_INTERNAL_TOKEN=\\"$WORKGRAPH_INTERNAL_TOKEN\\"' in bare
    and 'WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS=\\"$WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS\\"' in bare
    and 'WORKGRAPH_INCOMING_EVENT_SECRETS=\\"$WORKGRAPH_INCOMING_EVENT_SECRETS\\"' in bare
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
