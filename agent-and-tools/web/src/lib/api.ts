// The unified platform web app is mounted at root by default. Keep the optional
// prefix hook for split deployments, but normal local Docker now leaves it empty.
const BP = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export function apiPath(p: string): string {
  return p.startsWith("/") ? `${BP}${p}` : p;
}
const AGENT_BASE = "/api/agents";
const TOOL_BASE = "/api/tools";
const AUDIT_GOV_BASE = "/api/audit-gov";
const WORKGRAPH_BASE = "/api/workgraph";

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
    public details?: unknown,
    public requestId?: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function readResponseBody(res: Response): Promise<{ raw: string; parsed: unknown }> {
  const raw = await res.text();
  if (!raw) return { raw, parsed: null };
  try {
    return { raw, parsed: JSON.parse(raw) as unknown };
  } catch {
    return { raw, parsed: raw };
  }
}

export function responseMessage(parsed: unknown, raw: string, fallback: string): string {
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const message = obj.message ?? obj.error ?? obj.detail ?? obj.title;
    if (typeof message === "string" && message.trim()) return message;
    if (message != null) return JSON.stringify(message).slice(0, 500);
  }
  return raw ? raw.slice(0, 500) : fallback;
}

function bearerHeader(token?: string | null): Record<string, string> | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  return { Authorization: trimmed.startsWith("Bearer ") ? trimmed : `Bearer ${trimmed}` };
}

function tokenFromPersistedStore(key: string): string | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: { token?: string | null }; token?: string | null };
    return parsed.state?.token ?? parsed.token ?? null;
  } catch {
    return null;
  }
}

// Fired whenever the stored session token changes so the front-door gate
// (RequireSession) re-evaluates immediately — same-tab. Cross-tab is covered by
// the native `storage` event.
export const AUTH_CHANGED_EVENT = "singularity-auth-changed";

export function notifyAuthChanged(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
  } catch {
    /* ignore — event dispatch is best-effort */
  }
}

export function hasAgentToolsToken(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(authHeaders().Authorization);
}

export function saveAgentToolsToken(token: string, user?: Row): void {
  if (typeof window === "undefined") return;
  localStorage.setItem("agent-tools-token", token);
  localStorage.setItem("singularity-portal.auth", JSON.stringify({
    state: { token, user: user ?? null },
    version: 0,
  }));
  notifyAuthChanged();
}

export function clearAgentToolsToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem("agent-tools-token");
  localStorage.removeItem("singularity-portal.auth");
  localStorage.removeItem("workgraph-auth");
  localStorage.removeItem("iam-auth");
  notifyAuthChanged();
}

export function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  for (const key of ["agent-tools-token", "auth-token", "token"]) {
    const header = bearerHeader(localStorage.getItem(key));
    if (header) return header;
  }

  for (const key of ["iam-auth", "singularity-portal.auth", "workgraph-auth"]) {
    const header = bearerHeader(tokenFromPersistedStore(key));
    if (header) return header;
  }

  return {};
}

async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiPath(url), { ...opts, headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts?.headers ?? {}) } });
  } catch (err) {
    throw new ApiError((err as Error).message || "Network request failed");
  }
  const { raw, parsed } = await readResponseBody(res);
  if (!res.ok) {
    const obj = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    throw new ApiError(
      responseMessage(parsed, raw, res.statusText),
      res.status,
      typeof obj.code === "string" ? obj.code : undefined,
      obj.details,
      typeof obj.requestId === "string" ? obj.requestId : null,
    );
  }
  return parsed as T;
}

// ── Agent Service ─────────────────────────────────────────
export const agentApi = {
  list: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return req<{ agents: Record<string, unknown>[] }>(`${AGENT_BASE}/agents${qs}`);
  },
  get: (uid: string) => req<Record<string, unknown>>(`${AGENT_BASE}/agents/${uid}`),
  create: (body: Record<string, unknown>) =>
    req<Record<string, unknown>>(`${AGENT_BASE}/agents`, { method: "POST", body: JSON.stringify(body) }),
  setStatus: (uid: string, status: string) =>
    req<Record<string, unknown>>(`${AGENT_BASE}/agents/${uid}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
  audit: (uid: string) => req<{ events: Record<string, unknown>[] }>(`${AGENT_BASE}/agents/${uid}/audit`),

  listVersions: (uid: string) =>
    req<{ versions: Record<string, unknown>[] }>(`${AGENT_BASE}/agents/${uid}/versions`),
  createVersion: (uid: string, body: Record<string, unknown>) =>
    req<Record<string, unknown>>(`${AGENT_BASE}/agents/${uid}/versions`, { method: "POST", body: JSON.stringify(body) }),
  activateVersion: (uid: string, version: number) =>
    req<Record<string, unknown>>(`${AGENT_BASE}/agents/${uid}/versions/${version}/activate`, { method: "POST" }),

  runtimeProfile: (capability_id: string, agent_id: string) =>
    req<Record<string, unknown>>(`${AGENT_BASE}/agents/runtime-profile?capability_id=${capability_id}&agent_id=${agent_id}`),

  listCandidates: (agent_uid?: string, status?: string) => {
    const qs = new URLSearchParams();
    if (agent_uid) qs.set("agent_uid", agent_uid);
    if (status) qs.set("status", status);
    return req<{ candidates: Record<string, unknown>[] }>(`${AGENT_BASE}/learning-candidates?${qs}`);
  },
  reviewCandidate: (id: string, decision: "accepted" | "rejected", review_note?: string) =>
    req<Record<string, unknown>>(`${AGENT_BASE}/learning-candidates/${id}/review`, {
      method: "POST", body: JSON.stringify({ decision, review_note }),
    }),
  distillCandidates: (body: { capability_id: string; agent_uid: string; candidate_type: string; candidate_ids: string[] }) =>
    req<{ written: number; distilled_memory: Record<string, unknown>[]; candidate_ids: string[] }>(
      `${AGENT_BASE}/learning-candidates/distill`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  listLearningProfileVersions: (uid: string, profileType = "durable_learning") =>
    req<{ versions: Record<string, unknown>[] }>(`${AGENT_BASE}/agents/${uid}/learning-profiles/${profileType}/versions`),
};

// ── Tool Service ──────────────────────────────────────────
export const toolApi = {
  list: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return req<{ tools: Record<string, unknown>[] }>(`${TOOL_BASE}${qs}`);
  },
  get: (name: string, version: string) =>
    req<Record<string, unknown>>(`${TOOL_BASE}/${name}/versions/${version}`),
  register: (body: Record<string, unknown>) =>
    req<Record<string, unknown>>(TOOL_BASE, { method: "POST", body: JSON.stringify(body) }),
  activate: (name: string, version: string) =>
    req<Record<string, unknown>>(`${TOOL_BASE}/${name}/versions/${version}/activate`, { method: "POST" }),
  // M20 — partial update of editable fields (requires_approval / status / risk_level).
  patch: (name: string, version: string, body: { requires_approval?: boolean; status?: string; risk_level?: string }) =>
    req<Record<string, unknown>>(`${TOOL_BASE}/${name}/versions/${version}`, {
      method: "PATCH", body: JSON.stringify(body),
    }),

  discover: (body: Record<string, unknown>) =>
    req<{ tools: Record<string, unknown>[] }>(`${TOOL_BASE}/discover`, { method: "POST", body: JSON.stringify(body) }),
  invoke: (body: Record<string, unknown>) =>
    req<Record<string, unknown>>(`${TOOL_BASE}/invoke`, { method: "POST", body: JSON.stringify(body) }),

  executions: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return req<{ executions: Record<string, unknown>[] }>(`${TOOL_BASE}/executions${qs}`);
  },

  listRunners: () => req<{ runners: Record<string, unknown>[] }>("/api/client-runners"),
};

// ── Agent Runtime (new spec) ─────────────────────────────
const RUNTIME_BASE = "/api/runtime";

// ── Prompt Composer (M3 cutover — owns prompt assembly) ──
const COMPOSER_BASE = "/api/composer";

type Envelope<T> = { success: boolean; data: T; error: { code: string; message: string; details?: unknown } | null; requestId: string | null };

async function reqEnv<T>(url: string, opts?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiPath(url), { ...opts, headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts?.headers ?? {}) } });
  } catch (err) {
    throw new ApiError((err as Error).message || "Network request failed");
  }

  const { raw, parsed } = await readResponseBody(res);
  if (!parsed || typeof parsed !== "object") {
    const message = raw
      ? `${res.status} ${res.statusText}: ${raw.slice(0, 500)}`
      : `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status);
  }

  const json = parsed as Envelope<T>;
  if (!json) {
    throw new ApiError(`${res.status} ${res.statusText}: empty response`, res.status);
  }

  if (!res.ok || !json.success) {
    throw new ApiError(
      json.error?.message ?? res.statusText,
      res.status,
      json.error?.code,
      (json.error as { details?: unknown } | null)?.details,
      json.requestId,
    );
  }
  return json.data;
}

async function reqEnvForm<T>(url: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiPath(url), { method: "POST", headers: { ...authHeaders() }, body: form });
  } catch (err) {
    throw new ApiError((err as Error).message || "Network request failed");
  }

  const { raw, parsed } = await readResponseBody(res);
  if (!parsed || typeof parsed !== "object") {
    throw new ApiError(raw ? `${res.status} ${res.statusText}: ${raw.slice(0, 500)}` : res.statusText, res.status);
  }
  const json = parsed as Envelope<T>;
  if (!res.ok || !json.success) {
    throw new ApiError(json.error?.message ?? responseMessage(parsed, raw, res.statusText), res.status, json.error?.code, json.error?.details, json.requestId);
  }
  return json.data;
}

type Row = Record<string, unknown>;

export type IamTeam = { id: string; team_key?: string; name: string; bu_id?: string | null };
export type IamBusinessUnit = { id: string; bu_key?: string; name: string };

export function workgraphRunInsightsUrl(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}/insights`;
}

function unwrapList<T>(data: unknown, key?: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (key && Array.isArray(obj[key])) return obj[key] as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.content)) return obj.content as T[];
  }
  return [];
}

export const identityApi = {
  login: (body: { email: string; password: string }) =>
    req<{ access_token: string; token_type?: string; user: Row }>("/api/iam/auth/local/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listTeams: async () => unwrapList<IamTeam>(await req<unknown>("/api/iam/teams?page=1&size=200"), "items"),
  listBusinessUnits: async () => unwrapList<IamBusinessUnit>(await req<unknown>("/api/iam/business-units?page=1&size=200"), "items"),
};

export const workgraphApi = {
  createWorkflowTemplate: (body: Row) =>
    req<Row>(`${WORKGRAPH_BASE}/workflow-templates`, { method: "POST", body: JSON.stringify(body) }),
  startWorkflowRun: (workflowId: string, body: Row) =>
    req<Row>(`${WORKGRAPH_BASE}/workflow-templates/${encodeURIComponent(workflowId)}/runs`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export const runtimeApi = {
  // Agent templates
  listTemplates: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return reqEnv<{ items: Row[]; total: number }>(`${RUNTIME_BASE}/agents/templates${qs}`);
  },
  getTemplate: (id: string) => reqEnv<Row>(`${RUNTIME_BASE}/agents/templates/${id}`),
  createTemplate: (body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/agents/templates`, { method: "POST", body: JSON.stringify(body) }),
  attachSkillToTemplate: (id: string, skillId: string, isDefault = true) =>
    reqEnv<Row>(`${RUNTIME_BASE}/agents/templates/${id}/skills`, { method: "POST", body: JSON.stringify({ skillId, isDefault }) }),

  // M23 — Agent Studio: derive + lock-aware patch + scoped list helpers.
  // These hit agent-runtime directly; the workgraph facade (/api/agent-studio/*)
  // is used only by the workgraph SPA's NodeInspector.
  listTemplatesScoped: (scope: "common" | "capability" | "all", capabilityId?: string) => {
    const qs = new URLSearchParams({ scope, limit: "100" });
    if (capabilityId) qs.set("capabilityId", capabilityId);
    return reqEnv<{ items: Row[]; total: number }>(`${RUNTIME_BASE}/agents/templates?${qs}`);
  },
  deriveTemplate: (baseId: string, body: { capabilityId: string; name?: string; description?: string }) =>
    reqEnv<Row>(`${RUNTIME_BASE}/agents/templates/${baseId}/derive`, { method: "POST", body: JSON.stringify(body) }),
  createAgentProfile: (body: Row, files?: File[]) => {
    if (files?.length) {
      const form = new FormData();
      form.append("profile", JSON.stringify(body));
      for (const file of files) form.append("files", file, file.name);
      return reqEnvForm<Row>(`${RUNTIME_BASE}/agents/profiles`, form);
    }
    return reqEnv<Row>(`${RUNTIME_BASE}/agents/profiles`, { method: "POST", body: JSON.stringify(body) });
  },
  getAgentProfileSources: (id: string) =>
    reqEnv<Row>(`${RUNTIME_BASE}/agents/profiles/${id}/sources`),
  previewSkillSource: (body: Row, file?: File) => {
    if (file) {
      const form = new FormData();
      form.append("source", JSON.stringify(body));
      form.append("file", file, file.name);
      return reqEnvForm<Row>(`${RUNTIME_BASE}/agents/skill-sources/preview`, form);
    }
    return reqEnv<Row>(`${RUNTIME_BASE}/agents/skill-sources/preview`, { method: "POST", body: JSON.stringify(body) });
  },
  patchTemplate: (id: string, body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/agents/templates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  listTemplateVersions: (id: string) =>
    reqEnv<Row[]>(`${RUNTIME_BASE}/agents/templates/${id}/versions`),
  restoreTemplateVersion: (id: string, version: number, body: { changeSummary?: string } = {}) =>
    reqEnv<Row>(`${RUNTIME_BASE}/agents/templates/${id}/versions/${version}/restore`, {
      method: "POST", body: JSON.stringify(body),
    }),

  // Skills
  listSkills: () => reqEnv<Row[]>(`${RUNTIME_BASE}/agents/skills`),
  createSkill: (body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/agents/skills`, { method: "POST", body: JSON.stringify(body) }),

  // Prompts — served by prompt-composer (port 3004) via /api/composer rewrite
  listProfiles: () => reqEnv<Row[]>(`${COMPOSER_BASE}/prompt-profiles`),
  getProfile: (id: string) => reqEnv<Row>(`${COMPOSER_BASE}/prompt-profiles/${id}`),
  createProfile: (body: Row) =>
    reqEnv<Row>(`${COMPOSER_BASE}/prompt-profiles`, { method: "POST", body: JSON.stringify(body) }),
  attachLayerToProfile: (profileId: string, body: Row) =>
    reqEnv<Row>(`${COMPOSER_BASE}/prompt-profiles/${profileId}/layers`, { method: "POST", body: JSON.stringify(body) }),

  listLayers: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return reqEnv<Row[]>(`${COMPOSER_BASE}/prompt-layers${qs}`);
  },
  createLayer: (body: Row) =>
    reqEnv<Row>(`${COMPOSER_BASE}/prompt-layers`, { method: "POST", body: JSON.stringify(body) }),
  updateLayer: (id: string, body: Row) =>
    reqEnv<Row>(`${COMPOSER_BASE}/prompt-layers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  assemble: (body: Row) =>
    reqEnv<Row>(`${COMPOSER_BASE}/prompt-assemblies`, { method: "POST", body: JSON.stringify(body) }),
  getAssembly: (id: string) => reqEnv<Row>(`${COMPOSER_BASE}/prompt-assemblies/${id}`),
  composePreview: (body: Row) =>
    req<Row>("/api/prompt-workbench/preview", { method: "POST", body: JSON.stringify(body) }),
  composeRespond: (body: Row) =>
    req<Row>("/api/prompt-workbench/respond", { method: "POST", body: JSON.stringify(body) }),
  comparePromptModels: (body: { compose: Row; modelAliases: string[] }) =>
    req<Row>("/api/prompt-workbench/compare", { method: "POST", body: JSON.stringify(body) }),
  llmSettings: () => req<Row>("/api/llm-settings"),

  // Tools
  listToolDefs: () => reqEnv<Row[]>(`${RUNTIME_BASE}/tools`),
  getToolDef: (id: string) => reqEnv<Row>(`${RUNTIME_BASE}/tools/${id}`),
  registerTool: (body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/tools`, { method: "POST", body: JSON.stringify(body) }),
  createContract: (toolId: string, body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/tools/${toolId}/contracts`, { method: "POST", body: JSON.stringify(body) }),

  listPolicies: () => reqEnv<Row[]>(`${RUNTIME_BASE}/tools/policies`),
  createPolicy: (body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/tools/policies`, { method: "POST", body: JSON.stringify(body) }),

  listGrants: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return reqEnv<Row[]>(`${RUNTIME_BASE}/tools/grants${qs}`);
  },
  createGrant: (body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/tools/grants`, { method: "POST", body: JSON.stringify(body) }),

  validateCall: (body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/tools/validate-call`, { method: "POST", body: JSON.stringify(body) }),

  // Capabilities
  listCapabilities: () => reqEnv<Row[]>(`${RUNTIME_BASE}/capabilities`),
  getCapability: (id: string) => reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${id}`),
  createCapability: (body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities`, { method: "POST", body: JSON.stringify(body) }),
  updateCapability: (id: string, body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  archiveCapability: (id: string) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${id}/archive`, { method: "POST" }),
  bootstrapCapability: (body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/bootstrap`, { method: "POST", body: JSON.stringify(body) }),
  bootstrapAgentCatalog: () =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/bootstrap-agent-catalog`),
  // M61 Wire D — Verify-now probe. Returns the structured result
  // (exitCode, signal, timedOut, durationMs, stdout, stderr, …).
  // Used by the capabilities wizard's "Verify" button per command row.
  // capabilityId is a soft anchor (no capability state read today);
  // the wizard passes "_new_" pre-create.
  probeCommand: (capabilityId: string, body: { cmd: string; cwd?: string }) =>
    reqEnv<Row>(
      `${RUNTIME_BASE}/capabilities/${encodeURIComponent(capabilityId)}/world-model/probe-command`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  getBootstrapRun: (capabilityId: string, runId: string) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${capabilityId}/bootstrap-runs/${runId}`),
  reviewBootstrapRun: (capabilityId: string, runId: string, body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${capabilityId}/bootstrap-runs/${runId}/review`, {
      method: "POST", body: JSON.stringify(body),
    }),
  syncCapability: (capabilityId: string, body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${capabilityId}/sync`, { method: "POST", body: JSON.stringify(body) }),
  attachRepo: (id: string, body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${id}/repositories`, { method: "POST", body: JSON.stringify(body) }),
  bindAgent: (id: string, body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${id}/agent-bindings`, { method: "POST", body: JSON.stringify(body) }),
  listBindings: (id: string) =>
    reqEnv<Row[]>(`${RUNTIME_BASE}/capabilities/${id}/agent-bindings`),
  addKnowledge: (id: string, body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${id}/knowledge-artifacts`, { method: "POST", body: JSON.stringify(body) }),
  listKnowledge: (id: string) =>
    reqEnv<Row[]>(`${RUNTIME_BASE}/capabilities/${id}/knowledge-artifacts`),
  // M14 — code-symbol extraction. Send the file list extracted from the
  // user-picked directory; server walks regex extractor + persists.
  extractRepositorySymbols: (capabilityId: string, repoId: string, files: Array<{ path: string; content: string }>) =>
    reqEnv<{
      filesProcessed: number; symbolsScanned: number; inserted: number;
      skippedDuplicate: number; embeddingErrors: number;
      provider: string; providerModel: string;
    }>(
      `${RUNTIME_BASE}/capabilities/${capabilityId}/repositories/${repoId}/extract`,
      { method: "POST", body: JSON.stringify({ files }) },
    ),
  // M17 — polling config + knowledge sources.
  updateRepoPoll: (capabilityId: string, repoId: string, body: { pollIntervalSec?: number | null; defaultBranch?: string }) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${capabilityId}/repositories/${repoId}/poll`,
      { method: "PATCH", body: JSON.stringify(body) }),
  listKnowledgeSources: (capabilityId: string) =>
    reqEnv<Row[]>(`${RUNTIME_BASE}/capabilities/${capabilityId}/knowledge-sources`),
  addKnowledgeSource: (capabilityId: string, body: { url: string; artifactType?: string; title?: string; pollIntervalSec?: number | null }) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${capabilityId}/knowledge-sources`,
      { method: "POST", body: JSON.stringify(body) }),
  updateKnowledgeSource: (capabilityId: string, sourceId: string, body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${capabilityId}/knowledge-sources/${sourceId}`,
      { method: "PATCH", body: JSON.stringify(body) }),
  deleteKnowledgeSource: (capabilityId: string, sourceId: string) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${capabilityId}/knowledge-sources/${sourceId}`,
      { method: "DELETE" }),
  // M16 — re-embed worker
  reembedCapability: (capabilityId: string, kinds?: ("knowledge"|"memory"|"code")[]) =>
    reqEnv<{
      provider: string; providerModel: string;
      knowledge: { scanned: number; embedded: number; failed: number };
      memory: { scanned: number; embedded: number; failed: number };
      code: { scanned: number; embedded: number; failed: number };
    }>(`${RUNTIME_BASE}/capabilities/${capabilityId}/embeddings/reembed`,
      { method: "POST", body: JSON.stringify({ kinds }) }),
  // Learning worker — re-syncs APPROVED repos/knowledge sources (auto-discovers
  // all active ones), re-embeds, and returns warnings + nextActions (e.g. pending
  // bootstrap candidates that still need human approval before they can ingest).
  runLearningWorker: (capabilityId: string, body: Row = {}) =>
    reqEnv<{ warnings?: string[]; nextActions?: string[]; [k: string]: unknown }>(
      `${RUNTIME_BASE}/capabilities/${capabilityId}/learning-worker/run`,
      { method: "POST", body: JSON.stringify(body) }),
  // On-demand world-model re-distillation — re-grounds the capability's agents
  // (LLM enrichment + architecture slice) without re-onboarding.
  redistillWorldModel: (capabilityId: string) =>
    reqEnv<Row>(`${RUNTIME_BASE}/capabilities/${capabilityId}/world-model/redistill`, { method: "POST" }),

  // Executions
  listExecutions: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return reqEnv<Row[]>(`${RUNTIME_BASE}/executions${qs}`);
  },
  getExecution: (id: string) => reqEnv<Row>(`${RUNTIME_BASE}/executions/${id}`),
  createExecution: (body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/executions`, { method: "POST", body: JSON.stringify(body) }),
  startExecution: (id: string, body: Row = {}) =>
    reqEnv<Row>(`${RUNTIME_BASE}/executions/${id}/start`, { method: "POST", body: JSON.stringify(body) }),
  getReceipt: (id: string) => reqEnv<Row>(`${RUNTIME_BASE}/executions/${id}/receipt`),

  // Memory
  listExecutionMemory: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return reqEnv<Row[]>(`${RUNTIME_BASE}/memory/execution${qs}`);
  },
  storeExecutionMemory: (body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/memory/execution`, { method: "POST", body: JSON.stringify(body) }),
  reviewMemory: (id: string, decision: "APPROVED" | "REJECTED" | "CANDIDATE") =>
    reqEnv<Row>(`${RUNTIME_BASE}/memory/execution/${id}/review`, { method: "POST", body: JSON.stringify({ decision }) }),
  promoteMemory: (body: Row) =>
    reqEnv<Row>(`${RUNTIME_BASE}/memory/distilled/promote`, { method: "POST", body: JSON.stringify(body) }),
  listDistilled: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return reqEnv<Row[]>(`${RUNTIME_BASE}/memory/distilled${qs}`);
  },
};

// ── M21 — Audit & Governance Service ─────────────────────
export const auditGovApi = {
  summary: () => req<{
    audit_events: number; llm_calls: number;
    total_tokens_all: number; cost_usd_all: number;
    pending_approvals: number; denials_24h: number;
  }>(`${AUDIT_GOV_BASE}/cost/summary`),
  costRollup: (params: { capability_id?: string; period?: "hour"|"day"|"week"; limit?: number }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, String(v));
    return req<{
      period: string; capability_id: string | null;
      buckets: Array<{ bucket: string; calls: number; total_tokens: number; cost_usd: number; input_tokens: number; output_tokens: number }>;
    }>(`${AUDIT_GOV_BASE}/cost/rollup?${qs}`);
  },
  costByModel: (params: { capability_id?: string; days?: number }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, String(v));
    return req<{ days: number; items: Array<{ provider: string; model: string; calls: number; total_tokens: number; cost_usd: number }> }>(
      `${AUDIT_GOV_BASE}/cost/by-model?${qs}`,
    );
  },
  auditTimeline: (params: { trace_id?: string; capability_id?: string; actor_id?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, String(v));
    return req<{ count: number; items: Array<Record<string, unknown>> }>(`${AUDIT_GOV_BASE}/audit/timeline?${qs}`);
  },
  approvals: (params?: { status?: string; capability_id?: string }) => {
    const qs = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, String(v));
    return req<{ items: Array<Record<string, unknown>> }>(`${AUDIT_GOV_BASE}/governance/approvals?${qs}`);
  },
  decideApproval: (id: string, body: { decision: "approved" | "rejected"; decided_by?: string; decision_reason?: string }) =>
    req<Record<string, unknown>>(`${AUDIT_GOV_BASE}/governance/approvals/${id}/decide`, {
      method: "POST", body: JSON.stringify(body),
    }),

  // M63 Slice A — Splunk-like search across audit_events.
  auditSearch: (body: {
    q?: string;
    kinds?: string[];
    severities?: ("info" | "warn" | "error" | "audit")[];
    riskLevels?: ("low" | "medium" | "high" | "critical")[];
    sources?: string[];
    capabilityId?: string;
    actorId?: string;
    traceId?: string;
    since?: string;
    until?: string;
    limit?: number;
    cursor?: string;
  }) => req<{
    items: Array<AuditEventRow>;
    nextCursor: string | null;
    pageSize: number;
    hasMore: boolean;
  }>(`${AUDIT_GOV_BASE}/audit/search`, {
    method: "POST", body: JSON.stringify(body),
  }),

  // M63 Slice A — Filter facets for the UI dropdowns.
  auditFacets: () => req<{
    kinds: Array<{ kind: string; count: number }>;
    sources: Array<{ source_service: string; count: number }>;
    severities: Array<{ severity: string; count: number }>;
    riskLevels: Array<{ risk_level: string; count: number }>;
  }>(`${AUDIT_GOV_BASE}/audit/search/facets`),

  logHealth: () => req<{
    ok: boolean;
    storage: { backend: "filesystem" | "s3"; configured: boolean; path?: string; endpoint?: string; bucket?: string };
    ingested_count: number;
    newest_ts: string | null;
  }>(`${AUDIT_GOV_BASE}/logs/health`),

  logSearch: (body: {
    q?: string;
    levels?: ("trace" | "debug" | "info" | "warn" | "error" | "fatal" | "audit")[];
    services?: string[];
    eventTypes?: string[];
    traceId?: string;
    traceIdPrefix?: string;
    workflowInstanceId?: string;
    workflowNodeId?: string;
    workItemId?: string;
    capabilityId?: string;
    tenantId?: string;
    stageKey?: string;
    agentRole?: string;
    toolName?: string;
    model?: string;
    since?: string;
    until?: string;
    limit?: number;
    cursor?: string;
  }) => req<{
    items: Array<ObservabilityLogRow>;
    nextCursor: string | null;
    pageSize: number;
    hasMore: boolean;
  }>(`${AUDIT_GOV_BASE}/logs/search`, {
    method: "POST", body: JSON.stringify(body),
  }),

  logFacets: () => req<{
    services: Array<{ service: string; count: number }>;
    levels: Array<{ level: string; count: number }>;
    eventTypes: Array<{ event_type: string; count: number }>;
    stages: Array<{ stage_key: string; count: number }>;
    models: Array<{ model: string; count: number }>;
  }>(`${AUDIT_GOV_BASE}/logs/facets`),

  traceTimeline: (traceId: string, limit = 500) =>
    req<{ traceId: string; items: Array<TraceTimelineRow>; count: number }>(
      `${AUDIT_GOV_BASE}/traces/${encodeURIComponent(traceId)}/timeline?limit=${limit}`,
    ),
  engineStats: () => req<Record<string, number>>(`${AUDIT_GOV_BASE}/engine/stats`),
  engineIssues: (params?: { status?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status && params.status !== "all") qs.set("status", params.status);
    if (params?.limit) qs.set("limit", String(params.limit));
    return req<{ items: Array<Record<string, unknown>> }>(`${AUDIT_GOV_BASE}/engine/issues?${qs}`);
  },
  engineIssue: (id: string) =>
    req<Record<string, unknown>>(`${AUDIT_GOV_BASE}/engine/issues/${encodeURIComponent(id)}`),
  engineSweep: () =>
    req<Record<string, unknown>>(`${AUDIT_GOV_BASE}/engine/sweep`, { method: "POST", body: "{}" }),
  engineDiagnose: (id: string) =>
    req<Record<string, unknown>>(`${AUDIT_GOV_BASE}/engine/issues/${encodeURIComponent(id)}/diagnose`, { method: "POST", body: "{}" }),
  engineResolve: (id: string, body: { resolved_by?: string; resolution_notes?: string; create_evaluator?: boolean; create_dataset?: boolean } = {}) =>
    req<Record<string, unknown>>(`${AUDIT_GOV_BASE}/engine/issues/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  engineDismiss: (id: string, body: { resolved_by?: string; resolution_notes?: string } = {}) =>
    req<Record<string, unknown>>(`${AUDIT_GOV_BASE}/engine/issues/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  engineEvaluators: (params?: { enabled?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.enabled !== undefined) qs.set("enabled", String(params.enabled));
    return req<{ items: Array<Record<string, unknown>> }>(`${AUDIT_GOV_BASE}/engine/evaluators?${qs}`);
  },

  // M63 Slice B — SSE live-tail stream. Returns the absolute URL so
  // the caller constructs the EventSource directly (EventSource can't
  // share the `req` wrapper's auth headers since the browser API
  // doesn't support custom headers).
  auditStreamUrl: (filter: {
    kinds?: string[];
    severities?: string[];
    riskLevels?: string[];
    sources?: string[];
    capabilityId?: string;
    actorId?: string;
    traceId?: string;
  } = {}) => {
    const qs = new URLSearchParams();
    if (filter.kinds?.length)      qs.set("kinds",      filter.kinds.join(","));
    if (filter.severities?.length) qs.set("severities", filter.severities.join(","));
    if (filter.riskLevels?.length) qs.set("riskLevels", filter.riskLevels.join(","));
    if (filter.sources?.length)    qs.set("sources",    filter.sources.join(","));
    if (filter.capabilityId)       qs.set("capabilityId", filter.capabilityId);
    if (filter.actorId)            qs.set("actorId", filter.actorId);
    if (filter.traceId)            qs.set("traceId", filter.traceId);
    const search = qs.toString();
    return `${AUDIT_GOV_BASE}/audit/stream${search ? `?${search}` : ""}`;
  },
};

// M63 Slice E — Row shape returned by /audit/search. Exported for the
// UI components to consume without duplicating the type.
export type AuditEventRow = {
  id: string;
  trace_id: string | null;
  source_service: string;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  actor_id: string | null;
  capability_id: string | null;
  tenant_id: string | null;
  severity: string;
  risk_level: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type ObservabilityLogRow = {
  id: string;
  ts: string;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "audit" | string;
  service: string;
  environment: string | null;
  host: string | null;
  trace_id: string | null;
  span_id: string | null;
  workflow_instance_id: string | null;
  workflow_node_id: string | null;
  work_item_id: string | null;
  work_item_code: string | null;
  capability_id: string | null;
  tenant_id: string | null;
  stage_key: string | null;
  agent_role: string | null;
  run_id: string | null;
  tool_name: string | null;
  model: string | null;
  event_type: string | null;
  message: string;
  payload: Record<string, unknown>;
  raw_storage_uri: string | null;
  raw_storage_offset: number | string | null;
  raw_storage_bytes: number | null;
  created_at: string;
};

export type TraceTimelineRow = {
  source: "audit_event" | "log" | string;
  id: string;
  ts: string;
  service: string;
  level: string;
  event_type: string;
  message: string;
  capability_id: string | null;
  tenant_id: string | null;
  payload: Record<string, unknown>;
};
