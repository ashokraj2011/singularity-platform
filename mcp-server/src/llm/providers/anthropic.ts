/**
 * M11 follow-up — Anthropic Messages API provider with tool-calling.
 *
 * Anthropic's API differs from OpenAI's:
 *   - System prompt is a top-level `system` field (not a system message).
 *   - Tools are declared as `[{name, description, input_schema}]`.
 *   - Tool calls come back as `content: [{type: "tool_use", id, name, input}]`.
 *   - Tool results are sent back as user messages with
 *     `content: [{type: "tool_result", tool_use_id, content}]`.
 *
 * We translate to/from MCP's unified types.
 */
import { v4 as uuidv4 } from "uuid";
import type { LlmRequest, LlmResponse, ToolCall, ChatMessage } from "../types";
import { config } from "../../config";

interface AntToolSpec {
  name:        string;
  description: string;
  input_schema: Record<string, unknown>;
}

type AntContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AntMessage {
  role:    "user" | "assistant";
  content: string | AntContentBlock[];
}

interface AntResponse {
  content:       AntContentBlock[];
  stop_reason:   string;
  usage?:        { input_tokens: number; output_tokens: number };
}

/**
 * Convert MCP messages → Anthropic. System messages get hoisted into the
 * top-level `system` field. Tool messages become user messages with a
 * `tool_result` content block (Anthropic's required round-trip shape).
 */
function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: AntMessage[] } {
  let system: string | undefined;
  const out: AntMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }
    if (m.role === "tool") {
      // Anthropic expects the tool result in a USER message with content blocks.
      out.push({
        role:    "user",
        content: [{
          type:        "tool_result",
          tool_use_id: m.tool_call_id ?? "",
          content:     m.content,
        }],
      });
      continue;
    }
    if (m.role === "assistant") {
      // If the previous assistant turn was a JSON-stringified tool_calls,
      // try to convert it back into a content array of tool_use blocks.
      // Otherwise pass as plain text.
      try {
        const parsed = JSON.parse(m.content) as { tool_calls?: ToolCall[] };
        if (parsed.tool_calls?.length) {
          out.push({
            role:    "assistant",
            content: parsed.tool_calls.map<AntContentBlock>((c) => ({
              type:  "tool_use",
              id:    c.id,
              name:  c.name,
              input: c.args,
            })),
          });
          continue;
        }
      } catch { /* not JSON, treat as text */ }
    }
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  return { system, messages: out };
}

function toAnthropicTools(req: LlmRequest): AntToolSpec[] | undefined {
  if (!req.tools || req.tools.length === 0) return undefined;
  return req.tools.map((t) => ({
    name:         t.name,
    description:  t.description,
    input_schema: (t.input_schema && Object.keys(t.input_schema).length > 0)
                    ? t.input_schema
                    : { type: "object", properties: {} },
  }));
}

export async function anthropicRespond(req: LlmRequest): Promise<LlmResponse> {
  if (!config.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");
  const start = Date.now();

  const { system, messages } = toAnthropicMessages(req.messages);
  const body: Record<string, unknown> = {
    model:      req.model || config.ANTHROPIC_DEFAULT_MODEL,
    messages,
    max_tokens: req.max_output_tokens ?? 4096,
  };
  if (system)                          body.system      = system;
  if (req.temperature !== undefined)   body.temperature = req.temperature;
  const tools = toAnthropicTools(req);
  if (tools) body.tools = tools;

  const url = `${config.ANTHROPIC_BASE_URL.replace(/\/$/, "")}/v1/messages`;
  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "content-type":     "application/json",
      "x-api-key":        config.ANTHROPIC_API_KEY,
      "anthropic-version": config.ANTHROPIC_VERSION,
    },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout((config.TIMEOUT_SEC ?? 240) * 1000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic returned ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text) as AntResponse;

  let textContent = "";
  const tool_calls: ToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") textContent += block.text;
    else if (block.type === "tool_use") {
      tool_calls.push({
        id:   block.id || `tc-${uuidv4().slice(0, 8)}`,
        name: block.name,
        args: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }

  const finish_reason: LlmResponse["finish_reason"] =
      tool_calls.length > 0      ? "tool_call"
    : data.stop_reason === "max_tokens" ? "length"
    : data.stop_reason === "end_turn"   ? "stop"
    : data.stop_reason === "tool_use"   ? "tool_call"
                                         : "stop";

  return {
    content:      textContent,
    tool_calls:   tool_calls.length ? tool_calls : undefined,
    finish_reason,
    input_tokens:  data.usage?.input_tokens  ?? 0,
    output_tokens: data.usage?.output_tokens ?? 0,
    latency_ms:   Date.now() - start,
  };
}
