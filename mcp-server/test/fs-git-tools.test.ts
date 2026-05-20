import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verificationUnavailableTool } from "../src/tools/command";
import { applyPatchTool, replaceRangeTool, replaceTextTool, writeFileTool } from "../src/tools/fs-git";
import { withSandboxRoot } from "../src/workspace/sandbox";

async function withTempSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "mcp-fs-git-"));
  try {
    return await withSandboxRoot(root, () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("MCP fs/git tools", () => {
  it("apply_patch modifies intended lines and preserves the rest of the file", async () => {
    await withTempSandbox(async (root) => {
      const initial = [
        "export function add(a: number, b: number) {",
        "  return a + b",
        "}",
        "",
        "export function sub(a: number, b: number) {",
        "  return a - b",
        "}",
        "",
      ].join("\n");
      await writeFileTool.execute({ path: "src/example.ts", content: initial });

      const patch = [
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,6 +1,6 @@",
        " export function add(a: number, b: number) {",
        "-  return a + b",
        "+  return Number(a) + Number(b)",
        " }",
        " ",
        " export function sub(a: number, b: number) {",
        "   return a - b",
        "",
      ].join("\n");
      const result = await applyPatchTool.execute({ patch });

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        kind: "code_change",
        paths_touched: ["src/example.ts"],
        lines_added: 1,
        lines_removed: 1,
      });
      expect(readFileSync(join(root, "src/example.ts"), "utf8")).toBe(
        initial.replace("  return a + b", "  return Number(a) + Number(b)"),
      );
    });
  });

  it("apply_patch rejects context mismatches without changing the file", async () => {
    await withTempSandbox(async (root) => {
      const initial = "export const value = 1;\n";
      await writeFileTool.execute({ path: "src/value.ts", content: initial });

      const result = await applyPatchTool.execute({
        patch: [
          "--- a/src/value.ts",
          "+++ b/src/value.ts",
          "@@ -1 +1 @@",
          "-export const value = 2;",
          "+export const value = 3;",
          "",
        ].join("\n"),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("patch failed");
      expect(readFileSync(join(root, "src/value.ts"), "utf8")).toBe(initial);
    });
  });

  it("apply_patch rejects traversal paths before applying", async () => {
    await withTempSandbox(async (root) => {
      const initial = "export const value = 1;\n";
      await writeFileTool.execute({ path: "src/value.ts", content: initial });

      const result = await applyPatchTool.execute({
        patch: [
          "--- a/src/value.ts",
          "+++ b/../outside.ts",
          "@@ -1 +1 @@",
          "-export const value = 1;",
          "+export const value = 2;",
          "",
        ].join("\n"),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("escapes the sandbox");
      expect(readFileSync(join(root, "src/value.ts"), "utf8")).toBe(initial);
    });
  });

  it("apply_patch rejects traversal in diff --git headers before applying", async () => {
    await withTempSandbox(async (root) => {
      const initial = "export const value = 1;\n";
      await writeFileTool.execute({ path: "src/value.ts", content: initial });

      const result = await applyPatchTool.execute({
        patch: [
          "diff --git a/src/value.ts b/../outside.ts",
          "--- a/src/value.ts",
          "+++ b/src/value.ts",
          "@@ -1 +1 @@",
          "-export const value = 1;",
          "+export const value = 2;",
          "",
        ].join("\n"),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("escapes the sandbox");
      expect(readFileSync(join(root, "src/value.ts"), "utf8")).toBe(initial);
    });
  });

  it("apply_patch can delete one file without touching siblings", async () => {
    await withTempSandbox(async (root) => {
      await writeFileTool.execute({ path: "src/delete-me.ts", content: "export const gone = true;\n" });
      await writeFileTool.execute({ path: "src/keep-me.ts", content: "export const keep = true;\n" });

      const result = await applyPatchTool.execute({
        patch: [
          "diff --git a/src/delete-me.ts b/src/delete-me.ts",
          "deleted file mode 100644",
          "--- a/src/delete-me.ts",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-export const gone = true;",
          "",
        ].join("\n"),
      });

      expect(result.success).toBe(true);
      expect(existsSync(join(root, "src/delete-me.ts"))).toBe(false);
      expect(readFileSync(join(root, "src/keep-me.ts"), "utf8")).toBe("export const keep = true;\n");
    });
  });

  it("write_file still creates and overwrites files with complete content", async () => {
    await withTempSandbox(async (root) => {
      const first = await writeFileTool.execute({ path: "notes.txt", content: "one\n" });
      const second = await writeFileTool.execute({ path: "notes.txt", content: "two\nthree\n" });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("two\nthree\n");
    });
  });

  it("write_file rejects unified-diff-looking content for an existing file", async () => {
    await withTempSandbox(async (root) => {
      const initial = "export const value = 1;\n";
      await writeFileTool.execute({ path: "src/value.ts", content: initial });

      const result = await writeFileTool.execute({
        path: "src/value.ts",
        content: [
          "@@ -1 +1 @@",
          "-export const value = 1;",
          "+export const value = 2;",
          "",
        ].join("\n"),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Use apply_patch");
      expect(readFileSync(join(root, "src/value.ts"), "utf8")).toBe(initial);
    });
  });

  it("replace_text applies an exact anchored edit and preserves the rest of the file", async () => {
    await withTempSandbox(async (root) => {
      const initial = "alpha\nbeta\ngamma\nbeta\n";
      await writeFileTool.execute({ path: "notes.txt", content: initial });

      const result = await replaceTextTool.execute({
        path: "notes.txt",
        oldText: "beta",
        newText: "BETA",
        occurrence: 2,
      });

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        kind: "code_change",
        paths_touched: ["notes.txt"],
      });
      expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("alpha\nbeta\ngamma\nBETA\n");
    });
  });

  it("replace_text fails without mutation when anchor text is missing", async () => {
    await withTempSandbox(async (root) => {
      const initial = "alpha\nbeta\n";
      await writeFileTool.execute({ path: "notes.txt", content: initial });

      const result = await replaceTextTool.execute({
        path: "notes.txt",
        oldText: "delta",
        newText: "DELTA",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("oldText was not found");
      expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe(initial);
    });
  });

  it("replace_range applies line-bounded edits and rejects invalid ranges without mutation", async () => {
    await withTempSandbox(async (root) => {
      const initial = "one\ntwo\nthree\nfour\n";
      await writeFileTool.execute({ path: "notes.txt", content: initial });

      const applied = await replaceRangeTool.execute({
        path: "notes.txt",
        startLine: 2,
        endLine: 3,
        replacement: "TWO\nTHREE",
      });
      expect(applied.success).toBe(true);
      expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("one\nTWO\nTHREE\nfour\n");

      const rejected = await replaceRangeTool.execute({
        path: "notes.txt",
        startLine: 7,
        endLine: 8,
        replacement: "bad",
      });
      expect(rejected.success).toBe(false);
      expect(rejected.error).toContain("file has 4 line");
      expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("one\nTWO\nTHREE\nfour\n");
    });
  });

  it("verification_unavailable emits a structured receipt", async () => {
    const result = await verificationUnavailableTool.execute({
      reason: "No package manager or test runner detected",
      inspected: ["README.md"],
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      kind: "verification_result",
      verification_kind: "unavailable",
      command: "verification_unavailable",
      unavailable: true,
      risk_accepted_required: true,
    });
  });
});
