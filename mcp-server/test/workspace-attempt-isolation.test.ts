/**
 * workspaceRootForRunContext — workspace resolution contract.
 *
 * History:
 *   - M72 Slice C introduced per-attempt isolation: when `attemptId` was
 *     supplied the root was scoped to `.singularity/workitems/<wi>/attempts/<id>`.
 *   - M81 P2 (2026-05-26) SUPERSEDED that: the no-parallel-attempts guard +
 *     the long-lived `wi/<workItemCode>` branch made one-worktree-per-workitem
 *     the contract, and `attemptId` is now intentionally IGNORED. The old
 *     "appends /attempts/<attemptId>" tests were stale and have been rewritten
 *     to the M81 contract below.
 *   - 2026-06-02 (this revision) adds the CROSS-STAGE consistency cases. The
 *     governed loop's bug: a DEVELOP stage committed to the per-workitem
 *     worktree, but the following SECURITY_REVIEW stage resolved to the BASE
 *     sandbox root and re-cloned it, so the review agent never saw the dev's
 *     diff. The fix makes every stage of a run key off the same workitem
 *     identity (workItemCode / wi/<code> branch / workItemId / workflowInstanceId)
 *     and demotes the per-stage `branchName` so it can't split the run.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

let restoreEnv: () => void;

beforeEach(() => {
  // Pin MCP_SANDBOX_ROOT + MCP_WORKITEM_WORKSPACES_ROOT so the tests are
  // hermetic and don't depend on whatever the host has configured.
  const prev = {
    sandbox: process.env.MCP_SANDBOX_ROOT,
    workspaces: process.env.MCP_WORKITEM_WORKSPACES_ROOT,
  };
  process.env.MCP_SANDBOX_ROOT = path.join(os.tmpdir(), "m81-sandbox");
  delete process.env.MCP_WORKITEM_WORKSPACES_ROOT;
  restoreEnv = () => {
    process.env.MCP_SANDBOX_ROOT = prev.sandbox ?? "";
    if (prev.workspaces !== undefined) {
      process.env.MCP_WORKITEM_WORKSPACES_ROOT = prev.workspaces;
    } else {
      delete process.env.MCP_WORKITEM_WORKSPACES_ROOT;
    }
  };
});

afterEach(() => {
  restoreEnv?.();
});

async function loadSandbox() {
  // Dynamic import after env mutation so config reads the test values.
  return await import("../src/workspace/sandbox");
}

describe("workspaceRootForRunContext — M81 one-worktree-per-workitem contract", () => {
  it("uses .singularity/workitems/<workItem> when no attemptId is supplied", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    const root = workspaceRootForRunContext({ workItemId: "WRK-123" });
    expect(root).toMatch(/[\\/]workitems[\\/]WRK-123$/);
  });

  it("IGNORES attemptId — same workitem resolves to the workitem root (M81)", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    const root = workspaceRootForRunContext({
      workItemId: "WRK-123",
      attemptId: "attempt-abc",
    });
    // M81: no /attempts/ segment — attemptId is a no-op.
    expect(root).toMatch(/[\\/]workitems[\\/]WRK-123$/);
    expect(root).not.toContain("attempts");
    expect(root).not.toContain("attempt-abc");
  });

  it("collapses two attempts on the same WorkItem to ONE worktree (M81)", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    const a = workspaceRootForRunContext({ workItemId: "WRK-X", attemptId: "att-1" });
    const b = workspaceRootForRunContext({ workItemId: "WRK-X", attemptId: "att-2" });
    // The whole point of M81: the two attempts must NOT split into sibling
    // worktrees — they share the per-workitem root.
    expect(a).toEqual(b);
    expect(a).toMatch(/[\\/]workitems[\\/]WRK-X$/);
  });

  it("a path-traversal attemptId cannot escape — it is simply ignored (M81)", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    const root = workspaceRootForRunContext({
      workItemId: "WRK-1",
      attemptId: "../../../etc/passwd",
    });
    expect(root).not.toContain("..");
    expect(root).not.toContain("attempts");
    expect(root).toMatch(/[\\/]workitems[\\/]WRK-1$/);
  });

  it("empty attemptId is treated as absent (no /attempts/ segment)", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    const root = workspaceRootForRunContext({
      workItemId: "WRK-1",
      attemptId: "   ",
    });
    expect(root).not.toContain("attempts");
  });

  it("explicit workspaceRoot still wins over every other identity", async () => {
    // safeExplicitWorkspaceRoot only honours paths inside the sandbox root,
    // so use a value under MCP_SANDBOX_ROOT.
    const { workspaceRootForRunContext } = await loadSandbox();
    const explicit = path.join(process.env.MCP_SANDBOX_ROOT!, "custom");
    const root = workspaceRootForRunContext({
      workItemId: "WRK-1",
      workItemCode: "WRK-1",
      attemptId: "att-1",
      workspaceRoot: explicit,
    });
    expect(root).toBe(explicit);
  });
});

describe("workspaceRootForRunContext — cross-stage consistency (2026-06-02)", () => {
  it("workItemCode and the wi/<code> workitem branch resolve to the SAME root", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    // The developer stage typically arrives with an explicit workItemCode;
    // downstream stages may only carry the wi/<code> branch (e.g. the
    // camelCase workItemCode slot was empty after a snake_case wire hop).
    // Both must land on the identical per-workitem worktree.
    const byCode = workspaceRootForRunContext({ workItemCode: "WRK-984AD" });
    const byBranch = workspaceRootForRunContext({ workitemBranch: "wi/WRK-984AD" });
    expect(byCode).toEqual(byBranch);
    expect(byCode).toMatch(/[\\/]workitems[\\/]WRK-984AD$/);
  });

  it("DEVELOP and SECURITY_REVIEW land on the same worktree (the regression)", async () => {
    const { workspaceRootForRunContext, baseSandboxRoot } = await loadSandbox();
    // Develop: full identity, branch already on wi/<code>.
    const develop = workspaceRootForRunContext({
      workItemId: "wi-uuid-1",
      workItemCode: "WRK-984AD",
      branchName: "wi/WRK-984AD",
      workitemBranch: "wi/WRK-984AD",
      workflowInstanceId: "wf-1",
    });
    // Security: only the workitem branch survived (the exact failure shape —
    // pre-fix this fell through to the base sandbox root and re-cloned it).
    const security = workspaceRootForRunContext({
      workitemBranch: "wi/WRK-984AD",
      workflowInstanceId: "wf-1",
    });
    expect(security).toEqual(develop);
    expect(security).toMatch(/[\\/]workitems[\\/]WRK-984AD$/);
    expect(security).not.toEqual(baseSandboxRoot());
  });

  it("a per-stage branchName does NOT split a run across worktrees", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    // workgraph-api's per-attempt workbench branch varies per stage
    // (sg/<base>/<stage>/<attempt>). It must NOT win over the stage-stable
    // workItemId, or every stage would get its own worktree.
    const develop = workspaceRootForRunContext({
      workItemId: "WI-7",
      branchName: "sg/WI-7/develop/1-aaaaaaaa",
    });
    const security = workspaceRootForRunContext({
      workItemId: "WI-7",
      branchName: "sg/WI-7/security/2-bbbbbbbb",
    });
    expect(develop).toEqual(security);
    expect(develop).toMatch(/[\\/]workitems[\\/]WI-7$/);
    // The branch's per-stage suffix must not leak into the path.
    expect(develop).not.toContain("develop");
    expect(develop).not.toContain("aaaaaaaa");
  });

  it("workflowInstanceId is a stage-stable fallback BEFORE the base root", async () => {
    const { workspaceRootForRunContext, baseSandboxRoot } = await loadSandbox();
    // A run with no linked WorkItem (no code, no id) must still keep all its
    // stages together rather than scattering some onto the base sandbox root.
    const develop = workspaceRootForRunContext({ workflowInstanceId: "wf-xyz" });
    const security = workspaceRootForRunContext({ workflowInstanceId: "wf-xyz" });
    expect(develop).toEqual(security);
    expect(develop).toMatch(/[\\/]workitems[\\/]wf-xyz$/);
    expect(develop).not.toEqual(baseSandboxRoot());
  });

  it("falls back to the base sandbox root only when NOTHING identifies the run", async () => {
    const { workspaceRootForRunContext, baseSandboxRoot } = await loadSandbox();
    expect(workspaceRootForRunContext({})).toEqual(baseSandboxRoot());
  });
});
