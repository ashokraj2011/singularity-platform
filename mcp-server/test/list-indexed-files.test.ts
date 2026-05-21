/**
 * Unit test for listIndexedFiles — exercises the SQL + glob path without
 * pulling in tree-sitter. We construct a minimal in-memory sql.js DB with the
 * same `files` schema the indexer uses, populate it directly, then verify the
 * tool returns the expected slices.
 *
 * This deliberately bypasses indexWorkspace() because that requires the
 * tree-sitter WASM grammars on disk, which adds ~2s of setup and isn't what
 * we're testing here.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { withSandboxRoot } from "../src/workspace/sandbox";

// We import the tool indirectly through the registry so we test the wired-up
// shape the LLM would see.
import { getLocalTool } from "../src/tools/registry";

async function withTempSandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "mcp-listidx-"));
  try {
    return await withSandboxRoot(root, () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Populate the in-memory AST index `files` table directly via the same sql.js
 * driver the production indexer uses. We mirror the indexer's schema and
 * insert path values using the host OS separator so the tool's
 * POSIX-normalisation path is also exercised.
 */
async function seedIndex(rows: Array<{ path: string; language: string; size: number }>) {
  const initSqlJs = (await import("sql.js")).default;
  const sql = await initSqlJs();
  const db = new sql.Database();
  db.run(`CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY, hash TEXT NOT NULL, language TEXT NOT NULL,
    size INTEGER NOT NULL, branch TEXT, head_sha TEXT, indexed_at TEXT NOT NULL
  );`);
  const stmt = db.prepare(
    `INSERT INTO files(path, hash, language, size, branch, head_sha, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const r of rows) {
    stmt.run([r.path, "fake-hash", r.language, r.size, null, null, now]);
  }
  stmt.free();
  return db;
}

describe("list_indexed_files tool", () => {
  // Each test gets a fresh sandbox, but since the AST index DB is loaded from
  // ~/.singularity-mcp/ast-index.sqlite (process-global, NOT per-sandbox), we
  // need to delegate to the underlying listIndexedFiles function with a stub.
  // Reuse the existing approach: write a real ast-index.sqlite into the
  // sandbox's expected DB path using sql.js, then call the tool.

  it("is registered in the tool registry", () => {
    const tool = getLocalTool("list_indexed_files");
    expect(tool).toBeDefined();
    expect(tool?.descriptor.risk_level).toBe("LOW");
    expect(tool?.descriptor.requires_approval).toBe(false);
  });

  it("queries the index, filters by glob, and POSIX-normalises paths", async () => {
    await withTempSandbox(async (root) => {
      // The production loader stores the AST DB at
      // `<sandbox>/.singularity/mcp-ast.sqlite`. Seed one there before calling
      // the tool — getDb() will then load our hand-crafted file.
      const dbPath = join(root, ".singularity", "mcp-ast.sqlite");
      mkdirSync(join(root, ".singularity"), { recursive: true });
      const db = await seedIndex([
        // Use OS-native separators on insert; listIndexedFiles normalises on read.
        { path: ["src", "main", "java", "Operator.java"].join(sep), language: "java", size: 120 },
        { path: ["src", "main", "java", "RuleEngineService.java"].join(sep), language: "java", size: 800 },
        { path: ["src", "test", "java", "RuleEngineServiceTest.java"].join(sep), language: "java", size: 600 },
        { path: ["README.md"].join(sep), language: "markdown", size: 50 },
        { path: ["app.ts"].join(sep), language: "typescript", size: 200 },
      ]);
      writeFileSync(dbPath, Buffer.from(db.export()));
      db.close();

      const tool = getLocalTool("list_indexed_files")!;

      // 1. No filter — returns everything
      const all = await tool.execute({});
      expect(all.success).toBe(true);
      const allOut = all.output as { files: Array<{ path: string }> };
      expect(allOut.files.length).toBe(5);
      // POSIX-style paths in the output regardless of host OS
      for (const f of allOut.files) expect(f.path).not.toContain("\\");

      // 2. Language filter
      const javaOnly = await tool.execute({ language: "java" });
      const javaOut = javaOnly.output as { files: Array<{ path: string; language: string }> };
      expect(javaOut.files).toHaveLength(3);
      expect(javaOut.files.every((f) => f.language === "java")).toBe(true);

      // 3. Glob — recursive
      const tests = await tool.execute({ pattern: "**/*Test*.java" });
      const testOut = tests.output as { files: Array<{ path: string }> };
      expect(testOut.files.map((f) => f.path)).toEqual(["src/test/java/RuleEngineServiceTest.java"]);

      // 4. Combined glob + language filter
      const services = await tool.execute({ pattern: "**/*Service.java", language: "java" });
      const servicesOut = services.output as { files: Array<{ path: string }> };
      expect(servicesOut.files.map((f) => f.path)).toEqual(["src/main/java/RuleEngineService.java"]);

      // 5. limit cap
      const limited = await tool.execute({ limit: 2 });
      const limOut = limited.output as { files: unknown[]; truncated: boolean };
      expect(limOut.files).toHaveLength(2);
      expect(limOut.truncated).toBe(true);
    });
  });
});
