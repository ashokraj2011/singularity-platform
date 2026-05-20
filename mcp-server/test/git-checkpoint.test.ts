import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withSandboxRoot } from "../src/workspace/sandbox";
import {
  createCheckpoint,
  rollbackToCheckpoint,
  cleanupCheckpoints,
  ensureGitRepo,
} from "../src/workspace/git-workspace";
import { writeFileTool } from "../src/tools/fs-git";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function withTempSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "mcp-git-checkpoint-"));
  try {
    return await withSandboxRoot(root, () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Git Checkpoint Refs", () => {
  it("can create checkpoints, roll back to them, and clean them up", async () => {
    await withTempSandbox(async (root) => {
      await ensureGitRepo();

      // Write initial file and commit so we have a HEAD
      await writeFileTool.execute({ path: "foo.txt", content: "hello\n" });
      const cwd = root;
      await execFileP("git", ["add", "foo.txt"], { cwd });
      await execFileP("git", ["commit", "-m", "initial commit"], { cwd });

      // Create first checkpoint
      await writeFileTool.execute({ path: "foo.txt", content: "hello v1\n" });
      const cp1 = await createCheckpoint(["foo.txt"], 1, { runId: "test-run-123" });
      expect(cp1).not.toBeNull();
      expect(cp1?.ref).toBe("refs/singularity/checkpoints/test-run-123/1");

      // Modify the file again
      await writeFileTool.execute({ path: "foo.txt", content: "hello v2\n" });

      // Verify that the working directory currently contains "hello v2"
      expect(readFileSync(join(root, "foo.txt"), "utf8")).toBe("hello v2\n");

      // Roll back to checkpoint 1
      if (cp1) {
        await rollbackToCheckpoint(cp1.ref, ["foo.txt"]);
      }

      // Verify that the file content was rolled back to "hello v1"
      expect(readFileSync(join(root, "foo.txt"), "utf8")).toBe("hello v1\n");

      // Cleanup checkpoints
      await cleanupCheckpoints("test-run-123");

      // Verify the ref is gone
      const { stdout } = await execFileP(
        "git",
        ["for-each-ref", "--format=%(refname)", "refs/singularity/checkpoints/test-run-123/"],
        { cwd }
      );
      expect(stdout.trim()).toBe("");
    });
  });
});
