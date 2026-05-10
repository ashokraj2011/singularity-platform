/**
 * M11 follow-up — OpenAI Chat Completions provider with tool-calling.
 *
 * Uses the v1 chat-completions surface (https://api.openai.com/v1/chat/completions).
 * Translates MCP's ToolDescriptorForLlm[] into OpenAI's `tools` shape and
 * normalises the response (incl. tool_calls) back into the unified
 * LlmResponse the MCP agent loop consumes.
 *
 * Same wire format is used by GitHub Copilot Headless — see ./copilot.ts.
 */
import { v4 as uuidv4 } from "uuid";
import type { LlmRequest, LlmResponse, ToolCall, ChatMessage } from "../types";
import { config } from "../../config";

interface OAToolSpec {
  type: "function";
  function: {
    name:        string;
    description: string;
    parameters:  Record<string, unknown>;
  };
}

interface OAMessage {
  role:    "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?:   string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id:       string;
    type:     "function";
    function: { name: string; arguments: string };
  }>;
}

interface OAResponse {
  choices: Array<{
    message:       OAMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens:     number;
    completion_tokens: number;
    total_tokens:      number;
  };
}

function toOpenAiTools(req: LlmRequest): OAToolSpec[] | undefined {
  if (!req.tools || req.tools.length === 0) return undefined;
  return req.tools.map((t) => ({
    type:     "function" as const,
    function: {
      name:        t.name,
      description: t.description,
      parameters:  (t.input_schema && Object.keys(t.input_schema).length > 0)
                     ? t.input_schema
                     : { type: "object", properties: {} },
    },
  }));
}

function toOpenAiMessages(messages: ChatMessage[]): OAMessage[] {
  return messages.map<OAMessage>((m) => {
    if (m.role === "tool") {
      return {
        role:         "tool",
        content:      m.content,
        tool_call_id: m.tool_call_id ?? "",
        name:         m.tool_name,
      };
    }
    if (m.role === "assistant") {
      // The MCP agent loop stringifies the assistant turn's tool_calls into
      // `content` (see invoke.ts: `state.messages.push({role:"assistant",
      // content: JSON.stringify({tool_calls: ...})})`). Reverse it here so
      // OpenAI sees the proper {tool_calls: [...]} shape — otherwise the
      // next-turn `tool` message gets rejected with "must be a response
      // to a preceeding message with 'tool_calls'".
      try {
        const parsed = JSON.parse(m.content) as { tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> };
        if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
          return {
            role:    "assistant",
            content: null,
            tool_calls: parsed.tool_calls.map((c) => ({
              id:       c.id,
              type:     "function",
              function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
            })),
          };
        }
      } catch { /* not JSON — treat as plain text below */ }
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Shared call helper: also used by ./copilot.ts which mostly differs in
 * base URL + headers. Returns a normalised LlmResponse.
 */
export async function callOpenAiCompatible(opts: {
  baseUrl:  string;
  apiKey:   string;
  model:    string;
  request:  LlmRequest;
  /** Extra headers (Copilot needs editor-version etc.). */
  extraHeaders?: Record<string, string>;
  /** Path under baseUrl. Defaults to /chat/completions. */
  path?: string;
}): Promise<LlmResponse> {
  const start = Date.now();
  const body: Record<string, unknown> = {
    model:    opts.model,
    messages: toOpenAiMessages(opts.request.messages),
  };
  if (opts.request.temperature !== undefined)        body.temperature = opts.request.temperature;
  if (opts.request.max_output_tokens !== undefined)  body.max_tokens  = opts.request.max_output_tokens;
  const tools = toOpenAiTools(opts.request);
  if (tools) {
    body.tools       = tools;
    body.tool_choice = "auto";
  }

  const url = `${opts.baseUrl.replace(/\/$/, "")}${opts.path ?? "/chat/completions"}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "content-type":  "application/json",
      authorization:   `Bearer ${opts.apiKey}`,
      ...(opts.extraHeaders ?? {}),
    },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout((config.TIMEOUT_SEC ?? 240) * 1000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI-compatible provider returned ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = JSON.parse(text) as OAResponse;
  const choice = data.choices?.[0];
  if (!choice) throw new Error("OpenAI-compatible provider returned no choices");

  const oaCalls = choice.message.tool_calls ?? [];
  const tool_calls: ToolCall[] = oaCalls.map((c) => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* keep empty */ }
    return { id: c.id || `tc-${uuidv4().slice(0, 8)}`, name: c.function.name, args };
  });

  const finish_reason: LlmResponse["finish_reason"] =
      tool_calls.length > 0       ? "tool_call"
    : choice.finish_reason === "stop"   ? "stop"
    : choice.finish_reason === "length" ? "length"
                                        : "stop";

  return {
    content:      choice.message.content ?? "",
    tool_calls:   tool_calls.length ? tool_calls : undefined,
    finish_reason,
    input_tokens:  data.usage?.prompt_tokens     ?? 0,
    output_tokens: data.usage?.completion_tokens ?? 0,
    latency_ms:   Date.now() - start,
  };
}

export async function openaiRespond(req: LlmRequest): Promise<LlmResponse> {
  if (!config.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  return callOpenAiCompatible({
    baseUrl: config.OPENAI_BASE_URL,
    apiKey:  config.OPENAI_API_KEY,
    model:   req.model || config.OPENAI_DEFAULT_MODEL,
    request: req,
  });
}
