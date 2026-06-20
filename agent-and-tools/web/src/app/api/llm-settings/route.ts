import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedCallerBearer } from "../_proxy";

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

function bearerHeaders(token: string | null | undefined): HeadersInit {
  const bearer = token?.trim();
  return bearer ? { Authorization: bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}` } : {};
}

function mcpHeaders(): HeadersInit {
  return bearerHeaders(process.env.MCP_BEARER_TOKEN);
}

function llmGatewayHeaders(): HeadersInit {
  return bearerHeaders(process.env.LLM_GATEWAY_BEARER);
}

function localDevAllowsAnonymousRead(): boolean {
  if (process.env.LLM_SETTINGS_REQUIRE_AUTH === "true") return false;
  if (process.env.LLM_SETTINGS_REQUIRE_AUTH === "false") return true;
  const env = (process.env.SINGULARITY_ENV ?? process.env.APP_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
  return !["production", "staging", "perf"].includes(env);
}

async function getJson(baseUrl: string, path: string, headers: HeadersInit = {}): Promise<McpFetchResult> {
  const trimmedBase = trimTrailingSlash(baseUrl);
  try {
    const res = await fetch(`${trimmedBase}${path}`, {
      headers,
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
    return { ok: false, error: err instanceof Error ? err.message : "runtime request failed" };
  }
}

async function mcpGet(path: string): Promise<McpFetchResult> {
  const mcpUrl = trimTrailingSlash(process.env.MCP_SERVER_URL ?? "http://mcp-server:7100");
  return getJson(mcpUrl, path, path === "/health" ? {} : mcpHeaders());
}

async function llmGatewayGet(path: string): Promise<McpFetchResult> {
  const gatewayUrl = trimTrailingSlash(process.env.LLM_GATEWAY_URL ?? process.env.LLM_GATEWAY_INTERNAL_URL ?? "http://llm-gateway:8001");
  return getJson(gatewayUrl, path, path === "/health" ? {} : llmGatewayHeaders());
}

async function contextFabricGet(path: string): Promise<McpFetchResult> {
  const contextFabricUrl = trimTrailingSlash(process.env.CONTEXT_FABRIC_URL ?? "http://context-api:8000");
  return getJson(contextFabricUrl, path);
}

function configuredPath(envKey: string, fallback: string): string {
  return process.env[envKey] ?? process.env[`MCP_${envKey}`] ?? fallback;
}

export async function GET(request: NextRequest) {
  if (!localDevAllowsAnonymousRead()) {
    const authFailure = await requireVerifiedCallerBearer(request, "LLM settings");
    if (authFailure) return authFailure;
  }

  const mcpUrl = trimTrailingSlash(process.env.MCP_SERVER_URL ?? "http://mcp-server:7100");
  const llmGatewayUrl = trimTrailingSlash(process.env.LLM_GATEWAY_URL ?? process.env.LLM_GATEWAY_INTERNAL_URL ?? "http://llm-gateway:8001");
  const contextFabricUrl = trimTrailingSlash(process.env.CONTEXT_FABRIC_URL ?? "http://context-api:8000");
  const rawEventHorizonProvider = process.env.EVENT_HORIZON_PROVIDER || process.env.NEXT_PUBLIC_EVENT_HORIZON_PROVIDER || null;
  const rawEventHorizonModel = process.env.EVENT_HORIZON_MODEL || process.env.NEXT_PUBLIC_EVENT_HORIZON_MODEL || null;
  const [gatewayHealth, providers, models, mcpHealth, workspaceStats, contextFabricHealth, runtimeBridgeStatus] = await Promise.all([
    llmGatewayGet("/health"),
    llmGatewayGet("/llm/providers"),
    llmGatewayGet("/llm/models"),
    mcpGet("/health"),
    mcpGet("/mcp/workspaces/stats"),
    contextFabricGet("/health"),
    contextFabricGet("/api/runtime-bridge/status"),
  ]);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    topology: {
      mode: "dial-in-runtime",
      hub: "context-fabric",
      llmGateway: "served-through-mcp-runtime",
      mcpRuntime: "runtime-bridge-websocket",
      httpFallback: process.env.RUNTIME_HTTP_FALLBACK_ENABLED === "true" ? "enabled" : "disabled",
    },
    gatewayUrl: llmGatewayUrl,
    llmGatewayUrl,
    mcpUrl,
    contextFabricUrl,
    authMode: process.env.LLM_GATEWAY_BEARER?.trim() ? "bearer" : "none",
    mcpAuthMode: process.env.MCP_BEARER_TOKEN?.trim() ? "bearer" : "none",
    configuredPaths: {
      providerConfigPath: configuredPath("LLM_PROVIDER_CONFIG_PATH", "/etc/singularity/llm-providers.json"),
      modelCatalogPath: configuredPath("LLM_MODEL_CATALOG_PATH", "/etc/singularity/llm-models.json"),
    },
    consumers: {
      agentRuntimeUrl: process.env.AGENT_RUNTIME_URL ?? null,
      promptComposerUrl: process.env.PROMPT_COMPOSER_URL ?? null,
      contextFabricUrl: process.env.CONTEXT_FABRIC_URL ?? null,
      eventHorizonModelAlias: process.env.EVENT_HORIZON_MODEL_ALIAS || process.env.NEXT_PUBLIC_EVENT_HORIZON_MODEL_ALIAS || null,
      ...(rawEventHorizonProvider || rawEventHorizonModel ? {
        legacyEventHorizonProvider: rawEventHorizonProvider,
        legacyEventHorizonModel: rawEventHorizonModel,
      } : {}),
    },
    health: gatewayHealth,
    gatewayHealth,
    mcpHealth,
    contextFabricHealth,
    runtimeBridgeStatus,
    providers,
    models,
    workspaceStats,
  });
}
