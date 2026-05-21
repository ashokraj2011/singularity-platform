/**
 * M46.B — Arity guard on replace_text.
 *
 * The "lazy-edit + broke-unrelated-tests" failure mode in the RuleEngine run:
 * the agent matched a short oldText (the closing `} }` near end-of-file)
 * and replaced it with a 216-line block. The replacement smashed the small
 * anchor + everything that was implicitly past it that the model didn't
 * realize was there → broke testIsNull and testIsNotNull.
 *
 * Hard reject when newLines - oldLines > 100 AND oldLines < 10.
 * Soft warning when newLines - oldLines > 50 AND oldLines < 5.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replaceTextTool, writeFileTool } from "../src/tools/fs-git";
import { withSandboxRoot } from "../src/workspace/sandbox";

async function withTempSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "mcp-arity-"));
  try {
    return await withSandboxRoot(root, () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("M46.B replace_text arity guard", () => {
  it("hard-rejects a tiny anchor with a huge replacement", async () => {
    await withTempSandbox(async (root) => {
      const original = [
        "class A {",
        "  void a() {}",
        "}",
        "",
      ].join("\n");
      await writeFileTool.execute({ path: "Big.java", content: original });

      // The bad shape: oldText is the closing brace (1 line),
      // newText adds 150 lines.
      const huge = Array.from({ length: 150 }, (_, i) => `  void m${i}() {}`).join("\n");
      const res = await replaceTextTool.execute({
        path: "Big.java",
        oldText: "}",
        newText: `${huge}\n}`,
      });

      expect(res.success).toBe(false);
      expect(res.error_code).toBe("VALIDATION");
      expect(res.error).toMatch(/arity guard/);
      expect(res.error).toMatch(/apply_patch/);

      // File must be untouched
      expect(readFileSync(join(root, "Big.java"), "utf8")).toBe(original);
    });
  });

  it("attaches a soft arity_warning when added > 50 and oldLines < 5", async () => {
    await withTempSandbox(async (root) => {
      const original = [
        "class A {",
        "}",
        "",
      ].join("\n");
      await writeFileTool.execute({ path: "Mid.java", content: original });

      // 51 lines added, oldText 1 line — should warn but still apply.
      const medium = Array.from({ length: 51 }, (_, i) => `  void m${i}() {}`).join("\n");
      const res = await replaceTextTool.execute({
        path: "Mid.java",
        oldText: "}",
        newText: `${medium}\n}`,
      });

      expect(res.success).toBe(true);
      const out = res.output as { arity_warning?: string };
      expect(out.arity_warning).toBeDefined();
      expect(out.arity_warning).toMatch(/apply_patch/);

      // File was modified
      expect(readFileSync(join(root, "Mid.java"), "utf8")).toContain("void m25()");
      void root;
    });
  });

  it("does NOT warn for legitimate moderate edits", async () => {
    await withTempSandbox(async (root) => {
      const original = "function foo() { return 1 }\n";
      await writeFileTool.execute({ path: "small.ts", content: original });

      // Multi-line replacement, but oldText also multi-line — net add ~30.
      const res = await replaceTextTool.execute({
        path: "small.ts",
        oldText: "function foo() { return 1 }",
        newText: "function foo() {\n" + Array.from({ length: 28 }, (_, i) => `  console.log(${i})`).join("\n") + "\n  return 1\n}",
      });

      expect(res.success).toBe(true);
      const out = res.output as { arity_warning?: string };
      expect(out.arity_warning).toBeUndefined();
      void root;
    });
  });

  it("does NOT warn when oldText is also large (legit refactor)", async () => {
    await withTempSandbox(async (root) => {
      const oldFn = "function foo() {\n" + Array.from({ length: 30 }, (_, i) => `  step${i}()`).join("\n") + "\n}";
      const newFn = "function foo() {\n" + Array.from({ length: 60 }, (_, i) => `  step${i}()`).join("\n") + "\n}";
      await writeFileTool.execute({ path: "refactor.ts", content: oldFn });

      const res = await replaceTextTool.execute({
        path: "refactor.ts",
        oldText: oldFn,
        newText: newFn,
      });
      // newLines − oldLines ≈ 30, oldLines = 32 → no guard triggers
      expect(res.success).toBe(true);
      const out = res.output as { arity_warning?: string };
      expect(out.arity_warning).toBeUndefined();
      void root;
    });
  });
});
