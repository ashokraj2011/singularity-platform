import { v4 as uuidv4 } from "uuid";
import { ChatMessage, LlmRequest, LlmResponse, LlmStreamHooks, ToolCall } from "./types";

/**
 * Deterministic mock LLM provider — exercises the LLM↔tool agent loop
 * without external API calls or non-determinism.
 *
 * Heuristics for picking when to "call a tool":
 *   1. If the last user message contains "echo: <text>" pattern, emit
 *      a tool_call to `echo` with that text.
 *   2. If the last user message asks for time/timestamp/now, emit a
 *      tool_call to `current_time` (no args).
 *   3. If a tool message just arrived, return a final text answer that
 *      summarises the tool result.
 *   4. Otherwise, return a generic "no tool needed" stop response.
 *
 * Token counts are heuristic (chars/4). Latency is a small fixed sleep so
 * the audit looks realistic.
 */
function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i];
  }
  return undefined;
}

function lastToolMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") return messages[i];
  }
  return undefined;
}

function decideToolCall(
  msg: string,
  toolNames: Set<string>,
): ToolCall | null {
  const lower = msg.toLowerCase();
  // echo: <text>  →  echo tool
  const echoMatch = msg.match(/echo[:\s]+([^\n]+)/i);
  if (echoMatch && toolNames.has("echo")) {
    return {
      id: `tc-${uuidv4().slice(0, 8)}`,
      name: "echo",
      args: { text: echoMatch[1].trim() },
    };
  }
  // time / timestamp  →  current_time
  if (
    toolNames.has("current_time") &&
    /\b(time|timestamp|date|now|current\s+time)\b/.test(lower)
  ) {
    return {
      id: `tc-${uuidv4().slice(0, 8)}`,
      name: "current_time",
      args: {},
    };
  }
  // notify/escalate/page  →  notify_admin  (approval-gated tool)
  if (
    toolNames.has("notify_admin") &&
    /\b(notify|escalate|page|alert)\b/i.test(msg) &&
    /\b(admin|on[-\s]?call|ops)\b/i.test(msg)
  ) {
    return {
      id: `tc-${uuidv4().slice(0, 8)}`,
      name: "notify_admin",
      args: {
        subject: `User-requested escalation: ${msg.slice(0, 80)}`,
        body: msg,
      },
    };
  }
  // write <content> to <path>  →  write_file (M16) or write_file_demo (M13).
  // Prefer the real tool when available; fall back to the demo for legacy
  // smoke tests that haven't been migrated yet.
  if (toolNames.has("write_file") || toolNames.has("write_file_demo")) {
    const m = msg.match(/write\s+(.*?)\s+to\s+(\S+)/i);
    if (m) {
      return {
        id: `tc-${uuidv4().slice(0, 8)}`,
        name: toolNames.has("write_file") ? "write_file" : "write_file_demo",
        args: { path: m[2], content: m[1] },
      };
    }
  }
  // commit / commit message  →  git_commit (M16).
  if (toolNames.has("git_commit")) {
    const m = msg.match(/(?:commit|commit message)\s*[:\-]?\s*(.+)$/i);
    if (m) {
      return {
        id: `tc-${uuidv4().slice(0, 8)}`,
        name: "git_commit",
        args: { message: m[1].trim().slice(0, 200) },
      };
    }
  }
  return null;
}

export async function mockLlmRespond(req: LlmRequest, hooks?: LlmStreamHooks): Promise<LlmResponse> {
  const start = Date.now();
  await delay(40); // simulate latency

  const inputTextSize = req.messages.reduce((n, m) => n + m.content.length, 0);
  const input_tokens = approxTokens(req.messages.map((m) => m.content).join("\n"));
  const toolNames = new Set((req.tools ?? []).map((t) => t.name));

  // If a tool result just arrived, summarise and stop.
  const lastTool = lastToolMessage(req.messages);
  const lastUser = lastUserMessage(req.messages);

  if (lastTool && req.messages[req.messages.length - 1].role === "tool") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lastTool.content);
    } catch {
      parsed = lastTool.content;
    }
    const reply = `[mock] Tool '${lastTool.tool_name}' returned: ${JSON.stringify(parsed)}. Done.`;
    await hooks?.onDelta?.({ content: reply });
    return {
      content: reply,
      finish_reason: "stop",
      input_tokens,
      output_tokens: approxTokens(reply),
      latency_ms: Date.now() - start,
    };
  }

  // Decide whether to emit a tool call based on the user's message.
  if (lastUser) {
    const tc = decideToolCall(lastUser.content, toolNames);
    if (tc) {
      return {
        content: "",
        tool_calls: [tc],
        finish_reason: "tool_call",
        input_tokens,
        output_tokens: 0,
        latency_ms: Date.now() - start,
      };
    }
  }

  const reply = `[mock] Received ${req.messages.length} message(s) (${inputTextSize} chars). No tool call needed.`;
  await hooks?.onDelta?.({ content: reply });
  return {
    content: reply,
    finish_reason: "stop",
    input_tokens,
    output_tokens: approxTokens(reply),
    latency_ms: Date.now() - start,
  };
}
