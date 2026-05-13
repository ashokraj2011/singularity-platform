/**
 * M25.5.next — LLM-based capsule compiler.
 *
 * Takes the retrieved chunks for a (capability, agent, intent) tuple and
 * compresses them into ONE natural-language paragraph (≤500 words) that
 * preserves 〔cite: …〕 markers exactly. This is what turns the M25.5 cache
 * from a latency-win into a token-win — the next request with the same
 * task signature pays ~700 tokens for the paragraph instead of ~4k+ for
 * the raw chunks.
 *
 * Calls mcp-server `/mcp/invoke` with mock-fast by default. Failure path:
 * return null and the caller falls back to the RAW (JSON-layer) cache mode.
 */
import { logger } from "../../config/logger";
import type { RetrievedChunk } from "./retrieval";

const MCP_URL    = process.env.MCP_SERVER_URL    ?? "http://host.docker.internal:7100";
const MCP_BEARER = process.env.MCP_BEARER_TOKEN  ?? "demo-bearer-token-must-be-min-16-chars";
const TIMEOUT_MS = Number(process.env.CAPSULE_COMPILE_TIMEOUT_MS ?? 30_000);
const PROVIDER   = process.env.CAPSULE_COMPILE_PROVIDER ?? "mock";
const MODEL      = process.env.CAPSULE_COMPILE_MODEL    ?? "mock-fast";

const SYSTEM_PROMPT = `You are a Context Compiler.

INPUT: a list of retrieval chunks. Each chunk has a 〔cite: …〕 marker
that ties it to a source artifact or distilled memory.

TASK: produce ONE paragraph (≤500 words) that compresses every factual
claim across the chunks. Preserve every 〔cite: …〕 marker that backs a
claim you keep — drop only markers whose chunk you fully omitted. Do NOT
invent facts beyond the chunks. Do NOT add filler ("Based on the above…").

OUTPUT: just the paragraph. No headers, no JSON, no preamble.`;

export interface CapsuleCompileResult {
  paragraph: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function compileCapsuleViaLlm(
  intent: string,
  chunks: RetrievedChunk[],
): Promise<CapsuleCompileResult | null> {
  if (chunks.length === 0) return null;
  // Build the user message: intent + every chunk's body with its cite key.
  const body = chunks.map(c =>
    `${c.citation_key ? `〔cite: ${c.citation_key}〕\n` : ""}${c.excerpt}`,
  ).join("\n\n---\n\n");

  const message = `Intent: ${intent.trim().slice(0, 4000)}\n\n${body}`;

  try {
    const res = await fetch(`${MCP_URL.replace(/\/$/, "")}/mcp/invoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${MCP_BEARER}`,
      },
      body: JSON.stringify({
        systemPrompt: SYSTEM_PROMPT,
        message,
        tools: [],   // no tool calls; pure synthesis
        modelConfig: { provider: PROVIDER, model: MODEL, temperature: 0.0, maxTokens: 800 },
        runContext: { traceId: `capsule-compile-${Date.now()}` },
        limits: { maxSteps: 1, timeoutSec: Math.ceil(TIMEOUT_MS / 1000) },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "[capsule] LLM compile HTTP failure");
      return null;
    }
    const json = await res.json() as {
      success?: boolean;
      data?: {
        status: string;
        finalResponse: string;
        tokensUsed?: { input?: number; output?: number };
      };
    };
    if (!json.success || !json.data || json.data.status !== "COMPLETED") {
      logger.warn({ data: json.data }, "[capsule] LLM compile non-COMPLETED");
      return null;
    }
    const paragraph = (json.data.finalResponse ?? "").trim();
    if (!paragraph) return null;
    return {
      paragraph,
      inputTokens:  json.data.tokensUsed?.input,
      outputTokens: json.data.tokensUsed?.output,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[capsule] LLM compile threw");
    return null;
  }
}

export function compileMode(): "RAW" | "LLM" {
  const raw = String(process.env.CAPSULE_COMPILE_MODE ?? "RAW").toUpperCase();
  return raw === "LLM" ? "LLM" : "RAW";
}
