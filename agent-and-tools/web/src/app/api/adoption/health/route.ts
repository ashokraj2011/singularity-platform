import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type CheckStatus = "ready" | "warning" | "blocked";

type AdoptionCheck = {
  id: string;
  label: string;
  group: "core" | "sdlc" | "runtime" | "governance";
  status: CheckStatus;
  summary: string;
  detail?: string;
  fixCommand?: string;
  fixRoute?: string;
};

const FETCH_TIMEOUT_MS = 3500;

function authHeaders(req: NextRequest): HeadersInit {
  const auth = req.headers.get("authorization");
  return auth ? { authorization: auth } : {};
}

async function getJson(origin: string, path: string, req: NextRequest): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}${path}`, {
      cache: "no-store",
      headers: authHeaders(req),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data, text: text.slice(0, 700) };
  } catch (err) {
    return { ok: false, status: 0, data: null, text: err instanceof Error ? err.message : "Request failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value).slice(0, 500);
}

function check(
  id: string,
  label: string,
  group: AdoptionCheck["group"],
  status: CheckStatus,
  summary: string,
  opts: Pick<AdoptionCheck, "detail" | "fixCommand" | "fixRoute"> = {},
): AdoptionCheck {
  return { id, label, group, status, summary, ...opts };
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const [runtime, gallery, llm, workgraphHealth, auditHealth, agentTemplates] = await Promise.all([
    getJson(origin, "/api/runtime-infrastructure", req),
    getJson(origin, "/api/workflow-templates/gallery", req),
    getJson(origin, "/api/llm-settings", req),
    getJson(origin, "/api/workgraph/health", req),
    getJson(origin, "/api/audit-gov/health", req),
    getJson(origin, "/api/runtime/agents/templates?scope=common&limit=3", req),
  ]);

  const runtimeBody = record(runtime.data);
  const runtimeServices = arrayValue(runtimeBody.services).map(record);
  const runtimeSummary = record(runtimeBody.summary);
  const runtimeBridge = runtimeServices.find((service) => service.id === "runtime-bridge");
  const contextFabric = runtimeServices.find((service) => service.id === "context-api");

  const galleryItems = arrayValue(record(gallery.data).items).map(record);
  const seededTemplateCount = galleryItems.filter((item) => Number(item.templateCount ?? 0) > 0).length;

  const llmBody = record(llm.data);
  const providerBody = record(record(llmBody.providers).data);
  const providers = arrayValue(providerBody.providers).map(record);
  const readyProviders = providers.filter((provider) => provider.ready === true);
  const runtimeBridgeEnvelope = record(record(llmBody.runtimeBridgeStatus).data);
  const connectedRuntimes = arrayValue(runtimeBridgeEnvelope.connected);

  const agentRows = arrayValue(record(agentTemplates.data).items);

  const checks: AdoptionCheck[] = [
    check(
      "workgraph-api",
      "Workgraph API",
      "core",
      workgraphHealth.ok ? "ready" : "blocked",
      workgraphHealth.ok ? "Workflow API is reachable." : "Workflow API is not reachable from Platform Web.",
      {
        detail: workgraphHealth.ok ? undefined : workgraphHealth.text,
        fixCommand: "bin/bare-metal-apps.sh up",
        fixRoute: "/operations/readiness",
      },
    ),
    check(
      "context-fabric",
      "Context Fabric",
      "core",
      contextFabric?.ok === true ? "ready" : "blocked",
      contextFabric?.ok === true ? "Context Fabric health is green." : "Context Fabric is required for runtime bridge routing.",
      {
        detail: textFrom(contextFabric?.message ?? runtime.text),
        fixCommand: "bin/bare-metal-apps.sh up",
        fixRoute: "/operations/readiness",
      },
    ),
    check(
      "runtime-bridge",
      "Runtime Bridge",
      "runtime",
      connectedRuntimes.length > 0 ? "ready" : runtimeBridge?.ok === true ? "warning" : "blocked",
      connectedRuntimes.length > 0
        ? `${connectedRuntimes.length} MCP runtime client(s) connected.`
        : runtimeBridge?.ok === true
          ? "Runtime Bridge endpoint is live, but no MCP runtime has dialed in."
          : "Runtime Bridge is not reachable.",
      {
        detail: textFrom(runtimeBridge?.message),
        fixCommand: "bin/mcp-runtime-setup.sh",
        fixRoute: "/llm-settings",
      },
    ),
    check(
      "llm-provider",
      "LLM Provider",
      "runtime",
      readyProviders.length > 0 ? "ready" : llm.ok ? "warning" : "blocked",
      readyProviders.length > 0
        ? `${readyProviders.length} provider(s) ready: ${readyProviders.map((provider) => String(provider.name)).join(", ")}.`
        : llm.ok
          ? "LLM switchboard is reachable, but no non-disabled provider is ready."
          : "LLM switchboard failed to load.",
      {
        detail: llm.ok ? textFrom(providerBody.warnings) : llm.text,
        fixRoute: "/llm-settings",
      },
    ),
    check(
      "seeded-workflows",
      "Seeded SDLC Workflows",
      "sdlc",
      seededTemplateCount >= 3 ? "ready" : seededTemplateCount > 0 ? "warning" : "blocked",
      seededTemplateCount > 0
        ? `${seededTemplateCount}/${galleryItems.length} SDLC intents have a matching template.`
        : "No curated SDLC workflow templates were found.",
      {
        fixCommand: "bin/doctor.sh --fix",
        fixRoute: "/workflows/templates/gallery",
      },
    ),
    check(
      "agent-studio-seeds",
      "Agent Studio Seeds",
      "sdlc",
      agentRows.length > 0 ? "ready" : agentTemplates.ok ? "warning" : "blocked",
      agentRows.length > 0
        ? `${agentRows.length} common agent template(s) visible.`
        : "No common agent templates were visible to Platform Web.",
      {
        detail: agentTemplates.ok ? undefined : agentTemplates.text,
        fixCommand: "bin/doctor.sh --fix",
        fixRoute: "/agents/studio",
      },
    ),
    check(
      "audit-evidence",
      "Audit Evidence",
      "governance",
      auditHealth.ok ? "ready" : "warning",
      auditHealth.ok ? "Audit governance endpoint is reachable." : "Audit governance is unavailable or optional in this deployment.",
      {
        detail: auditHealth.ok ? undefined : auditHealth.text,
        fixRoute: "/operations/trust",
      },
    ),
    check(
      "git-push",
      "Git Push / Copilot Handoff",
      "governance",
      "warning",
      "Git push readiness depends on the connected MCP runtime token and repository permissions.",
      {
        fixCommand: "bin/mcp-runtime-setup.sh",
        fixRoute: "/llm-settings",
      },
    ),
  ];

  const ready = checks.filter((item) => item.status === "ready");
  const warning = checks.filter((item) => item.status === "warning");
  const blocked = checks.filter((item) => item.status === "blocked");
  const score = checks.length ? Math.round(((ready.length + warning.length * 0.45) / checks.length) * 100) : 0;

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    score,
    summary: {
      ready: ready.length,
      warning: warning.length,
      blocked: blocked.length,
      requiredRuntimeHealthy: runtimeSummary.requiredHealthy === true,
      connectedRuntimeCount: connectedRuntimes.length,
      readyProviderCount: readyProviders.length,
      seededIntentCount: seededTemplateCount,
    },
    ready,
    warning,
    blocked,
    checks,
  });
}

