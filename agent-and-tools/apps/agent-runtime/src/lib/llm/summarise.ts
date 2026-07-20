/**
 * M15 — LLM-driven one-liner summariser for code symbols.
 *
 * When the regex / tree-sitter extractor finds a symbol with no docstring,
 * we ask the central LLM gateway to produce a concise summary. Used to
 * populate `CapabilityCodeSymbol.summary` so retrieval has a useful signal
 * beyond just the symbol name.
 *
 * Routes through MCP. Failures fall back silently (return null) — the caller
 * persists the symbol with summary=null and life goes on.
 */
import { llmRespond } from "@agentandtools/shared";

const log = { warn: (msg: string) => console.warn(`[summarise] ${msg}`) };
const TIMEOUT_MS = 30_000;
const MODEL_ALIAS = process.env.SUMMARISE_MODEL_ALIAS?.trim();

export interface SummariseInput {
  symbolName: string;
  symbolType: string;
  language: string;
  filePath: string;
  /** ~5 lines of code surrounding the symbol declaration. */
  fileSnippet: string;
}

export async function summariseSymbol(input: SummariseInput): Promise<string | null> {
  // M36.4 — system prompt now in prompt-composer
  // (SystemPrompt key "agent-runtime.symbol-summarise").
  const { getSystemPrompt } = await import("@agentandtools/shared");
  const { content: systemPrompt } = await getSystemPrompt("agent-runtime.symbol-summarise");
  const userMessage = [
    `Symbol: ${input.symbolType} ${input.symbolName}`,
    `Language: ${input.language}`,
    `File: ${input.filePath}`,
    "",
    "Code:",
    "```",
    input.fileSnippet,
    "```",
  ].join("\n");

  try {
    const result = await Promise.race([
      llmRespond({
        // SUMMARISE_MODEL_ALIAS still wins when set (a pin is a pin). Unset, this
        // call now says what it is instead of arriving anonymous — one-line
        // symbol summaries are the cheapest work on the platform and should be
        // routed as such, which policy can decide and an env var cannot.
        task_tag: "summarise",
        purpose: "symbol_summary",
        ...(MODEL_ALIAS ? { model_alias: MODEL_ALIAS } : {}),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_output_tokens: 200,
        temperature: 0,
        trace_id: `summarise-${input.symbolName}`,
      }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("summarise timeout")), TIMEOUT_MS),
      ),
    ]);
    const raw = (result.content ?? "").trim();
    if (!raw) return null;
    // Strip the mock-provider's "[mock] ..." preamble — we want the
    // actual summary or nothing.
    if (raw.startsWith("[mock]")) return null;
    return raw.slice(0, 280);
  } catch (err) {
    log.warn(`summariseSymbol: ${(err as Error).message}`);
    return null;
  }
}

/** Pulls a small code window around `startLine` for the LLM. */
export function fileSnippetFor(content: string, startLine: number, ctxLines = 5): string {
  const lines = content.split("\n");
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, from + ctxLines + 1);
  return lines.slice(from, to).join("\n");
}
