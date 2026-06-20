import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedCallerBearer } from "../_proxy";

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
  checkedAt: string;
};

const HEALTH_TIMEOUT_MS = 2500;

function cleanUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function authHeader(token: string | null | undefined): HeadersInit {
  const trimmed = token?.trim();
  if (!trimmed) return {};
  return { Authorization: trimmed.startsWith("Bearer ") ? trimmed : `Bearer ${trimmed}` };
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
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
    const text = await res.text();
    return {
      ...publicConfig,
      status: res.ok ? "healthy" : "unhealthy",
      ok: res.ok,
      httpStatus: res.status,
      message: text.slice(0, 220) || res.statusText || (res.ok ? "Healthy" : "Unhealthy"),
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
  const authFailure = await requireVerifiedCallerBearer(request, "Runtime infrastructure");
  if (authFailure) return authFailure;

  const entries: RuntimeEntryConfig[] = [
    {
      id: "context-api",
      label: "Context Fabric",
      description: "Context, memory, knowledge sources, receipts, and fabric APIs.",
      category: "core",
      envKey: "CONTEXT_FABRIC_URL",
      url: cleanUrl(process.env.CONTEXT_FABRIC_URL ?? "http://context-api:8000"),
      healthPath: "/health",
      required: true,
      remoteCapable: true,
      authToken: process.env.CONTEXT_FABRIC_SERVICE_TOKEN ?? null,
    },
    {
      id: "mcp",
      label: "MCP Runtime",
      description: "Tool execution, workspace operations, file/code context, and runtime adapters.",
      category: "runtime",
      envKey: "MCP_SERVER_URL",
      url: cleanUrl(process.env.MCP_SERVER_URL),
      healthPath: "/health",
      required: false,
      remoteCapable: true,
      authToken: null,
    },
    {
      id: "llm-gateway",
      label: "LLM Gateway",
      description: "Central model-provider gateway. Can run locally or as a separate remote service.",
      category: "runtime",
      envKey: "LLM_GATEWAY_URL",
      url: cleanUrl(process.env.LLM_GATEWAY_URL ?? process.env.LLM_GATEWAY_INTERNAL_URL),
      healthPath: "/health",
      required: false,
      remoteCapable: true,
      authToken: process.env.LLM_GATEWAY_BEARER ?? null,
    },
    {
      id: "formal-verifier",
      label: "Formal Verifier",
      description: "Optional verification gate for proof-backed code and workflow changes.",
      category: "runtime",
      envKey: "FORMAL_VERIFIER_URL",
      url: cleanUrl(process.env.FORMAL_VERIFIER_URL ?? process.env.FORMAL_VERIFIER_INTERNAL_URL),
      healthPath: "/health",
      required: false,
      remoteCapable: true,
      authToken: null,
    },
    {
      id: "code-foundry-api",
      label: "Code Foundry API",
      description: "Repository analysis, change plans, generation history, and verification runs.",
      category: "runtime",
      envKey: "CODE_FOUNDRY_API_URL",
      url: cleanUrl(process.env.CODE_FOUNDRY_API_URL),
      healthPath: "/health",
      required: false,
      remoteCapable: false,
      authToken: process.env.FOUNDRY_TOKEN ?? process.env.CODEGEN_SERVICE_TOKEN ?? null,
    },
    {
      id: "audit-governance",
      label: "Audit Governance",
      description: "Governance ledger and audit evidence collection.",
      category: "governance",
      envKey: "AUDIT_GOV_URL",
      url: cleanUrl(process.env.AUDIT_GOV_URL),
      healthPath: "/health",
      required: false,
      remoteCapable: true,
      authToken: process.env.AUDIT_GOV_SERVICE_TOKEN ?? null,
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
