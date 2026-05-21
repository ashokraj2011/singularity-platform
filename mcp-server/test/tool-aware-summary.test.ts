/**
 * M44 Slice D — tool-aware tool-result compression. Verifies each per-tool
 * summarizer keeps the signal-bearing parts (paths, line numbers, exit codes)
 * while dropping noise (huge stdout tails, repeated match excerpts, long
 * file bodies).
 *
 * Returns null for short outputs (no compression needed) and for tools that
 * don't have a specialized summarizer (caller falls back to generic compactor).
 */
import { describe, expect, it } from "vitest";
import { toolAwareSummary } from "../src/mcp/invoke";

describe("M44 toolAwareSummary", () => {
  it("returns null for an unknown tool", () => {
    expect(toolAwareSummary("not_a_real_tool", { foo: "bar" })).toBeNull();
  });

  it("returns null for non-object output", () => {
    expect(toolAwareSummary("read_file", "raw string")).toBeNull();
    expect(toolAwareSummary("read_file", null)).toBeNull();
  });

  describe("read_file", () => {
    it("returns null for short files (no compression needed)", () => {
      expect(toolAwareSummary("read_file", { content: "short\nbody\n" })).toBeNull();
    });

    it("excerpts long files into head + tail", () => {
      const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
      const result = toolAwareSummary("read_file", { path: "Big.java", content: body }) as {
        content_excerpt: string;
        original_lines: number;
        original_chars: number;
      };
      expect(result.content_excerpt).toContain("line 0");      // head preserved
      expect(result.content_excerpt).toContain("line 199");    // tail preserved
      expect(result.content_excerpt).toContain("elided");      // marker present
      expect(result.original_lines).toBe(200);
      expect(result.original_chars).toBe(body.length);
    });
  });

  describe("search_code", () => {
    it("returns null for ≤8 matches", () => {
      const matches = Array.from({ length: 5 }, (_, i) => ({ file: `a${i}.ts`, line: i }));
      expect(toolAwareSummary("search_code", { matches })).toBeNull();
    });

    it("caps at 8 matches and reports total + truncated count", () => {
      const matches = Array.from({ length: 25 }, (_, i) => ({ file: `m${i}.ts`, line: i, excerpt: "x".repeat(100) }));
      const result = toolAwareSummary("search_code", { matches }) as {
        matches: unknown[]; truncated_matches: number; total_matches: number;
      };
      expect(result.matches).toHaveLength(8);
      expect(result.truncated_matches).toBe(17);
      expect(result.total_matches).toBe(25);
    });

    it("applies the same logic to grep_lines", () => {
      const matches = Array.from({ length: 12 }, (_, i) => ({ file: `g${i}.ts`, line: i }));
      const result = toolAwareSummary("grep_lines", { matches }) as { matches: unknown[]; total_matches: number };
      expect(result.matches).toHaveLength(8);
      expect(result.total_matches).toBe(12);
    });
  });

  describe("list_directory", () => {
    it("caps long directory listings", () => {
      const entries = Array.from({ length: 100 }, (_, i) => ({ name: `file${i}.ts`, type: "file" as const }));
      const result = toolAwareSummary("list_directory", { entries }) as {
        entries: unknown[]; truncated_entries: number; total_entries: number;
      };
      expect(result.entries).toHaveLength(40);
      expect(result.truncated_entries).toBe(60);
      expect(result.total_entries).toBe(100);
    });
  });

  describe("list_indexed_files", () => {
    it("caps long file lists", () => {
      const files = Array.from({ length: 50 }, (_, i) => ({ path: `src/Foo${i}.java`, language: "java" }));
      const result = toolAwareSummary("list_indexed_files", { files }) as {
        files: unknown[]; total_files: number;
      };
      expect(result.files).toHaveLength(20);
      expect(result.total_files).toBe(50);
    });
  });

  describe("run_command / run_test", () => {
    it("returns null for short outputs", () => {
      expect(toolAwareSummary("run_test", { stdout: "hi", stderr: "", exit_code: 0 })).toBeNull();
    });

    it("excerpts long stdout into head + tail keeping exit code visible", () => {
      const stdout = "stdout-line\n".repeat(500);  // ~6000 chars
      const result = toolAwareSummary("run_test", { stdout, stderr: "warn: x", exit_code: 0 }) as {
        stdout_head: string; stdout_tail?: string; stdout_chars: number; exit_code: number;
      };
      expect(result.stdout_head.length).toBeLessThanOrEqual(1500);
      expect(result.stdout_tail?.length ?? 0).toBeLessThanOrEqual(800);
      expect(result.stdout_chars).toBe(stdout.length);
      expect(result.exit_code).toBe(0);  // preserved
    });

    it("trims long stderr while keeping head", () => {
      const result = toolAwareSummary("run_command", {
        stdout: "x".repeat(2000), stderr: "err-".repeat(500), exit_code: 1,
      }) as { stderr: string };
      expect(result.stderr.length).toBeLessThan(800);
      expect(result.stderr).toContain("elided");
    });
  });

  describe("get_dependencies", () => {
    it("caps long dependency lists", () => {
      const deps = Array.from({ length: 60 }, (_, i) => ({ source: `dep${i}`, kind: "import", line: i }));
      const result = toolAwareSummary("get_dependencies", { dependencies: deps }) as {
        dependencies: unknown[]; total_dependencies: number;
      };
      expect(result.dependencies).toHaveLength(25);
      expect(result.total_dependencies).toBe(60);
    });
  });
});
