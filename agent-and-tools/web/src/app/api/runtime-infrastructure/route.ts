import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedCallerBearer } from "../_proxy";
import { readJsonish } from "../_json";
import { serverEnv } from "@/lib/serverRootEnv";
import {
  cleanUrl,
  configuredPlatformServiceUrl,
  flagEnabled,
  localDevAllowsAnonymousRead,
  platformService,
  platformServiceToken,
  platformServiceUrl,
} from "@/lib/platformServices";
import { healthProbeMessage } from "../_health-message";

export const dynamic = "force-dynamic";

type RuntimeEntryConfig = {
  id: string;
  label: string;
  description: string;
  category: "core" | "runtime" | "governance";
  envKey: string;
  url: string | null;
  healthPath: string;
  required: boolean;
  remoteCapable: boolean;
  authToken?: string | null;
};

type RuntimeEntry = Omit<RuntimeEntryConfig, "authToken"> & {
  status: "healthy" | "unhealthy" | "unreachable" | "not_configured";
  ok: boolean | null;
  httpStatus: number | null;
  message: string;
  details?: Record<string, unknown>;
  checkedAt: string;
};

const HEALTH_TIMEOUT_MS = 2500;

function authHeader(token: string | null | undefined): HeadersInit {
  const trimmed = token?.trim();
  if (!trimmed) return {};
  return {
    Authorization: trimmed.startsWith("Bearer ") ? trimmed : `Bearer ${trimmed}`,
    "X-Service-Token": trimmed,
  };
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strictHealthDetails(value: unknown): Record<string, unknown> | undefined {
  const root = record(value);
  const data = record(root?.data) ?? root;
  const checks = Array.isArray(data?.checks) ? data.checks.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
  if (checks.length === 0) return undefined;

  const normalizedChecks = checks.slice(0, 20).map((check) => {
    const details = record(check.details);
    return {
      name: stringValue(check.name) ?? "unknown",
      ok: check.ok === true,
      reason: stringValue(check.reason),
      details: details ? Object.fromEntries(Object.entries(details).slice(0, 12)) : undefined,
    };
  });
  return {
    ok: data?.ok === true,
    failingChecks: normalizedChecks.filter((check) => !check.ok).map((check) => check.name),
    checks: normalizedChecks,
  };
}

async function probe(config: RuntimeEntryConfig): Promise<RuntimeEntry> {
  const checkedAt = new Date().toISOString();
  const { authToken, ...publicConfig } = config;

  if (!config.url) {
    return {
      ...publicConfig,
      status: "not_configured",
      ok: config.required ? false : null,
      httpStatus: null,
      message: config.required
        ? `${config.envKey} is not configured.`
        : "Optional runtime service. Configure a local or remote URL to enable it.",
      checkedAt,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint(config.url, config.healthPath), {
      cache: "no-store",
      headers: authHeader(authToken),
      signal: controller.signal,
    });
    const body = await readJsonish(res, 1200);
    return {
      ...publicConfig,
      status: res.ok ? "healthy" : "unhealthy",
      ok: res.ok,
      httpStatus: res.status,
      message: healthProbeMessage(body.raw, res.statusText, res.ok, 220),
      details: config.id === "agent-runtime-strict" ? strictHealthDetails(body.data) : undefined,
      checkedAt,
    };
  } catch (err) {
    return {
      ...publicConfig,
      status: "unreachable",
      ok: false,
      httpStatus: null,
      message: err instanceof Error ? err.message : "Health check failed",
      checkedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: NextRequest) {
  if (!localDevAllowsAnonymousRead()) {
    const authFailure = await requireVerifiedCallerBearer(request, "Runtime infrastructure");
    if (authFailure) return authFailure;
  }

  const mcpHttpDebugEnabled =
    flagEnabled(serverEnv("RUNTIME_HTTP_FALLBACK_ENABLED")) ||
    flagEnabled(serverEnv("MCP_HTTP_DEBUG_PROBE_ENABLED"));
  const contextFabricUrl = platformServiceUrl("context-fabric");
  const entries: RuntimeEntryConfig[] = [
    {
      id: "agent-runtime-strict",
      label: "Agent Runtime Strict Health",
      description: "Agent Runtime schema and runtime invariants required before capability sync, profile resolution, and governed runs.",
      category: "core",
      envKey: platformService("agent-runtime").envKey,
      url: cleanUrl(platformServiceUrl("agent-runtime")),
      healthPath: "/healthz/strict",
      required: true,
      remoteCapable: true,
      authToken: null,
    },
    {
      id: "context-api",
      label: "Context Fabric",
      description: "Context, memory, knowledge sources, receipts, runtime bridge, and fabric APIs.",
      category: "core",
      envKey: platformService("context-fabric").envKey,
      url: cleanUrl(contextFabricUrl),
      healthPath: "/health",
      required: true,
      remoteCapable: true,
      authToken: platformServiceToken("context-fabric"),
    },
    {
      id: "runtime-bridge",
      label: "Runtime Bridge",
      description: "WebSocket dial-in registry for MCP runtimes that relay tool-run, model-run, and code-context frames.",
      category: "runtime",
      envKey: platformService("context-fabric").envKey,
      url: cleanUrl(contextFabricUrl),
      healthPath: "/api/runtime-bridge/status",
      required: true,
      remoteCapable: true,
      authToken: platformServiceToken("context-fabric"),
    },
    {
      id: "mcp",
      label: "MCP HTTP Debug",
      description: mcpHttpDebugEnabled
        ? "Direct MCP HTTP endpoint. Used only when RUNTIME_HTTP_FALLBACK_ENABLED=true or for diagnostics."
        : "Direct MCP HTTP probe disabled. Normal traffic uses the Runtime Bridge WebSocket.",
      category: "runtime",
      envKey: platformService("mcp-server").envKey,
      url: mcpHttpDebugEnabled ? configuredPlatformServiceUrl("mcp-server") : null,
      healthPath: "/health",
      required: false,
      remoteCapable: true,
      authToken: null,
    },
    {
      id: "llm-gateway",
      label: "LLM Gateway Debug",
      description: "Local or colocated model gateway behind the MCP runtime. Direct probe is diagnostic only.",
      category: "runtime",
      envKey: platformService("llm-gateway").envKey,
      url: configuredPlatformServiceUrl("llm-gateway", "LLM_GATEWAY_INTERNAL_URL"),
      healthPath: "/health",
      required: false,
      remoteCapable: true,
      authToken: platformServiceToken("llm-gateway"),
    },
    {
      id: "formal-verifier",
      label: "Formal Verifier",
      description: "Optional verification gate for proof-backed code and workflow changes.",
      category: "runtime",
      envKey: platformService("formal-verifier").envKey,
      url: configuredPlatformServiceUrl("formal-verifier", "FORMAL_VERIFIER_INTERNAL_URL"),
      healthPath: "/health",
      required: false,
      remoteCapable: true,
      authToken: null,
    },
    {
      id: "audit-governance",
      label: "Audit Governance",
      description: "Governance ledger and audit evidence collection.",
      category: "governance",
      envKey: platformService("audit-governance").envKey,
      url: configuredPlatformServiceUrl("audit-governance"),
      healthPath: "/health",
      required: false,
      remoteCapable: true,
      authToken: platformServiceToken("audit-governance"),
    },
  ];

  const services = await Promise.all(entries.map(probe));
  const required = services.filter((service) => service.required);
  const optional = services.filter((service) => !service.required);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    summary: {
      requiredHealthy: required.every((service) => service.ok === true),
      requiredCount: required.length,
      optionalConfigured: optional.filter((service) => service.url).length,
      optionalHealthy: optional.filter((service) => service.ok === true).length,
    },
    services,
  });
}
