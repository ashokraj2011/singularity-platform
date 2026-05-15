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
 * M33 — Calls the central LLM gateway (`LLM_GATEWAY_URL`). Provider keys
 * live ONLY on the gateway. No fallback chain — gateway errors propagate
 * up; caller falls back to the RAW (JSON-layer) cache mode on null.
 */
import { llmRespond } from "@agentandtools/shared";
import { logger } from "../../config/logger";
import type { RetrievedChunk } from "./retrieval";

const TIMEOUT_MS = Number(process.env.CAPSULE_COMPILE_TIMEOUT_MS ?? 30_000);
const MODEL_ALIAS = process.env.CAPSULE_COMPILE_MODEL_ALIAS ?? "fast";

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
    const result = await Promise.race([
      llmRespond({
        model_alias: MODEL_ALIAS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message },
        ],
        temperature: 0,
        max_output_tokens: 800,
        trace_id: `capsule-compile-${Date.now()}`,
      }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("capsule compile timeout")), TIMEOUT_MS),
      ),
    ]);
    const paragraph = (result.content ?? "").trim();
    if (!paragraph) return null;
    return {
      paragraph,
      inputTokens:  result.input_tokens,
      outputTokens: result.output_tokens,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[capsule] LLM compile failed");
    return null;
  }
}

export function compileMode(): "RAW" | "LLM" {
  const raw = String(process.env.CAPSULE_COMPILE_MODE ?? "RAW").toUpperCase();
  return raw === "LLM" ? "LLM" : "RAW";
}
