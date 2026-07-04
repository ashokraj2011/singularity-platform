import { NextRequest, NextResponse } from "next/server";
import { readJsonish } from "../../_json";
import { boundedSecondsEnv } from "@/lib/serverEnvBounds";

export const dynamic = "force-dynamic";

type CheckStatus = "ready" | "warning" | "blocked";

type AdoptionCheck = {
  id: string;
  label: string;
  group: "core" | "sdlc" | "runtime" | "governance";
  status: CheckStatus;
  summary: string;
  message: string;
  detail?: string;
  details?: string;
  fixCommand?: string;
  fixRoute?: string;
};

const FETCH_TIMEOUT_MS = boundedSecondsEnv("ADOPTION_HEALTH_FETCH_TIMEOUT_SEC", 4, 1, 300) * 1000;

function authHeaders(req: NextRequest): HeadersInit {
  const auth = req.headers.get("authorization");
  return auth ? { authorization: auth } : {};
}

async function getJson(origin: string, path: string, req: NextRequest): Promise<{ ok: boolean; status: number; data: unknown; text: string }> {
  try {
    const res = await fetch(`${origin}${path}`, {
      cache: "no-store",
      headers: authHeaders(req),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await readJsonish(res);
    return { ok: res.ok, status: res.status, data: body.data, text: body.text };
  } catch (err) {
    return { ok: false, status: 0, data: null, text: err instanceof Error ? err.message : "Request failed" };
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).map(String).filter((item) => item.trim().length > 0);
}

function modelRows(value: unknown): Record<string, unknown>[] {
  return arrayValue(value)
    .map(record)
    .filter((model) => Boolean(stringValue(model.id) || stringValue(model.model)));
}

function modelReady(model: Record<string, unknown>): boolean {
  return model.ready !== false;
}

function strictHealthChecks(service: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const details = record(service?.details);
  return arrayValue(details.checks).map(record);
}

function strictHealthFailureDetail(service: Record<string, unknown> | undefined, fallback: string): string {
  const failures = strictHealthChecks(service)
    .filter((row) => row.ok !== true)
    .map((row) => {
      const name = stringValue(row.name) ?? "unknown";
      const reason = stringValue(row.reason);
      return reason ? `${name}: ${reason}` : name;
    });
  return failures.length > 0 ? failures.join(" | ") : fallback;
}

function hasStrictHealthFailure(service: Record<string, unknown> | undefined, checkName: string): boolean {
  return strictHealthChecks(service).some((row) => row.ok !== true && stringValue(row.name) === checkName);
}

function check(
  id: string,
  label: string,
  group: AdoptionCheck["group"],
  status: CheckStatus,
  summary: string,
  opts: Pick<AdoptionCheck, "detail" | "fixCommand" | "fixRoute"> = {},
): AdoptionCheck {
  return { id, label, group, status, summary, message: summary, details: opts.detail, ...opts };
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const [runtime, gallery, llm, workgraphHealth, auditHealth, agentTemplates, iamHealth, promptComposerHealth] = await Promise.all([
    getJson(origin, "/api/runtime-infrastructure", req),
    getJson(origin, "/api/workflow-templates/gallery", req),
    getJson(origin, "/api/llm-settings", req),
    getJson(origin, "/api/workgraph/health", req),
    getJson(origin, "/api/audit-gov/health", req),
    getJson(origin, "/api/runtime/agents/templates?scope=common&limit=3", req),
    getJson(origin, "/ops-health/iam", req),
    getJson(origin, "/ops-health/prompt-composer", req),
  ]);

  const runtimeBody = record(runtime.data);
  const runtimeServices = arrayValue(runtimeBody.services).map(record);
  const runtimeSummary = record(runtimeBody.summary);
  const runtimeBridge = runtimeServices.find((service) => service.id === "runtime-bridge");
  const contextFabric = runtimeServices.find((service) => service.id === "context-api");
  const agentRuntimeStrict = runtimeServices.find((service) => service.id === "agent-runtime-strict");
  const archivedCapabilityLifecycleDrift = hasStrictHealthFailure(agentRuntimeStrict, "archived_capability_lifecycle");
  const strictHealthDetail = strictHealthFailureDetail(agentRuntimeStrict, textFrom(agentRuntimeStrict?.message ?? runtime.text));
  const strictHealthFixCommand = archivedCapabilityLifecycleDrift
    ? "cd agent-and-tools/apps/agent-runtime && DATABASE_URL=$DATABASE_URL_AGENT_TOOLS npx prisma migrate deploy"
    : "cd agent-and-tools/apps/agent-runtime && DATABASE_URL=$DATABASE_URL_AGENT_TOOLS npx prisma db push --skip-generate";

  const galleryItems = arrayValue(record(gallery.data).items).map(record);
  const seededTemplateCount = galleryItems.filter((item) => Number(item.templateCount ?? 0) > 0).length;
  const galleryBody = record(gallery.data);
  const galleryNeedsUserSession = gallery.status === 401 || gallery.status === 403 || galleryBody.authRequired === true || galleryBody.referenceOnly === true;

  const llmBody = record(llm.data);
  const providerBody = record(record(llmBody.providers).data);
  const providers = arrayValue(providerBody.providers).map(record);
  const readyProviders = providers.filter((provider) => provider.ready === true);
  const runtimeBridgeEnvelope = record(record(llmBody.runtimeBridgeStatus).data);
  const connectedRuntimes = arrayValue(runtimeBridgeEnvelope.connected);
  const runtimeHealths = connectedRuntimes.map((runtime) => record(record(runtime).health));
  const runtimeModels = runtimeHealths.flatMap((health) => modelRows(health.llm_models));
  const modelBody = record(record(llmBody.models).data);
  const directModels = modelRows(modelBody.models);
  const models = runtimeModels.length > 0 ? runtimeModels : directModels;
  const defaultModelAlias =
    runtimeHealths.map((health) => stringValue(health.llm_default_model_alias)).find(Boolean)
    ?? stringValue(modelBody.default_model_alias)
    ?? stringValue(models.find((model) => model.default === true)?.id);
  const defaultRuntimeHealth = runtimeHealths.find((health) => stringValue(health.llm_default_model_alias) === defaultModelAlias);
  const defaultModel = models.find((model) => stringValue(model.id) === defaultModelAlias) ?? models.find((model) => model.default === true);
  const defaultModelReady = typeof defaultRuntimeHealth?.llm_default_model_ready === "boolean"
    ? Boolean(defaultRuntimeHealth.llm_default_model_ready)
    : defaultModel
      ? modelReady(defaultModel)
      : false;
  const defaultModelWarnings = stringArray(defaultRuntimeHealth?.llm_default_model_warnings).length > 0
    ? stringArray(defaultRuntimeHealth?.llm_default_model_warnings)
    : defaultModel
      ? stringArray(defaultModel.warnings)
      : ["Default model alias was not reported by the connected runtime."];
  const readyModelAliases = runtimeHealths.flatMap((health) => stringArray(health.llm_ready_model_aliases)).length > 0
    ? runtimeHealths.flatMap((health) => stringArray(health.llm_ready_model_aliases))
    : models.filter(modelReady).map((model) => stringValue(model.id)).filter((id): id is string => Boolean(id));

  const agentRows = arrayValue(record(agentTemplates.data).items);
  const agentTemplatesNeedUserSession = agentTemplates.status === 401 || agentTemplates.status === 403;

  const checks: AdoptionCheck[] = [
    check(
      "iam",
      "Identity / IAM",
      "core",
      iamHealth.ok ? "ready" : "blocked",
      iamHealth.ok ? "IAM health is reachable for login and runtime token minting." : "IAM is required for login, service tokens, and runtime JWT minting.",
      {
        detail: iamHealth.ok ? undefined : iamHealth.text,
        fixCommand: "bin/bare-metal-apps.sh up",
        fixRoute: "/identity/login",
      },
    ),
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
      "agent-runtime-strict",
      "Agent Runtime Strict Health",
      "core",
      agentRuntimeStrict?.ok === true ? "ready" : "blocked",
      agentRuntimeStrict?.ok === true
        ? "Agent Runtime schema and learning-worker invariants are green."
        : "Agent Runtime strict health failed; capability refresh, profile resolution, or governed runs may be unsafe.",
      {
        detail: strictHealthDetail,
        fixCommand: strictHealthFixCommand,
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
      "prompt-composer",
      "Prompt Composer",
      "core",
      promptComposerHealth.ok ? "ready" : "blocked",
      promptComposerHealth.ok ? "Prompt Composer health is reachable." : "Prompt Composer is required to assemble agent instructions and skill metadata.",
      {
        detail: promptComposerHealth.ok ? undefined : promptComposerHealth.text,
        fixCommand: "bin/bare-metal-apps.sh up",
        fixRoute: "/prompt-workbench",
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
      "llm-default-model",
      "Default Model Alias",
      "runtime",
      defaultModelReady ? "ready" : readyModelAliases.length > 0 ? "warning" : "blocked",
      defaultModelReady
        ? `Default model alias ${defaultModelAlias ?? "default"} is ready.`
        : `${defaultModelAlias ?? "default"} is not ready. ${defaultModelWarnings.join(" ")}`,
      {
        detail: readyModelAliases.length > 0 ? `Ready aliases: ${readyModelAliases.slice(0, 8).join(", ")}` : undefined,
        fixCommand: readyModelAliases.length > 0
          ? `bin/mcp-runtime-setup.sh connect --default-model ${readyModelAliases[0]}`
          : "bin/mcp-runtime-setup.sh",
        fixRoute: "/llm-settings",
      },
    ),
    check(
      "seeded-workflows",
      "Seeded SDLC Workflows",
      "sdlc",
      galleryNeedsUserSession ? "warning" : seededTemplateCount >= 3 ? "ready" : seededTemplateCount > 0 ? "warning" : "blocked",
      galleryNeedsUserSession
        ? "Login is required before Platform Web can inspect user-facing workflow templates."
        : seededTemplateCount > 0
        ? `${seededTemplateCount}/${galleryItems.length} SDLC intents have a matching template.`
        : "No curated SDLC workflow templates were found.",
      {
        detail: galleryNeedsUserSession ? gallery.text : undefined,
        fixCommand: "bin/doctor.sh --fix",
        fixRoute: galleryNeedsUserSession ? "/identity/login" : "/workflows/templates/gallery",
      },
    ),
    check(
      "agent-studio-seeds",
      "Agent Studio Seeds",
      "sdlc",
      agentRows.length > 0 ? "ready" : agentTemplatesNeedUserSession ? "warning" : agentTemplates.ok ? "warning" : "blocked",
      agentRows.length > 0
        ? `${agentRows.length} common agent template(s) visible.`
        : agentTemplatesNeedUserSession
          ? "Login is required before Platform Web can inspect common agent templates."
        : "No common agent templates were visible to Platform Web.",
      {
        detail: agentTemplates.ok ? undefined : agentTemplates.text,
        fixCommand: "bin/doctor.sh --fix",
        fixRoute: agentTemplatesNeedUserSession ? "/identity/login" : "/agents/studio",
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
      readyModelAliasCount: readyModelAliases.length,
      readyModelAliases: readyModelAliases.slice(0, 20),
      defaultModelAlias,
      defaultModelReady,
      seededIntentCount: seededTemplateCount,
    },
    ready,
    warning,
    blocked,
    checks,
  });
}
