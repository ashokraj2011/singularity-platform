/**
 * M15 — LLM-driven one-liner summariser for code symbols.
 *
 * When the regex / tree-sitter extractor finds a symbol with no docstring,
 * we ask mcp-server's embedded LLM gateway to produce a concise summary.
 * Used to populate `CapabilityCodeSymbol.summary` so retrieval has a useful
 * signal beyond just the symbol name.
 *
 * Failures fall back silently (return null) — the caller persists the symbol
 * with summary=null and life goes on.
 */
// agent-runtime doesn't have a shared logger; fall back to console.warn.
const log = { warn: (msg: string) => console.warn(`[summarise] ${msg}`) };

const MCP_INVOKE_URL = process.env.MCP_INVOKE_URL ?? "http://host.docker.internal:7100/mcp/invoke";
const MCP_BEARER     = process.env.MCP_BEARER_TOKEN ?? "demo-bearer-token-must-be-min-16-chars";
const TIMEOUT_MS     = 30_000;

export interface SummariseInput {
  symbolName: string;
  symbolType: string;
  language: string;
  filePath: string;
  /** ~5 lines of code surrounding the symbol declaration. */
  fileSnippet: string;
}

export async function summariseSymbol(input: SummariseInput): Promise<string | null> {
  const systemPrompt = [
    "You write concise one-line summaries of code symbols for retrieval indexes.",
    "Given a symbol declaration + surrounding code, produce ONE sentence (<=120 chars)",
    "describing what it does. No leading articles, no trailing period required.",
    "Return only the summary text — no quotes, no markdown, no explanation.",
  ].join("\n");
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
    const res = await fetch(MCP_INVOKE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${MCP_BEARER}`,
      },
      body: JSON.stringify({
        runContext: { traceId: `summarise-${input.symbolName}` },
        systemPrompt,
        message: userMessage,
        tools: [],
        modelConfig: {},
        limits: { maxSteps: 1, timeoutSec: 30 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(`summariseSymbol: mcp ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { data?: { finalResponse?: string } };
    const raw = data.data?.finalResponse?.trim() ?? "";
    if (!raw) return null;
    // Strip the mock-provider's "[mock] ..." preamble — we want the
    // actual summary or nothing. If the LLM returned the mock placeholder,
    // fall back so the regex docstring or `null` wins.
    if (raw.startsWith("[mock]")) return null;
    // Cap length so we don't blow up the prompt-composer downstream.
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
