import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type GatewayFetchResult = {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function gatewayHeaders(): HeadersInit {
  const bearer = process.env.LLM_GATEWAY_BEARER?.trim();
  return bearer ? { Authorization: bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}` } : {};
}

async function gatewayGet(path: string): Promise<GatewayFetchResult> {
  const gatewayUrl = trimTrailingSlash(process.env.LLM_GATEWAY_URL ?? "http://localhost:8001");
  try {
    const res = await fetch(`${gatewayUrl}${path}`, {
      headers: gatewayHeaders(),
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
    return { ok: false, error: err instanceof Error ? err.message : "Gateway request failed" };
  }
}

function configuredPath(envKey: string, fallback: string): string {
  return process.env[envKey] ?? process.env[`MCP_${envKey}`] ?? fallback;
}

export async function GET() {
  const gatewayUrl = trimTrailingSlash(process.env.LLM_GATEWAY_URL ?? "http://localhost:8001");
  const [health, providers, models] = await Promise.all([
    gatewayGet("/health"),
    gatewayGet("/llm/providers"),
    gatewayGet("/llm/models"),
  ]);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    gatewayUrl,
    authMode: process.env.LLM_GATEWAY_BEARER?.trim() ? "bearer" : "none",
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
  });
}
