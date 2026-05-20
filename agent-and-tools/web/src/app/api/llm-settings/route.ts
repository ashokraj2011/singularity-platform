import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type McpFetchResult = {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function mcpHeaders(): HeadersInit {
  const bearer = process.env.MCP_BEARER_TOKEN?.trim();
  return bearer ? { Authorization: bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}` } : {};
}

async function mcpGet(path: string): Promise<McpFetchResult> {
  const mcpUrl = trimTrailingSlash(process.env.MCP_SERVER_URL ?? "http://localhost:7100");
  try {
    const res = await fetch(`${mcpUrl}${path}`, {
      headers: path === "/health" ? {} : mcpHeaders(),
      cache: "no-store",
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500),
        data,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "MCP request failed" };
  }
}

function configuredPath(envKey: string, fallback: string): string {
  return process.env[envKey] ?? process.env[`MCP_${envKey}`] ?? fallback;
}

export async function GET() {
  const mcpUrl = trimTrailingSlash(process.env.MCP_SERVER_URL ?? "http://localhost:7100");
  const [health, providers, models, workspaceStats] = await Promise.all([
    mcpGet("/health"),
    mcpGet("/llm/providers"),
    mcpGet("/llm/models"),
    mcpGet("/mcp/workspaces/stats"),
  ]);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    gatewayUrl: mcpUrl,
    mcpUrl,
    authMode: process.env.MCP_BEARER_TOKEN?.trim() ? "bearer" : "none",
    configuredPaths: {
      providerConfigPath: configuredPath("LLM_PROVIDER_CONFIG_PATH", "/etc/singularity/llm-providers.json"),
      modelCatalogPath: configuredPath("LLM_MODEL_CATALOG_PATH", "/etc/singularity/mcp-models.json"),
    },
    consumers: {
      agentRuntimeUrl: process.env.AGENT_RUNTIME_URL ?? null,
      promptComposerUrl: process.env.PROMPT_COMPOSER_URL ?? null,
      contextFabricUrl: process.env.CONTEXT_FABRIC_URL ?? null,
      eventHorizonProvider: process.env.EVENT_HORIZON_PROVIDER || process.env.NEXT_PUBLIC_EVENT_HORIZON_PROVIDER || null,
      eventHorizonModel: process.env.EVENT_HORIZON_MODEL || process.env.NEXT_PUBLIC_EVENT_HORIZON_MODEL || null,
    },
    health,
    providers,
    models,
    workspaceStats,
  });
}
