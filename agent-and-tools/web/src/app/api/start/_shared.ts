import { NextRequest } from "next/server";

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
  const [galleryRes, healthRes, capabilitiesRes] = await Promise.all([
    getJson(origin, "/api/workflow-templates/gallery", req),
    getJson(origin, "/api/adoption/health", req),
    getJson(origin, "/api/runtime/capabilities", req),
  ]);

  const galleryItems = unwrapArray(galleryRes.data, ["items"]);
  const capabilities = unwrapArray(capabilitiesRes.data, ["items", "data", "capabilities"]);
  const intent = recommendIntent(story, stringValue(input.intent), galleryItems);
  const selectedIntent = galleryItems.find((item) => item.id === intent) ?? galleryItems[0] ?? {};
  const selectedCapability = capabilities.find((capability) => capability.id === input.capabilityId) ?? capabilities[0] ?? {};
  const workflowTemplate = record(selectedIntent.workflowTemplate);
  const health = record(healthRes.data);
  const healthSummary = record(health.summary);
  const connectedRuntimeCount = Number(healthSummary.connectedRuntimeCount ?? 0);
  const readyProviderCount = Number(healthSummary.readyProviderCount ?? 0);
  const hasRuntime = Number.isFinite(connectedRuntimeCount) && connectedRuntimeCount > 0;
  const hasProvider = Number.isFinite(readyProviderCount) && readyProviderCount > 0;
  const workflowTemplateId = stringValue(workflowTemplate.id);
  const demoMode = !hasRuntime || !hasProvider;
  const runtimePreference = stringValue(input.runtimePreference)
    ?? (demoMode ? "mock_ok" : stringValue(selectedIntent.runtimePreference) ?? "user_runtime");
  const modelAlias = stringValue(input.modelAlias)
    ?? (hasProvider ? stringValue(selectedIntent.defaultModelAlias) ?? "balanced" : "mock");
  const governancePreset = stringValue(input.governancePreset) ?? stringValue(selectedIntent.governancePreset) ?? "standard";

  const blockers: StartBlocker[] = [
    ...healthRows(health, "blocked"),
    ...healthRows(health, "warning"),
  ];
  if (!workflowTemplateId) {
    blockers.unshift({
      id: "workflow-template",
      label: "Workflow template",
      message: `No seeded workflow template was found for ${String(selectedIntent.label ?? intent)}.`,
      severity: "blocked",
      fixCommand: "bin/doctor.sh --fix",
      fixRoute: "/workflows/templates/gallery",
    });
  }
  if (!stringValue(selectedCapability.id)) {
    blockers.unshift({
      id: "capability",
      label: "Capability",
      message: "No capability is available for this launch. Create or bootstrap a capability first.",
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
    intents: galleryItems.map((item) => ({
      id: String(item.id ?? ""),
      label: String(item.label ?? item.id ?? "SDLC intent"),
      description: String(item.description ?? ""),
      templateCount: Number(item.templateCount ?? 0),
      workflowTemplate: record(item.workflowTemplate),
    })).filter((item) => item.id),
    capabilities: capabilities.slice(0, 50).map((capability) => ({
      id: String(capability.id ?? ""),
      name: String(capability.name ?? capability.id ?? "Capability"),
      capabilityType: stringValue(capability.capabilityType),
      status: stringValue(capability.status),
    })).filter((capability) => capability.id),
    blockers,
    health: healthRes.ok ? health : { blocked: [{ id: "adoption-health", message: healthRes.text }] },
  };
}
