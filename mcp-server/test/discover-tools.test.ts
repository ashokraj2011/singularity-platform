import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findFilesTool, fileStatsTool, grepLinesTool } from "../src/tools/discover";
import { withSandboxRoot } from "../src/workspace/sandbox";

async function withTempSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "mcp-discover-"));
  try {
    return await withSandboxRoot(root, () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("M42.8 discover tools", () => {
  describe("find_files", () => {
    it("matches a flat glob pattern", async () => {
      await withTempSandbox(async (root) => {
        writeFileSync(join(root, "Operator.java"), "// stub");
        writeFileSync(join(root, "RuleEngineService.java"), "// stub");
        writeFileSync(join(root, "README.md"), "# stub");

        const res = await findFilesTool.execute({ pattern: "*.java" });
        expect(res.success).toBe(true);
        const out = res.output as { files: Array<{ path: string }> };
        const names = out.files.map((f) => f.path).sort();
        expect(names).toEqual(["Operator.java", "RuleEngineService.java"]);
      });
    });

    it("matches a recursive glob with ** and supports nested dirs", async () => {
      await withTempSandbox(async (root) => {
        mkdirSync(join(root, "src", "main", "java"), { recursive: true });
        writeFileSync(join(root, "src", "main", "java", "Foo.java"), "// stub");
        mkdirSync(join(root, "src", "test", "java"), { recursive: true });
        writeFileSync(join(root, "src", "test", "java", "FooTest.java"), "// stub");

        const res = await findFilesTool.execute({ pattern: "**/*Test*.java" });
        expect(res.success).toBe(true);
        const out = res.output as { files: Array<{ path: string }> };
        // Path emitted is POSIX-style regardless of host OS.
        expect(out.files.some((f) => f.path === "src/test/java/FooTest.java")).toBe(true);
        expect(out.files.some((f) => f.path === "src/main/java/Foo.java")).toBe(false);
      });
    });

    it("skips node_modules and .git by default", async () => {
      await withTempSandbox(async (root) => {
        mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
        writeFileSync(join(root, "node_modules", "pkg", "index.js"), "// skip");
        mkdirSync(join(root, ".git", "objects"), { recursive: true });
        writeFileSync(join(root, ".git", "objects", "blob.js"), "// skip");
        writeFileSync(join(root, "index.js"), "// keep");

        const res = await findFilesTool.execute({ pattern: "**/*.js" });
        const out = res.output as { files: Array<{ path: string }> };
        const paths = out.files.map((f) => f.path);
        expect(paths).toContain("index.js");
        expect(paths.every((p) => !p.startsWith("node_modules") && !p.startsWith(".git"))).toBe(true);
      });
    });

    it("respects max_results cap", async () => {
      await withTempSandbox(async (root) => {
        for (let i = 0; i < 20; i++) writeFileSync(join(root, `file${i}.txt`), `${i}`);
        const res = await findFilesTool.execute({ pattern: "*.txt", max_results: 5 });
        const out = res.output as { count: number; truncated: boolean };
        expect(out.count).toBe(5);
        expect(out.truncated).toBe(true);
      });
    });
  });

  describe("file_stats", () => {
    it("reports line count, byte size, and language hint", async () => {
      await withTempSandbox(async (root) => {
        const content = ["line1", "line2", "line3", ""].join("\n");
        writeFileSync(join(root, "sample.ts"), content);

        const res = await fileStatsTool.execute({ paths: ["sample.ts"] });
        expect(res.success).toBe(true);
        const out = res.output as { stats: Array<{ path: string; lines: number; bytes: number; language?: string }> };
        expect(out.stats).toHaveLength(1);
        const s = out.stats[0];
        expect(s.lines).toBe(3);
        expect(s.bytes).toBe(content.length);
        expect(s.language).toBe("typescript");
      });
    });

    it("handles multiple files and unknown extensions", async () => {
      await withTempSandbox(async (root) => {
        writeFileSync(join(root, "a.java"), "class A {}");
        writeFileSync(join(root, "b.unknownext"), "raw");
        const res = await fileStatsTool.execute({ paths: ["a.java", "b.unknownext"] });
        const out = res.output as { stats: Array<{ path: string; language?: string }> };
        expect(out.stats).toHaveLength(2);
        expect(out.stats.find((s) => s.path === "a.java")?.language).toBe("java");
        expect(out.stats.find((s) => s.path === "b.unknownext")?.language).toBeUndefined();
      });
    });
  });
});
