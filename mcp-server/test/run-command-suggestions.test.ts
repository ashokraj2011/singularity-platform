/**
 * M47.A — run_command rejection should suggest the MCP-native equivalent
 * when the model reached for a classic OS verb (find/grep/cat/wc/ls/…).
 *
 * The audit log showed the agent repeatedly trying `run_command(find ...)`
 * even after the v4.4 contract prompt forbids it. Adding the suggestion at
 * point of rejection short-circuits the retry loop.
 */
import { describe, expect, it } from "vitest";
import { runCommandTool, runTestTool } from "../src/tools/command";

describe("M47.A run_command OS-verb suggestions", () => {
  it("rejects `find` with a find_files suggestion", async () => {
    const res = await runCommandTool.execute({ command: "find", args: [".", "-name", "*.java"] });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/find_files/);
    expect(res.error).toMatch(/MCP-native/);
  });

  it("rejects `grep` with a search_code suggestion", async () => {
    const res = await runCommandTool.execute({ command: "grep", args: ["-r", "TODO", "src/"] });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/search_code|grep_lines/);
  });

  it("rejects `cat` with a read_file / get_ast_slice suggestion", async () => {
    const res = await runCommandTool.execute({ command: "cat", args: ["src/Foo.java"] });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/read_file|get_ast_slice/);
  });

  it("rejects `wc` with a file_stats / list_indexed_files suggestion", async () => {
    const res = await runCommandTool.execute({ command: "wc", args: ["-l", "src/Foo.java"] });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/file_stats|list_indexed_files/);
  });

  it("rejects `ls` with a list_directory suggestion", async () => {
    const res = await runCommandTool.execute({ command: "ls", args: ["-la"] });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/list_directory/);
  });

  it("rejects unknown verbs without a suggestion tail", async () => {
    const res = await runCommandTool.execute({ command: "supercaliforensics" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not in the MCP verification allowlist/);
    // No suggestion should be appended for verbs we don't recognise
    expect(res.error).not.toMatch(/MCP-native/);
  });

  it("run_test (the verifier sister tool) also surfaces the same suggestion", async () => {
    const res = await runTestTool.execute({ command: "find", args: [".", "-name", "*.java"] });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/find_files/);
  });
});
