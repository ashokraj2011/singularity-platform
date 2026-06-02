/**
 * Cross-stage workspace resolution through /mcp/tool-run (2026-06-02).
 *
 * Reproduces and locks down the governed-loop regression: a DEVELOP stage
 * committed code to the per-workitem worktree, but the following
 * SECURITY_REVIEW stage resolved its workspace to the BASE sandbox root and
 * re-cloned it — so the review agent never saw the developer's diff.
 *
 * Root cause exercised here: context-fabric ships the GOVERNED run_context to
 * /mcp/tool-run in snake_case, but ToolRunSchema only read camelCase
 * `workItemCode` / `branchName`. The workitem identity was silently dropped and
 * workspaceRootForRunContext fell through to the base sandbox root. This test
 * drives runToolByName with snake_case run_context (exactly what CF sends) and
 * asserts every stage of a run lands on the SAME per-workitem worktree.
 *
 * The assertions read the resolved sandbox root back out of a tiny fixture tool
 * (it returns sandboxRoot() from inside the withSandboxRoot scope that
 * runToolByName establishes), so this covers the whole tool-run path — schema
 * casing + resolver — not just the resolver in isolation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

let runToolByName: typeof import("../src/mcp/tool-run").runToolByName;
let ToolRunSchema: typeof import("../src/mcp/tool-run").ToolRunSchema;
let sandboxRoot: typeof import("../src/workspace/sandbox").sandboxRoot;
let baseSandboxRoot: typeof import("../src/workspace/sandbox").baseSandboxRoot;

const SANDBOX_TOOL = "test_report_sandbox_root";

beforeAll(async () => {
  process.env.MCP_BEARER_TOKEN =
    process.env.MCP_BEARER_TOKEN ?? "test-bearer-token-12345-min-16-chars";
  process.env.LLM_GATEWAY_URL = process.env.LLM_GATEWAY_URL ?? "mock";
  // Hermetic sandbox root under tmp (NOT the repo, so test runs leave no
  // .singularity/ behind); no source repo is materialised because no
  // source_uri is supplied (ensureWorkspaceSource is skipped entirely).
  process.env.MCP_SANDBOX_ROOT =
    process.env.MCP_SANDBOX_ROOT ?? path.join(os.tmpdir(), "m81-cross-stage-sandbox");

  // Import AFTER env is set so config picks up the test values.
  const registry = await import("../src/tools/registry");
  const sandbox = await import("../src/workspace/sandbox");
  sandboxRoot = sandbox.sandboxRoot;
  baseSandboxRoot = sandbox.baseSandboxRoot;

  registry.registerLocalTool({
    name: SANDBOX_TOOL,
    description: "Return the resolved sandbox root. Cross-stage resolution test fixture.",
    inputSchema: { type: "object" },
    async execute() {
      return { success: true, output: { root: sandboxRoot() } };
    },
  });

  const toolRun = await import("../src/mcp/tool-run");
  runToolByName = toolRun.runToolByName;
  ToolRunSchema = toolRun.ToolRunSchema;
});

async function resolveRootFor(run_context: Record<string, unknown>): Promise<string> {
  const body = ToolRunSchema.parse({
    tool_name: SANDBOX_TOOL,
    args: {},
    run_context,
  });
  const outcome = await runToolByName(body);
  expect(outcome.toolSuccess).toBe(true);
  return (outcome.result as { root: string }).root;
}

describe("/mcp/tool-run cross-stage workspace resolution", () => {
  it("DEVELOP and SECURITY_REVIEW share one worktree with snake_case run_context", async () => {
    // Exactly the shape workgraph-api builds (blueprint.router runContext):
    // snake_case, wi/<code> branch on every stage.
    const develop = await resolveRootFor({
      work_item_id: "wi-uuid-7",
      work_item_code: "WRK-CROSS1",
      branch_name: "wi/WRK-CROSS1",
      workitem_branch: "wi/WRK-CROSS1",
      workflow_instance_id: "wf-cross-1",
    });
    const security = await resolveRootFor({
      work_item_id: "wi-uuid-7",
      work_item_code: "WRK-CROSS1",
      branch_name: "wi/WRK-CROSS1",
      workitem_branch: "wi/WRK-CROSS1",
      workflow_instance_id: "wf-cross-1",
    });
    expect(security).toEqual(develop);
    expect(develop).toMatch(/[\\/]workitems[\\/]WRK-CROSS1$/);
    expect(develop).not.toEqual(baseSandboxRoot());
  });

  it("a stage carrying only workitem_branch resolves to the workitem root, NOT base", async () => {
    // The exact failure shape: the snake_case work_item_code didn't survive,
    // only the wi/<code> branch did. Pre-fix this returned the base sandbox
    // root (which threw 'requires a per-run workspace root' in the
    // materializer); now it keys off the branch.
    const root = await resolveRootFor({ workitem_branch: "wi/WRK-CROSS2" });
    expect(root).toMatch(/[\\/]workitems[\\/]WRK-CROSS2$/);
    expect(root).not.toEqual(baseSandboxRoot());
  });

  it("workItemCode-only (snake) and workitem_branch-only resolve identically", async () => {
    const byCode = await resolveRootFor({ work_item_code: "WRK-CROSS3" });
    const byBranch = await resolveRootFor({ workitem_branch: "wi/WRK-CROSS3" });
    expect(byCode).toEqual(byBranch);
    expect(byCode).toMatch(/[\\/]workitems[\\/]WRK-CROSS3$/);
  });

  it("falls back to workflow_instance_id (not base root) when no WorkItem is linked", async () => {
    const develop = await resolveRootFor({ workflow_instance_id: "wf-nolink" });
    const security = await resolveRootFor({ workflow_instance_id: "wf-nolink" });
    expect(develop).toEqual(security);
    expect(develop).not.toEqual(baseSandboxRoot());
  });
});
