import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const STRONG_BEARER = "mcp_bearer_prod_contract_secret_1234567890";
const STRONG_GRANT = "toolgrant_prod_contract_secret_1234567890";

function runConfig(extraEnv: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      "-e",
      "const { config } = require('./src/config'); console.log(config.MCP_DEFAULT_GOVERNANCE_MODE + ':' + config.MCP_TOOL_GRANT_MODE + ':' + config.MCP_REQUIRE_EFFECTIVE_CAPABILITIES);",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        APP_ENV: "",
        ENVIRONMENT: "",
        SINGULARITY_ENV: "",
        MCP_BEARER_TOKEN: STRONG_BEARER,
        LLM_GATEWAY_URL: "mock",
        MCP_DEFAULT_GOVERNANCE_MODE: "fail_closed",
        MCP_TOOL_GRANT_MODE: "enforce",
        MCP_REQUIRE_EFFECTIVE_CAPABILITIES: "true",
        TOOL_GRANT_SIGNING_SECRET: STRONG_GRANT,
        ...extraEnv,
      },
      encoding: "utf8",
    },
  );
}

const ok = runConfig({});
assert.equal(ok.status, 0, ok.stderr);
assert.match(ok.stdout, /fail_closed:enforce:true/);

const failOpen = runConfig({ MCP_DEFAULT_GOVERNANCE_MODE: "fail_open" });
assert.notEqual(failOpen.status, 0);
assert.match(failOpen.stderr, /MCP_DEFAULT_GOVERNANCE_MODE/);

const grantOff = runConfig({ MCP_TOOL_GRANT_MODE: "off" });
assert.notEqual(grantOff.status, 0);
assert.match(grantOff.stderr, /MCP_TOOL_GRANT_MODE/);

const effectiveCapabilitiesOptional = runConfig({ MCP_REQUIRE_EFFECTIVE_CAPABILITIES: "false" });
assert.notEqual(effectiveCapabilitiesOptional.status, 0);
assert.match(effectiveCapabilitiesOptional.stderr, /MCP_REQUIRE_EFFECTIVE_CAPABILITIES/);

const missingGrantSecret = runConfig({ TOOL_GRANT_SIGNING_SECRET: "" });
assert.notEqual(missingGrantSecret.status, 0);
assert.match(missingGrantSecret.stderr, /TOOL_GRANT_SIGNING_SECRET/);

const invalidPort = runConfig({ PORT: "70000" });
assert.notEqual(invalidPort.status, 0);
assert.match(invalidPort.stderr, /PORT/);

const excessiveGatewayTimeout = runConfig({ LLM_GATEWAY_TIMEOUT_SEC: "999999" });
assert.notEqual(excessiveGatewayTimeout.status, 0);
assert.match(excessiveGatewayTimeout.stderr, /LLM_GATEWAY_TIMEOUT_SEC/);

const excessiveAgentSteps = runConfig({ MAX_AGENT_STEPS: "100000" });
assert.notEqual(excessiveAgentSteps.status, 0);
assert.match(excessiveAgentSteps.stderr, /MAX_AGENT_STEPS/);

const excessiveWorkspaceIndex = runConfig({ MCP_AST_MAX_WORKSPACE_BYTES: "999999999999" });
assert.notEqual(excessiveWorkspaceIndex.status, 0);
assert.match(excessiveWorkspaceIndex.stderr, /MCP_AST_MAX_WORKSPACE_BYTES/);

const appEnvProduction = runConfig({
  NODE_ENV: "development",
  APP_ENV: "production",
  MCP_DEFAULT_GOVERNANCE_MODE: "fail_open",
});
assert.notEqual(appEnvProduction.status, 0);
assert.match(appEnvProduction.stderr, /MCP_DEFAULT_GOVERNANCE_MODE/);

const invokeSource = readFileSync("src/mcp/invoke.ts", "utf8");
assert.match(invokeSource, /governanceMode: body\.governanceMode \?\? config\.MCP_DEFAULT_GOVERNANCE_MODE/);
assert.match(invokeSource, /governanceMode: env\.governance_mode \?\? config\.MCP_DEFAULT_GOVERNANCE_MODE/);
assert.doesNotMatch(invokeSource, /governanceMode:\s*z\.enum\(\[[^\n]+fail_open[^\n]+\]\)\.default\("fail_open"\)/);
assert.match(invokeSource, /function promptComposerAuthHeaders\(\): Record<string, string>/);
assert.match(invokeSource, /process\.env\.PROMPT_COMPOSER_SERVICE_TOKEN/);
assert.match(invokeSource, /process\.env\.CONTEXT_FABRIC_SERVICE_TOKEN/);
assert.match(invokeSource, /const PROMPT_COMPOSER_TIMEOUT_MS = config\.MCP_PROMPT_COMPOSER_TIMEOUT_SEC \* 1000;/);
assert.match(invokeSource, /headers: promptComposerAuthHeaders\(\), signal: AbortSignal\.timeout\(PROMPT_COMPOSER_TIMEOUT_MS\)/);
assert.doesNotMatch(invokeSource, /AbortSignal\.timeout\(5_000\)/);

const learningSource = readFileSync("src/tools/learning.ts", "utf8");
assert.match(learningSource, /function learningServiceHeaders\(\): Record<string, string>/);
assert.match(learningSource, /config\.LEARNING_SERVICE_TOKEN \?\? process\.env\.AUDIT_GOV_SERVICE_TOKEN/);
assert.match(learningSource, /\.\.\.learningServiceHeaders\(\)/);

console.log("mcp production config contract tests passed");
