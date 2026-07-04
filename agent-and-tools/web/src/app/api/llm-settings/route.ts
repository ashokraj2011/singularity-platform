import { NextRequest, NextResponse } from "next/server";
import { readJsonish } from "../_json";
import { requireVerifiedCallerBearer } from "../_proxy";
import { serverEnv } from "@/lib/serverRootEnv";
import {
  configuredPlatformServiceUrl,
  contextFabricStatusHeaders,
  flagEnabled,
  platformEnvName,
  platformServiceToken,
  platformServiceUrl,
  serviceBearerHeaders,
  trimTrailingSlash,
} from "@/lib/platformServices";

export const dynamic = "force-dynamic";

type McpFetchResult = {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  skipped?: boolean;
};

function mcpHeaders(): HeadersInit {
  return serviceBearerHeaders("mcp-server");
}

function llmGatewayHeaders(): HeadersInit {
  return serviceBearerHeaders("llm-gateway");
}

function contextFabricHeaders(): HeadersInit {
  return contextFabricStatusHeaders();
}

function localDevAllowsAnonymousRead(): boolean {
  if (serverEnv("LLM_SETTINGS_REQUIRE_AUTH") === "true") return false;
  if (serverEnv("LLM_SETTINGS_REQUIRE_AUTH") === "false") return true;
  const env = platformEnvName();
  return !["production", "staging", "perf"].includes(env);
}

function runtimeHttpFallbackEnabled(): boolean {
  return flagEnabled(serverEnv("RUNTIME_HTTP_FALLBACK_ENABLED") ?? serverEnv("MCP_HTTP_DEBUG_PROBE_ENABLED"));
}

function skippedResult(reason: string): McpFetchResult {
  return { ok: true, skipped: true, data: { status: "skipped", reason } };
}

async function getJson(baseUrl: string, path: string, headers: HeadersInit = {}): Promise<McpFetchResult> {
  const trimmedBase = trimTrailingSlash(baseUrl);
  try {
    const res = await fetch(`${trimmedBase}${path}`, {
      headers,
      cache: "no-store",
    });
    const body = await readJsonish(res);
    const data = body.data;
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
  const mcpUrl = platformServiceUrl("mcp-server");
  return getJson(mcpUrl, path, path === "/health" ? {} : mcpHeaders());
}

async function llmGatewayGet(path: string): Promise<McpFetchResult> {
  const gatewayUrl = configuredPlatformServiceUrl("llm-gateway", "LLM_GATEWAY_INTERNAL_URL") ?? "";
  if (!gatewayUrl) {
    return skippedResult("Direct LLM Gateway debug probe is not configured. Provider readiness should come from connected MCP runtime health.");
  }
  return getJson(gatewayUrl, path, path === "/health" ? {} : llmGatewayHeaders());
}

async function contextFabricGet(path: string): Promise<McpFetchResult> {
  const contextFabricUrl = platformServiceUrl("context-fabric");
  return getJson(contextFabricUrl, path, path === "/health" ? {} : contextFabricHeaders());
}

function configuredPath(envKey: string, fallback: string): string {
  return serverEnv(envKey) ?? serverEnv(`MCP_${envKey}`) ?? fallback;
}

export async function GET(request: NextRequest) {
  if (!localDevAllowsAnonymousRead()) {
    const authFailure = await requireVerifiedCallerBearer(request, "LLM settings");
    if (authFailure) return authFailure;
  }

  const mcpUrl = platformServiceUrl("mcp-server");
  const llmGatewayUrl = configuredPlatformServiceUrl("llm-gateway", "LLM_GATEWAY_INTERNAL_URL") ?? "";
  const contextFabricUrl = platformServiceUrl("context-fabric");
  const rawEventHorizonProvider = serverEnv("EVENT_HORIZON_PROVIDER") || serverEnv("NEXT_PUBLIC_EVENT_HORIZON_PROVIDER") || null;
  const rawEventHorizonModel = serverEnv("EVENT_HORIZON_MODEL") || serverEnv("NEXT_PUBLIC_EVENT_HORIZON_MODEL") || null;
  const httpFallbackEnabled = runtimeHttpFallbackEnabled();
  const mcpHttpSkipped = skippedResult("Direct MCP HTTP probing is disabled. Normal traffic uses Context Fabric Runtime Bridge.");
  const [gatewayHealth, providers, models, mcpHealth, workspaceStats, contextFabricHealth, runtimeBridgeStatus] = await Promise.all([
    llmGatewayGet("/health"),
    llmGatewayGet("/llm/providers"),
    llmGatewayGet("/llm/models"),
    httpFallbackEnabled ? mcpGet("/health") : Promise.resolve(mcpHttpSkipped),
    httpFallbackEnabled ? mcpGet("/mcp/workspaces/stats") : Promise.resolve(mcpHttpSkipped),
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
      httpFallback: httpFallbackEnabled ? "enabled" : "disabled",
    },
    gatewayUrl: llmGatewayUrl || "not configured",
    llmGatewayUrl: llmGatewayUrl || "not configured",
    mcpUrl,
    contextFabricUrl,
    authMode: platformServiceToken("llm-gateway") ? "bearer" : "none",
    mcpAuthMode: platformServiceToken("mcp-server") ? "bearer" : "none",
    configuredPaths: {
      providerConfigPath: configuredPath("LLM_PROVIDER_CONFIG_PATH", "/etc/singularity/llm-providers.json"),
      modelCatalogPath: configuredPath("LLM_MODEL_CATALOG_PATH", "/etc/singularity/llm-models.json"),
    },
    consumers: {
      agentRuntimeUrl: serverEnv("AGENT_RUNTIME_URL") ?? null,
      promptComposerUrl: serverEnv("PROMPT_COMPOSER_URL") ?? null,
      contextFabricUrl: serverEnv("CONTEXT_FABRIC_URL") ?? null,
      eventHorizonModelAlias: serverEnv("EVENT_HORIZON_MODEL_ALIAS") || serverEnv("NEXT_PUBLIC_EVENT_HORIZON_MODEL_ALIAS") || null,
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
