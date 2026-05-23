/**
 * M72 Slice C — workspaceRootForRunContext attempt isolation tests.
 *
 * Covers the new `attemptId` field that scopes the workspace root to a
 * per-attempt subdirectory so concurrent runs on the same WorkItem don't
 * stomp on each other.
 *
 * Backward compat: when attemptId is absent, the layout is unchanged.
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
  process.env.MCP_SANDBOX_ROOT = path.join(os.tmpdir(), "m72c-sandbox");
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
  // vitest doesn't strip module caches between tests by default; we force
  // a fresh module instance via `vi.resetModules` if needed (rare).
  return await import("../src/workspace/sandbox");
}

describe("workspaceRootForRunContext — attempt isolation (M72C)", () => {
  it("uses .singularity/workitems/<workItem> when no attemptId is supplied (backward compat)", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    const root = workspaceRootForRunContext({ workItemId: "WRK-123" });
    expect(root).toMatch(/[\\/]workitems[\\/]WRK-123$/);
  });

  it("appends /attempts/<attemptId> when attemptId is supplied", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    const root = workspaceRootForRunContext({
      workItemId: "WRK-123",
      attemptId: "attempt-abc",
    });
    expect(root).toMatch(/[\\/]workitems[\\/]WRK-123[\\/]attempts[\\/]attempt-abc$/);
  });

  it("isolates two concurrent attempts on the same WorkItem", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    const a = workspaceRootForRunContext({ workItemId: "WRK-X", attemptId: "att-1" });
    const b = workspaceRootForRunContext({ workItemId: "WRK-X", attemptId: "att-2" });
    expect(a).not.toEqual(b);
    // Both are under the same WorkItem directory.
    expect(a).toMatch(/WRK-X[\\/]attempts[\\/]att-1$/);
    expect(b).toMatch(/WRK-X[\\/]attempts[\\/]att-2$/);
  });

  it("strips unsafe characters from attemptId for path safety", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    // Path traversal attempts must not escape the workitem dir.
    const root = workspaceRootForRunContext({
      workItemId: "WRK-1",
      attemptId: "../../../etc/passwd",
    });
    expect(root).not.toContain("../");
    expect(root).toMatch(/[\\/]attempts[\\/]/);
  });

  it("empty attemptId is treated as absent (no /attempts/ segment)", async () => {
    const { workspaceRootForRunContext } = await loadSandbox();
    const root = workspaceRootForRunContext({
      workItemId: "WRK-1",
      attemptId: "   ",
    });
    expect(root).not.toContain("attempts");
  });

  it("explicit workspaceRoot still wins over attemptId", async () => {
    // safeExplicitWorkspaceRoot only honours paths inside the sandbox root,
    // so use a value under MCP_SANDBOX_ROOT.
    const { workspaceRootForRunContext } = await loadSandbox();
    const explicit = path.join(process.env.MCP_SANDBOX_ROOT!, "custom");
    const root = workspaceRootForRunContext({
      workItemId: "WRK-1",
      attemptId: "att-1",
      workspaceRoot: explicit,
    });
    expect(root).toBe(explicit);
  });
});
