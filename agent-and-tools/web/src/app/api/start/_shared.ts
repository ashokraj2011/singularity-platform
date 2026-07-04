import { NextRequest } from "next/server";
import { readJsonish } from "../_json";

export type StartBlocker = {
  id: string;
  label: string;
  message: string;
  severity: "blocked" | "warning";
  fixCommand?: string;
  fixRoute?: string;
};

export type StartRecommendation = {
  intent: string;
  intentLabel: string;
  capabilityId: string | null;
  capabilityName: string | null;
  workflowTemplateId: string | null;
  workflowTemplateName: string | null;
  modelAlias: string;
  runtimePreference: string;
  governancePreset: string;
  demoMode: boolean;
};

export type StartModelReadiness = {
  alias: string;
  ready: boolean;
  source: "runtime-bridge" | "debug-gateway" | "unknown";
  defaultAlias: string | null;
  readyAliases: string[];
  warnings: string[];
};

export type StartPreviewInput = {
  story?: string;
  intent?: string;
  capabilityId?: string;
  modelAlias?: string;
  runtimePreference?: string;
  governancePreset?: string;
};

const FETCH_TIMEOUT_MS = 3500;
const FALLBACK_STORY = "As a product owner, I want a governed SDLC workflow that turns a story into WorkItems, launches implementation, captures tests, and exports delivery evidence.";

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
    const body = await readJsonish(res);
    return { ok: res.ok, status: res.status, data: body.data, text: body.text };
  } catch (err) {
    return { ok: false, status: 0, data: null, text: err instanceof Error ? err.message : "Request failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function needsUserSession(status: number): boolean {
  return status === 401 || status === 403;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function unwrapArray(value: unknown, keys: string[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(record);
  const obj = record(value);
  const data = obj.success === true && obj.data != null ? obj.data : value;
  if (Array.isArray(data)) return data.map(record);
  const dataObj = record(data);
  for (const key of [...keys, "items", "content", "data", "capabilities"]) {
    const rows = dataObj[key];
    if (Array.isArray(rows)) return rows.map(record);
  }
  return [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boolValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asStrings(value: unknown): string[] {
  return arrayValue(value).map(String).filter((item) => item.trim().length > 0);
}

function capabilityStatus(value: Record<string, unknown>): string {
  return String(value.status ?? "").trim().toUpperCase();
}

function isLaunchableCapability(value: Record<string, unknown>): boolean {
  return capabilityStatus(value) === "ACTIVE";
}

function runtimeRows(value: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    const obj = record(item);
    if (!Object.keys(obj).length) return;
    if (obj.runtime_id || obj.device_id) rows.push(obj);
    Object.values(obj).forEach(visit);
  };
  visit(value);
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = stringValue(row.runtime_id) ?? stringValue(row.device_id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function modelRows(value: unknown): Record<string, unknown>[] {
  return arrayValue(value)
    .map(record)
    .filter((model) => Boolean(stringValue(model.id) || stringValue(model.model)));
}

function modelReady(model: Record<string, unknown>): boolean {
  return model.ready !== false;
}

function modelWarnings(model: Record<string, unknown>): string[] {
  return asStrings(model.warnings);
}

function resolveModelReadiness(llmData: unknown, requestedAlias: string | null): StartModelReadiness {
  const llmBody = record(llmData);
  const runtimeEnvelope = record(record(llmBody.runtimeBridgeStatus).data);
  const runtime = runtimeRows(runtimeEnvelope).find((row) => modelRows(record(row.health).llm_models).length > 0);
  const health = record(runtime?.health);
  const runtimeModels = modelRows(health.llm_models);
  const directModelBody = record(record(llmBody.models).data);
  const directModels = modelRows(directModelBody.models);
  const models = runtimeModels.length > 0 ? runtimeModels : directModels;
  const source: StartModelReadiness["source"] = runtimeModels.length > 0 ? "runtime-bridge" : directModels.length > 0 ? "debug-gateway" : "unknown";
  const defaultAlias =
    stringValue(health.llm_default_model_alias)
    ?? stringValue(directModelBody.default_model_alias)
    ?? stringValue(models.find((model) => model.default === true)?.id);
  const alias = requestedAlias ?? defaultAlias ?? stringValue(models.find(modelReady)?.id) ?? "mock";
  const matched = models.find((model) => stringValue(model.id) === alias);
  const readyAliases = asStrings(health.llm_ready_model_aliases).length > 0
    ? asStrings(health.llm_ready_model_aliases)
    : models.filter(modelReady).map((model) => stringValue(model.id)).filter((id): id is string => Boolean(id));

  if (matched) {
    return {
      alias,
      ready: modelReady(matched),
      source,
      defaultAlias,
      readyAliases,
      warnings: modelWarnings(matched),
    };
  }

  if (alias === defaultAlias && boolValue(health.llm_default_model_ready) != null) {
    return {
      alias,
      ready: Boolean(health.llm_default_model_ready),
      source,
      defaultAlias,
      readyAliases,
      warnings: asStrings(health.llm_default_model_warnings),
    };
  }

  return {
    alias,
    ready: false,
    source,
    defaultAlias,
    readyAliases,
    warnings: [`Model alias ${alias} is not present in the ${source === "runtime-bridge" ? "runtime" : "gateway"} model catalog.`],
  };
}

function recommendIntent(story: string, requested: string | null, galleryItems: Record<string, unknown>[]): string {
  const ids = new Set(galleryItems.map((item) => stringValue(item.id)).filter((id): id is string => Boolean(id)));
  if (requested && ids.has(requested)) return requested;

  const lower = story.toLowerCase();
  const scored: Array<[string, RegExp]> = [
    ["security_review", /\b(security|threat|vulnerability|jwt|token|auth|permission|tenant|compliance)\b/],
    ["release_evidence", /\b(release|evidence|audit|approval|receipt|handoff|yaml|copilot)\b/],
    ["add_tests", /\b(test|coverage|regression|contract|unit|e2e|playwright)\b/],
    ["refactor_safely", /\b(refactor|cleanup|modular|debt|simplify|rename|extract)\b/],
    ["fix_bug", /\b(bug|fix|error|failed|failing|exception|broken|regression|crash)\b/],
    ["build_feature", /\b(feature|implement|create|add|build|story|user)\b/],
  ];
  for (const [intent, pattern] of scored) {
    if (ids.has(intent) && pattern.test(lower)) return intent;
  }
  return ids.has("build_feature") ? "build_feature" : stringValue(galleryItems[0]?.id) ?? "build_feature";
}

function healthRows(value: unknown, key: "blocked" | "warning"): StartBlocker[] {
  return unwrapArray(record(value)[key]).map((item) => ({
    id: String(item.id ?? item.label ?? key),
    label: String(item.label ?? item.id ?? key),
    message: String(item.message ?? item.summary ?? item.detail ?? "Check needs attention."),
    severity: key === "blocked" ? "blocked" : "warning",
    fixCommand: stringValue(item.fixCommand) ?? undefined,
    fixRoute: stringValue(item.fixRoute) ?? undefined,
  }));
}

export async function buildStartPreview(req: NextRequest, input: StartPreviewInput) {
  const origin = req.nextUrl.origin;
  const story = (input.story ?? "").trim() || FALLBACK_STORY;
  const [galleryRes, healthRes, capabilitiesRes, llmRes] = await Promise.all([
    getJson(origin, "/api/workflow-templates/gallery", req),
    getJson(origin, "/api/adoption/health", req),
    getJson(origin, "/api/runtime/capabilities", req),
    getJson(origin, "/api/llm-settings", req),
  ]);

  const galleryItems = unwrapArray(galleryRes.data, ["items"]);
  const capabilities = unwrapArray(capabilitiesRes.data, ["items", "data", "capabilities"]);
  const launchableCapabilities = capabilities.filter(isLaunchableCapability);
  const galleryMeta = record(galleryRes.data);
  const galleryNeedsUserSession = needsUserSession(galleryRes.status) || galleryMeta.authRequired === true || galleryMeta.referenceOnly === true;
  const capabilitiesNeedUserSession = needsUserSession(capabilitiesRes.status);
  const intent = recommendIntent(story, stringValue(input.intent), galleryItems);
  const selectedIntent = galleryItems.find((item) => item.id === intent) ?? galleryItems[0] ?? {};
  const requestedCapabilityId = stringValue(input.capabilityId);
  const requestedCapability = requestedCapabilityId
    ? capabilities.find((capability) => stringValue(capability.id) === requestedCapabilityId)
    : undefined;
  const selectedCapability = requestedCapabilityId
    ? launchableCapabilities.find((capability) => stringValue(capability.id) === requestedCapabilityId) ?? {}
    : launchableCapabilities[0] ?? {};
  const workflowTemplate = record(selectedIntent.workflowTemplate);
  const health = record(healthRes.data);
  const healthSummary = record(health.summary);
  const connectedRuntimeCount = Number(healthSummary.connectedRuntimeCount ?? 0);
  const readyProviderCount = Number(healthSummary.readyProviderCount ?? 0);
  const hasRuntime = Number.isFinite(connectedRuntimeCount) && connectedRuntimeCount > 0;
  const hasProvider = Number.isFinite(readyProviderCount) && readyProviderCount > 0;
  const workflowTemplateId = stringValue(workflowTemplate.id);
  const requestedModelAlias = stringValue(input.modelAlias);
  const initialModelAlias = requestedModelAlias
    ?? stringValue(selectedIntent.defaultModelAlias)
    ?? null;
  let modelReadiness = resolveModelReadiness(llmRes.data, initialModelAlias);
  const canAutoFallbackModel = !requestedModelAlias && !modelReadiness.ready && modelReadiness.readyAliases.length > 0;
  if (canAutoFallbackModel) {
    modelReadiness = resolveModelReadiness(llmRes.data, modelReadiness.readyAliases[0]);
  }
  const hasReadyAlias = modelReadiness.ready;
  const demoMode = !hasRuntime || !hasProvider || canAutoFallbackModel;
  const runtimePreference = stringValue(input.runtimePreference)
    ?? (demoMode ? "mock_ok" : stringValue(selectedIntent.runtimePreference) ?? "user_runtime");
  const modelAlias = modelReadiness.alias;
  const governancePreset = stringValue(input.governancePreset) ?? stringValue(selectedIntent.governancePreset) ?? "standard";

  const blockers: StartBlocker[] = [
    ...healthRows(health, "blocked"),
    ...healthRows(health, "warning"),
  ];
  if (!workflowTemplateId && galleryNeedsUserSession) {
    blockers.unshift({
      id: "workflow-template-auth",
      label: "Workflow templates",
      message: "Login is required before Platform Web can inspect workflow templates for launch.",
      severity: "blocked",
      fixRoute: "/identity/login",
    });
  } else if (!workflowTemplateId) {
    blockers.unshift({
      id: "workflow-template",
      label: "Workflow template",
      message: `No seeded workflow template was found for ${String(selectedIntent.label ?? intent)}.`,
      severity: "blocked",
      fixCommand: "bin/doctor.sh --fix",
      fixRoute: "/workflows/templates/gallery",
    });
  }
  if (requestedCapabilityId && !stringValue(selectedCapability.id)) {
    const status = requestedCapability ? capabilityStatus(requestedCapability) || "UNKNOWN" : "UNAVAILABLE";
    blockers.unshift({
      id: "capability-not-launchable",
      label: "Capability",
      message: requestedCapability
        ? `Selected capability is ${status}; only ACTIVE capabilities can launch guided SDLC workflows.`
        : "Selected capability is not available for launch. It may be archived, deleted, or hidden by your session scope.",
      severity: "blocked",
      fixRoute: "/capabilities",
    });
  } else if (!stringValue(selectedCapability.id) && capabilitiesNeedUserSession) {
    blockers.unshift({
      id: "capability-auth",
      label: "Capability",
      message: "Login is required before Platform Web can inspect capabilities for launch.",
      severity: "blocked",
      fixRoute: "/identity/login",
    });
  } else if (!stringValue(selectedCapability.id)) {
    blockers.unshift({
      id: "capability",
      label: "Capability",
      message: capabilities.length > 0
        ? "No ACTIVE capability is available for this launch. Activate or bootstrap a capability first."
        : "No capability is available for this launch. Create or bootstrap a capability first.",
      severity: "blocked",
      fixRoute: "/capabilities",
    });
  }
  if (!hasRuntime) {
    blockers.push({
      id: "runtime-demo-fallback",
      label: "Demo fallback",
      message: "No MCP runtime is connected. The recommended launch is set to mock runtime mode for first-run testing.",
      severity: "warning",
      fixCommand: "bin/mcp-runtime-setup.sh",
      fixRoute: "/llm-settings",
    });
  }
  if (!hasProvider) {
    blockers.push({
      id: "llm-demo-fallback",
      label: "Mock model fallback",
      message: "No real LLM provider is ready. The recommended model alias is mock so the fresh-clone path can still be tested.",
      severity: "warning",
      fixRoute: "/llm-settings",
    });
  }
  if (canAutoFallbackModel) {
    blockers.push({
      id: "llm-model-auto-fallback",
      label: "Default model fallback",
      message: `The configured default model was not ready, so the preview selected ${modelAlias} for demo-safe launch.`,
      severity: "warning",
      fixRoute: "/llm-settings",
    });
  } else if (!hasReadyAlias && runtimePreference !== "mock_ok") {
    blockers.push({
      id: "llm-model-alias",
      label: "Model alias",
      message: `${modelReadiness.alias} is not ready. ${modelReadiness.warnings.join(" ") || "Choose a ready model alias."}`,
      severity: "blocked",
      fixCommand: modelReadiness.readyAliases.length > 0
        ? `bin/mcp-runtime-setup.sh connect --default-model ${modelReadiness.readyAliases[0]}`
        : "bin/mcp-runtime-setup.sh",
      fixRoute: "/llm-settings",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    story,
    recommendation: {
      intent,
      intentLabel: String(selectedIntent.label ?? intent.replace(/_/g, " ")),
      capabilityId: stringValue(selectedCapability.id),
      capabilityName: stringValue(selectedCapability.name),
      workflowTemplateId,
      workflowTemplateName: stringValue(workflowTemplate.name),
      modelAlias,
      runtimePreference,
      governancePreset,
      demoMode,
    } satisfies StartRecommendation,
    sampleStories: galleryItems.map((item) => ({
      intent: String(item.id ?? ""),
      label: String(item.label ?? item.id ?? "SDLC intent"),
      story: String(item.sampleStory ?? ""),
    })).filter((item) => item.intent && item.story),
    intents: galleryItems.map((item) => {
      const template = record(item.workflowTemplate);
      return {
        id: String(item.id ?? ""),
        label: String(item.label ?? item.id ?? "SDLC intent"),
        description: String(item.description ?? ""),
        requiredInputs: asStrings(item.requiredInputs),
        sampleStory: stringValue(item.sampleStory),
        defaultAgents: asStrings(item.defaultAgents),
        defaultModelAlias: stringValue(item.defaultModelAlias),
        runtimePreference: stringValue(item.runtimePreference),
        governancePreset: stringValue(item.governancePreset),
        runtimeRequirement: stringValue(item.runtimeRequirement),
        templateCount: Number(item.templateCount ?? 0),
        workflowTemplate: stringValue(template.id) ? template : null,
      };
    }).filter((item) => item.id),
    capabilities: launchableCapabilities.slice(0, 50).map((capability) => ({
      id: String(capability.id ?? ""),
      name: String(capability.name ?? capability.id ?? "Capability"),
      capabilityType: stringValue(capability.capabilityType),
      status: stringValue(capability.status),
    })).filter((capability) => capability.id),
    blockers,
    modelReadiness,
    catalog: {
      referenceOnly: galleryMeta.referenceOnly === true,
      authRequired: galleryMeta.authRequired === true || galleryNeedsUserSession,
      message: stringValue(galleryMeta.message),
    },
    health: healthRes.ok ? health : { blocked: [{ id: "adoption-health", message: healthRes.text }] },
  };
}
