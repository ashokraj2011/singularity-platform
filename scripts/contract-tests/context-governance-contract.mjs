#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

let failures = 0;

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function assertContains(rel, needle, message) {
  const source = read(rel);
  if (!source.includes(needle)) {
    failures += 1;
    console.error(`::error file=${rel}::${message} (missing ${JSON.stringify(needle)})`);
  }
}

function assertMatches(rel, regex, message) {
  const source = read(rel);
  if (!regex.test(source)) {
    failures += 1;
    console.error(`::error file=${rel}::${message} (missing ${regex})`);
  }
}

const composer = "agent-and-tools/apps/prompt-composer/src/modules/compose/compose.service.ts";
assertContains(composer, "type ContextPlan", "Prompt Composer must define the ContextPlan contract.");
assertContains(composer, "MANDATORY_RUNTIME_LAYERS", "Prompt Composer must keep mandatory runtime-layer enforcement explicit.");
assertContains(composer, "\"PLATFORM_CONSTITUTION\"", "PLATFORM_CONSTITUTION must be a mandatory ContextPlan layer.");
assertContains(composer, "\"AGENT_ROLE\"", "AGENT_ROLE must be a mandatory ContextPlan layer.");
assertContains(composer, "\"TASK_CONTEXT\"", "TASK_CONTEXT must be a mandatory ContextPlan layer.");
assertContains(composer, "missingRequired", "Prompt Composer must report missing required context.");
assertContains(composer, "contextPlanEvidence", "Prompt Composer must persist ContextPlan evidence for run insights.");
assertContains(composer, "contextPlan,", "Prompt Composer preview must return the ContextPlan.");
assertContains(composer, "fetchArtifactContent", "Prompt Composer must fetch MinIO/document references through the governed artifact fetch path.");
assertContains(composer, "WORKGRAPH_ARTIFACT_FETCH_URL", "Prompt Composer artifact fetch must be externally configured.");

const execute = "context-fabric/services/context_api_service/app/execute.py";
for (const mode of ["fail_open", "fail_closed", "degraded", "human_approval_required"]) {
  assertContains(execute, mode, `Context Fabric must recognize governance mode ${mode}.`);
}
for (const eventKind of [
  "context_plan.validated",
  "context_plan.invalid",
  "governance.degraded_execution.allowed",
  "governance.context_approval.requested",
  "governance.context_approval.approved",
  "governance.context_approval.rejected",
]) {
  assertContains(execute, eventKind, `Context Fabric must emit ${eventKind}.`);
}
assertContains(execute, "CONTEXT_PLAN_INVALID", "fail_closed must return a clear ContextPlan invalid error code.");
assertContains(execute, "pending_tool_name\": \"context_plan_approval\"", "human_approval_required must pause with a context-plan approval token.");
assertContains(execute, "executeRequest", "ContextPlan approval rows must store the original ExecuteRequest for resume.");
assertContains(execute, "approvedContextPlanBypass", "Approved ContextPlan resumes must be marked as an explicit bypass.");

const mcpInvoke = "mcp-server/src/mcp/invoke.ts";
assertContains(mcpInvoke, "governanceMode", "MCP invoke must accept governanceMode.");
assertContains(mcpInvoke, "contextPlanHash", "MCP invoke must accept contextPlanHash.");
assertContains(mcpInvoke, "degradedActionsAllowed", "MCP invoke must accept degradedActionsAllowed.");
assertContains(mcpInvoke, "\"degraded\"", "MCP must implement degraded execution posture.");
const governancePolicy = "mcp-server/src/lib/governance-policy.ts";
for (const tool of ["write_file", "apply_patch", "git_commit", "finish_work_branch"]) {
  assertContains(governancePolicy, tool, `MCP must classify ${tool} as a risky mutation tool.`);
}
assertContains(
  "mcp-server/src/lib/audit-gov-check.ts",
  "outageResult(governanceMode",
  "MCP audit-governance outage behavior must depend on governanceMode.",
);

const cfClient = "workgraph-studio/apps/api/src/lib/context-fabric/client.ts";
assertContains(cfClient, "governance_mode?", "Workgraph Context Fabric client must expose governance_mode.");
assertContains(cfClient, "contextPlanHash", "Workgraph Context Fabric client must expose contextPlanHash.");
assertContains(cfClient, "requiredContextStatus", "Workgraph Context Fabric client must expose requiredContextStatus.");

const agentTask = "workgraph-studio/apps/api/src/modules/workflow/runtime/executors/AgentTaskExecutor.ts";
assertContains(agentTask, "resolveWorkflowGovernanceMode", "AgentTaskExecutor must resolve workflow-level governance defaults.");
assertMatches(agentTask, /governance_mode:\s*governanceMode/, "AgentTaskExecutor must send resolved governanceMode to Context Fabric.");

const budget = "workgraph-studio/apps/api/src/modules/workflow/runtime/budget.ts";
assertContains(budget, "governanceMode", "Workflow budget policy must carry a default governanceMode.");
assertContains(budget, "nodeTypeGovernanceModes", "Workflow budget policy must support node-type governance defaults.");

const insights = "workgraph-studio/apps/web/src/features/runtime/RunInsightsPage.tsx";
assertContains(insights, "Context Plan", "Run Insights must surface ContextPlan state.");
assertContains(insights, "suggestedFix", "Run Insights must show operator-actionable ContextPlan fix hints.");
assertContains(insights, "promptLayerName", "Run Insights must name the owning prompt layer when available.");

const workgraphApp = "workgraph-studio/apps/api/src/app.ts";
assertContains(workgraphApp, "internalArtifactFetchRouter", "Workgraph must expose the internal artifact fetch endpoint for Prompt Composer.");

const evidencePack = "workgraph-studio/apps/api/src/modules/workflow/insights.router.ts";
assertContains(evidencePack, "format === 'pdf'", "Run Evidence Pack must support PDF export.");
assertContains(evidencePack, "renderEvidencePdf", "Run Evidence Pack PDF renderer must stay wired.");

const blueprint = "workgraph-studio/apps/api/src/modules/blueprint/blueprint.router.ts";
assertContains(blueprint, "WORKBENCH_STAGE_ARTIFACT", "Workbench stage artifacts must publish workflow consumables.");
assertContains(blueprint, "WORKBENCH_FINAL_PACK", "Workbench final packs must publish workflow consumables.");

const doctor = "bin/configure-platform.py";
assertContains(doctor, "bearer_token=mcp_token", "Office Copilot-only doctor must call protected MCP model/provider endpoints with the MCP bearer token.");
assertContains(doctor, "WORKGRAPH_INTERNAL_TOKEN", "Config export must emit the Workgraph internal service token.");
assertContains(doctor, "WORKGRAPH_ARTIFACT_FETCH_URL", "Config export must emit the governed artifact fetch URL.");
assertContains(doctor, "WORKGRAPH_ARTIFACT_FETCH_TOKEN", "Config export must emit the governed artifact fetch token.");

if (failures > 0) {
  console.error(`Context/governance contract failed with ${failures} issue(s).`);
  process.exit(1);
}

console.log("Context/governance contract checks passed.");
