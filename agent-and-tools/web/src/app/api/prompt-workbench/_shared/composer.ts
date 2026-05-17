import { NextRequest, NextResponse } from "next/server";

type ComposerEnvelope<T = unknown> = {
  success?: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: unknown } | null;
  requestId?: string | null;
};

export type PromptWorkbenchComposeBody = Record<string, unknown> & {
  modelOverrides?: Record<string, unknown>;
  contextPolicy?: Record<string, unknown>;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function composerUrl(): string {
  return trimTrailingSlash(process.env.PROMPT_COMPOSER_URL ?? "http://localhost:3004");
}

function forwardHeaders(request: NextRequest): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = request.headers.get("authorization");
  if (auth) headers.Authorization = auth;
  const requestId = request.headers.get("x-request-id");
  if (requestId) headers["x-request-id"] = requestId;
  return headers;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const envelope = data as ComposerEnvelope;
    return envelope.error?.message ?? String((data as Record<string, unknown>).message ?? fallback);
  }
  return typeof data === "string" ? data.slice(0, 500) : fallback;
}

export async function callComposer<T = unknown>(
  request: NextRequest,
  body: PromptWorkbenchComposeBody,
  previewOnly: boolean,
): Promise<{ ok: true; data: T; requestId?: string | null } | { ok: false; status: number; error: string; details?: unknown; requestId?: string | null }> {
  try {
    const res = await fetch(`${composerUrl()}/api/v1/compose-and-respond`, {
      method: "POST",
      headers: forwardHeaders(request),
      body: JSON.stringify({ ...body, previewOnly }),
      cache: "no-store",
    });
    const payload = await readJson(res);
    const envelope = payload && typeof payload === "object" ? payload as ComposerEnvelope<T> : null;

    if (!res.ok || envelope?.success === false) {
      return {
        ok: false,
        status: res.status || 502,
        error: errorMessage(payload, `Prompt Composer returned ${res.status}`),
        details: envelope?.error?.details ?? payload,
        requestId: envelope?.requestId ?? null,
      };
    }

    return {
      ok: true,
      data: envelope?.success === true ? envelope.data as T : payload as T,
      requestId: envelope?.requestId ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "Prompt Composer request failed",
    };
  }
}

export function composerError(result: Extract<Awaited<ReturnType<typeof callComposer>>, { ok: false }>) {
  return NextResponse.json({
    error: result.error,
    details: result.details,
    requestId: result.requestId ?? null,
  }, { status: result.status });
}

export function selectedAliases(value: unknown, fallback?: unknown): string[] {
  const aliases = Array.isArray(value) ? value.map(String).map(s => s.trim()).filter(Boolean) : [];
  if (aliases.length > 0) return Array.from(new Set(aliases));
  const fallbackAlias = typeof fallback === "string" ? fallback.trim() : "";
  return fallbackAlias ? [fallbackAlias] : [""];
}

export function estimateTokensFromPreview(data: unknown, compose: PromptWorkbenchComposeBody, alias: string) {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const modelOverrides = compose.modelOverrides ?? {};
  const contextPolicy = compose.contextPolicy ?? {};
  const inputTokens = Number(record.estimatedInputTokens ?? 0);
  const requestedOutputTokens = Number(modelOverrides.maxOutputTokens ?? 1200);
  const maxContextTokens = Number(contextPolicy.maxContextTokens ?? 0);
  const totalTokens = inputTokens + requestedOutputTokens;
  const budgetStatus = maxContextTokens > 0 && inputTokens > maxContextTokens
    ? "over_input_budget"
    : maxContextTokens > 0 && totalTokens > maxContextTokens
      ? "output_may_exceed_context"
      : "fits";

  return {
    modelAlias: alias || null,
    promptAssemblyId: record.promptAssemblyId ?? null,
    traceId: record.traceId ?? null,
    promptHash: record.promptHash ?? null,
    estimatedInputTokens: inputTokens,
    requestedOutputTokens,
    estimatedTotalTokens: totalTokens,
    maxContextTokens: maxContextTokens || null,
    budgetStatus,
    warnings: Array.isArray(record.warnings) ? record.warnings : [],
    budgetWarnings: Array.isArray(record.budgetWarnings) ? record.budgetWarnings : [],
    contextPlanHash: (record.contextPlan as Record<string, unknown> | undefined)?.contextPlanHash ?? null,
    contextPlanValid: (record.contextPlan as Record<string, unknown> | undefined)?.valid ?? null,
  };
}
