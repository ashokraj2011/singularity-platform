import { describe, expect, it } from "vitest";
import { applySlidingWindow } from "../src/mcp/invoke";

function toolAssistant(calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>) {
  return {
    role: "assistant",
    content: JSON.stringify({ tool_calls: calls.map((call) => ({ args: {}, ...call })) }),
  };
}

function toolResult(id: string, content: unknown) {
  return {
    role: "tool",
    tool_call_id: id,
    tool_name: "test_tool",
    content: JSON.stringify(content),
  };
}

describe("applySlidingWindow", () => {
  it("keeps the newest assistant tool-call exchange even when the prompt already exceeds the token cap", () => {
    const state = {
      messages: [
        { role: "system", content: "x".repeat(8000) },
        { role: "user", content: "Implement containsACharacter operator." },
        toolAssistant([{ id: "old-1", name: "index_workspace" }]),
        toolResult("old-1", { success: true, indexedFiles: 12 }),
        toolAssistant([
          { id: "new-1", name: "index_workspace" },
          { id: "new-2", name: "list_directory", args: { path: "src" } },
        ]),
        toolResult("new-1", { success: true, indexedFiles: 12 }),
        toolResult("new-2", { success: true, path: "src", entries: ["RuleEngine.ts"] }),
      ],
      maxHistoryTokens: 1,
      maxHistoryMessages: 4,
      contextCompression: {
        messagesDropped: 0,
        tokensDropped: 0,
        toolResultsCompressed: 0,
        toolResultBytesSaved: 0,
      },
      breadcrumbs: [],
    } as Parameters<typeof applySlidingWindow>[0];

    applySlidingWindow(state);

    const contents = state.messages.map((msg) => msg.content).join("\n");
    expect(contents).toContain("Implement containsACharacter operator.");
    expect(contents).toContain("new-1");
    expect(contents).toContain("new-2");
    expect(contents).not.toContain("old-1");
    expect(state.messages.filter((msg) => msg.role === "tool").map((msg) => msg.tool_call_id)).toEqual([
      "new-1",
      "new-2",
    ]);
    expect(state.breadcrumbs.length).toBeGreaterThan(0);
  });
});
