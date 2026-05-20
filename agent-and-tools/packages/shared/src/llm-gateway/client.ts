/**
 * MCP-routed LLM client (TypeScript).
 *
 * EVERY non-MCP service that needs an LLM call must use MCP. Provider keys
 * and gateway URLs live outside caller services; MCP is the only gateway
 * client. The only allowed fallback is the deterministic in-process `mock`
 * mode, activated by setting `MCP_SERVER_URL=mock` in unit tests.
 *
 * Env contract (every consumer service):
 *   MCP_SERVER_URL      optional — http://mcp-server:7100 | mock
 *   MCP_BEARER_TOKEN    optional — service token for MCP auth
 *
 * M35.4 — request shapes are Zod-validated before POST. A malformed request
 * (no messages, wrong role, etc.) fails fast in the calling service.
 */
import { z } from "zod";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
} from "./types";

// ── M35.4 — Zod schemas mirroring ./types.ts ────────────────────────────
const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  tool_call_id: z.string().optional(),
  tool_name: z.string().optional(),
});

const ToolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  input_schema: z.record(z.unknown()),
});

const ChatCompletionRequestSchema = z.object({
  model_alias: z.string().min(1).optional(),
  messages: z.array(ChatMessageSchema).min(1, "messages cannot be empty"),
  tools: z.array(ToolDescriptorSchema).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  trace_id: z.string().optional(),
  run_id: z.string().optional(),
  capability_id: z.string().optional(),
});

const EmbeddingsRequestSchema = z.object({
  model_alias: z.string().min(1).optional(),
  input: z.array(z.string()).min(1, "input cannot be empty"),
  trace_id: z.string().optional(),
  capability_id: z.string().optional(),
});

const MOCK_SENTINEL = "mock";

type McpInvokeData = {
  status?: string;
  finalResponse?: string;
  finishReason?: string;
  tokensUsed?: {
    input?: number;
    output?: number;
    total?: number;
  };
  modelUsage?: {
    provider?: string;
    model?: string;
    modelAlias?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
};

type McpInvokeEnvelope = {
  success?: boolean;
  data?: McpInvokeData;
};

type McpEmbedEnvelope = {
  success?: boolean;
  data?: EmbeddingsResponse;
};

function mcpUrl(): string {
  return (process.env.MCP_SERVER_URL?.trim() || "http://mcp-server:7100").replace(/\/$/, "");
}

function mcpBearer(): string | undefined {
  return process.env.MCP_BEARER_TOKEN?.trim() || undefined;
}

function mcpTimeoutMs(): number {
  const raw = process.env.MCP_TIMEOUT_SEC;
  const n = raw ? Number(raw) : 240;
  return Math.max(1, n) * 1000;
}

function splitMessages(messages: ChatCompletionRequest["messages"]): {
  systemPrompt?: string;
  history: ChatCompletionRequest["messages"];
  message: string;
} {
  const systemPrompt = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
    .trim();
  const conversational = messages.filter((m) => m.role !== "system");
  const lastUserIndex = [...conversational].map((m) => m.role).lastIndexOf("user");
  const messageIndex = lastUserIndex >= 0 ? lastUserIndex : conversational.length - 1;
  const chosen = conversational[messageIndex];
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    history: conversational.filter((_, index) => index !== messageIndex),
    message: chosen?.content ?? "Continue.",
  };
}

function normalizeFinishReason(reason: string | undefined): ChatCompletionResponse["finish_reason"] {
  if (reason === "stop" || reason === "tool_call" || reason === "length" || reason === "error") return reason;
  if (reason === "max_steps") return "length";
  return "error";
}

async function invokeMcp(req: ChatCompletionRequest): Promise<McpInvokeData> {
  const url = mcpUrl();
  if (url === MOCK_SENTINEL) {
    const { mockHandle } = await import("./mock-handler");
    const mock = await mockHandle("chat", req) as ChatCompletionResponse;
    return {
      status: "COMPLETED",
      finalResponse: mock.content,
      finishReason: mock.finish_reason,
      tokensUsed: { input: mock.input_tokens, output: mock.output_tokens },
      modelUsage: {
        provider: mock.provider,
        model: mock.model,
        modelAlias: mock.model_alias,
        inputTokens: mock.input_tokens,
        outputTokens: mock.output_tokens,
      },
    };
  }
  const { systemPrompt, history, message } = splitMessages(req.messages);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = mcpBearer();
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${url}/mcp/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(systemPrompt ? { systemPrompt } : {}),
      history,
      message,
      tools: req.tools ?? [],
      modelConfig: {
        ...(req.model_alias ? { modelAlias: req.model_alias } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.max_output_tokens !== undefined ? { maxTokens: req.max_output_tokens } : {}),
      },
      runContext: {
        traceId: req.trace_id,
        runId: req.run_id,
        capabilityId: req.capability_id,
      },
      limits: {
        maxSteps: req.tools?.length ? 6 : 1,
        timeoutSec: Math.ceil(mcpTimeoutMs() / 1000),
        compressToolResults: true,
        includeLocalTools: false,
      },
    }),
    signal: AbortSignal.timeout(mcpTimeoutMs()),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP /mcp/invoke -> ${res.status}: ${text.slice(0, 500)}`);
  }
  let envelope: McpInvokeEnvelope;
  try {
    envelope = JSON.parse(text) as McpInvokeEnvelope;
  } catch (err) {
    throw new Error(`MCP /mcp/invoke returned malformed JSON: ${(err as Error).message}`);
  }
  if (envelope.success === false) {
    throw new Error("MCP returned success=false");
  }
  return envelope.data ?? {};
}

/** One-shot chat completion call through MCP. */
export async function llmRespond(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  // M35.4 — fail-fast validation before the wire call. Clear error from the
  // calling service beats a generic 422 from MCP with no context.
  const validation = ChatCompletionRequestSchema.safeParse(req);
  if (!validation.success) {
    const issues = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`MCP-routed LLM request validation failed: ${issues}`);
  }
  // Additional sanity check: tools without a system or user message means
  // the model has nothing to respond to. Easy to hit when callers compose
  // the request lazily and forget to seed the conversation.
  if (req.tools && req.tools.length > 0 && req.messages.length < 1) {
    throw new Error(
      `MCP-routed LLM request invalid: tools provided (${req.tools.length}) but messages is empty — the model has nothing to act on`,
    );
  }
  const data = await invokeMcp(req);
  const inputTokens = data.tokensUsed?.input ?? data.modelUsage?.inputTokens ?? 0;
  const outputTokens = data.tokensUsed?.output ?? data.modelUsage?.outputTokens ?? 0;
  return {
    content: data.finalResponse ?? "",
    finish_reason: normalizeFinishReason(data.finishReason),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    latency_ms: 0,
    provider: data.modelUsage?.provider ?? "mcp",
    model: data.modelUsage?.model ?? req.model_alias ?? "mcp-default",
    model_alias: data.modelUsage?.modelAlias ?? req.model_alias,
  };
}

/** Batched embeddings call through MCP. */
export async function llmEmbed(req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
  // M35.4 — fail-fast validation before the wire call.
  const validation = EmbeddingsRequestSchema.safeParse(req);
  if (!validation.success) {
    const issues = validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`MCP-routed embeddings validation failed: ${issues}`);
  }
  if (mcpUrl() === MOCK_SENTINEL) {
    const { mockHandle } = await import("./mock-handler");
    return mockHandle("embeddings", req) as Promise<EmbeddingsResponse>;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = mcpBearer();
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${mcpUrl()}/mcp/embed`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(req.model_alias ? { modelAlias: req.model_alias } : {}),
      input: req.input,
      runContext: {
        traceId: req.trace_id,
        capabilityId: req.capability_id,
      },
    }),
    signal: AbortSignal.timeout(mcpTimeoutMs()),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP /mcp/embed -> ${res.status}: ${text.slice(0, 500)}`);
  }
  let envelope: McpEmbedEnvelope;
  try {
    envelope = JSON.parse(text) as McpEmbedEnvelope;
  } catch (err) {
    throw new Error(`MCP /mcp/embed returned malformed JSON: ${(err as Error).message}`);
  }
  if (envelope.success === false || !envelope.data) {
    throw new Error("MCP /mcp/embed returned no embedding data");
  }
  return envelope.data;
}

/** True iff env tells us to short-circuit to the in-process mock. */
export function isGatewayMockMode(): boolean {
  return (process.env.MCP_SERVER_URL ?? "").trim() === MOCK_SENTINEL;
}
