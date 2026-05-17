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
const MODEL_ALIAS = process.env.CAPSULE_COMPILE_MODEL_ALIAS?.trim();

// M36.4 — capsule-compiler system prompt now lives in the SystemPrompt table
// (key "prompt-composer.capsule-compiler"). Since this file IS inside
// prompt-composer, we read directly from Prisma instead of going through the
// HTTP shared client. Cached in-process for the lifetime of the worker so we
// don't query the DB on every compile.
import { prisma } from "../../config/prisma";

const SYSTEM_PROMPT_KEY = "prompt-composer.capsule-compiler";
let cachedSystemPrompt: string | null = null;
let cachedAt = 0;
const SYSTEM_PROMPT_TTL_MS = Number(process.env.SYSTEM_PROMPT_CACHE_TTL_SEC ?? 300) * 1000;

async function loadSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt && Date.now() - cachedAt < SYSTEM_PROMPT_TTL_MS) {
    return cachedSystemPrompt;
  }
  const row = await prisma.systemPrompt.findFirst({
    where: { key: SYSTEM_PROMPT_KEY, isActive: true },
    orderBy: { version: "desc" },
  });
  if (!row) {
    throw new Error(
      `Capsule compiler missing required SystemPrompt key "${SYSTEM_PROMPT_KEY}" — ` +
        `re-run \`npm run prisma:seed\` against singularity_composer.`,
    );
  }
  cachedSystemPrompt = row.content;
  cachedAt = Date.now();
  return cachedSystemPrompt;
}

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
    const systemPrompt = await loadSystemPrompt();
    const result = await Promise.race([
      llmRespond({
        ...(MODEL_ALIAS ? { model_alias: MODEL_ALIAS } : {}),
        messages: [
          { role: "system", content: systemPrompt },
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
