/**
 * (2026-05-25) Tests for the tool-arg normalization layer added after the
 * develop-stage RCA discovered Claude haiku 4.5 routinely emits
 * `filePath` (camelCase) instead of the schema's `path`. Same pattern
 * for `diff` vs `patch`, `contents` vs `content`, etc. — habits from
 * other MCP-style toolkits the model has memorized.
 *
 * Without normalization, EVERY mutation tool call with the alias spelling
 * returned "path is required" and burned a turn before the agent figured
 * out the canonical name. Up to 8 of 15 mutation tool dispatches in one
 * develop run failed this way, sufficient to MAX_TURNS the whole stage.
 */
import { describe, it, expect } from "vitest";
import { normalizeToolArgs } from "../src/mcp/tool-run";

describe("normalizeToolArgs", () => {
  it("maps filePath -> path", () => {
    const { normalized, applied } = normalizeToolArgs({
      filePath: "src/main/x.java",
      oldText: "a",
      newText: "b",
    });
    expect(normalized.path).toBe("src/main/x.java");
    expect(normalized.oldText).toBe("a");
    expect(applied).toContainEqual({ from: "filePath", to: "path" });
  });

  it("maps file_path -> path (snake_case alias)", () => {
    const { normalized } = normalizeToolArgs({ file_path: "x.txt", content: "..." });
    expect(normalized.path).toBe("x.txt");
  });

  it("maps file -> path (Cursor convention)", () => {
    const { normalized } = normalizeToolArgs({ file: "x.txt" });
    expect(normalized.path).toBe("x.txt");
  });

  it("canonical name wins when both alias and canonical present", () => {
    // Operator intent: if the model emitted both, trust the schema-named one.
    const { normalized, applied } = normalizeToolArgs({
      path: "real.txt",
      filePath: "alias.txt",
    });
    expect(normalized.path).toBe("real.txt");
    // No normalization should fire because canonical was already populated.
    expect(applied).not.toContainEqual({ from: "filePath", to: "path" });
  });

  it("ignores empty-string canonical and uses alias instead", () => {
    // Edge case: some clients emit `path: ""` then put the real value in `filePath`.
    const { normalized, applied } = normalizeToolArgs({ path: "", filePath: "real.txt" });
    expect(normalized.path).toBe("real.txt");
    expect(applied).toContainEqual({ from: "filePath", to: "path" });
  });

  it("maps diff -> patch for apply_patch", () => {
    const { normalized, applied } = normalizeToolArgs({
      diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
    });
    expect(normalized.patch).toBe("--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n");
    expect(applied).toContainEqual({ from: "diff", to: "patch" });
  });

  it("maps unified_diff -> patch", () => {
    const { normalized } = normalizeToolArgs({ unified_diff: "patch text" });
    expect(normalized.patch).toBe("patch text");
  });

  it("maps contents -> content for write_file", () => {
    const { normalized } = normalizeToolArgs({ path: "x.txt", contents: "hello" });
    expect(normalized.content).toBe("hello");
  });

  it("maps body -> content (another common alias)", () => {
    const { normalized } = normalizeToolArgs({ path: "x.txt", body: "hello" });
    expect(normalized.content).toBe("hello");
  });

  it("maps replace_text snake_case aliases", () => {
    const { normalized, applied } = normalizeToolArgs({
      filePath: "x.txt",
      old_text: "a",
      new_text: "b",
    });
    expect(normalized.path).toBe("x.txt");
    expect(normalized.oldText).toBe("a");
    expect(normalized.newText).toBe("b");
    expect(applied).toContainEqual({ from: "filePath", to: "path" });
    expect(applied).toContainEqual({ from: "old_text", to: "oldText" });
    expect(applied).toContainEqual({ from: "new_text", to: "newText" });
  });

  it("maps replace_range line aliases", () => {
    const { normalized } = normalizeToolArgs({
      file: "x.txt",
      from: 10,
      to: 20,
      replacement_text: "new",
    });
    expect(normalized.path).toBe("x.txt");
    expect(normalized.startLine).toBe(10);
    expect(normalized.endLine).toBe(20);
    expect(normalized.replacement).toBe("new");
  });

  it("returns empty `applied` when no aliases hit", () => {
    const { normalized, applied } = normalizeToolArgs({
      path: "x.txt",
      content: "hi",
    });
    expect(normalized).toEqual({ path: "x.txt", content: "hi" });
    expect(applied).toEqual([]);
  });

  it("does not invent fields the caller didn't send", () => {
    // Original ask = a read_file call; no mutation aliases present.
    const { normalized, applied } = normalizeToolArgs({ path: "x.txt" });
    expect(normalized).toEqual({ path: "x.txt" });
    expect(applied).toEqual([]);
    // patch / content / etc. must NOT appear.
    expect(normalized).not.toHaveProperty("patch");
    expect(normalized).not.toHaveProperty("content");
  });

  it("preserves all original keys verbatim, only adds canonical ones", () => {
    // Some tools take args we don't alias (expected_hash, occurrence, etc.).
    // Those must round-trip exactly.
    const { normalized } = normalizeToolArgs({
      filePath: "x.txt",
      oldText: "a",
      newText: "b",
      occurrence: "all",
      expected_replacements: 3,
      expected_hash: "abc",
    });
    expect(normalized.path).toBe("x.txt");
    expect(normalized.filePath).toBe("x.txt"); // original kept
    expect(normalized.occurrence).toBe("all");
    expect(normalized.expected_replacements).toBe(3);
    expect(normalized.expected_hash).toBe("abc");
  });

  it("null canonical falls through to alias", () => {
    const { normalized } = normalizeToolArgs({ path: null, filePath: "x.txt" });
    expect(normalized.path).toBe("x.txt");
  });
});
