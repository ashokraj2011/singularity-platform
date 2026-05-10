const AGENT_BASE = "/api/agents";
const TOOL_BASE = "/api/tools";

async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
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

type Envelope<T> = { success: boolean; data: T; error: { code: string; message: string } | null; requestId: string | null };

async function reqEnv<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const json = await res.json() as Envelope<T>;
  if (!res.ok || !json.success) {
    throw new Error(json.error?.message ?? res.statusText);
  }
  return json.data;
}

type Row = Record<string, unknown>;

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

  assemble: (body: Row) =>
    reqEnv<Row>(`${COMPOSER_BASE}/prompt-assemblies`, { method: "POST", body: JSON.stringify(body) }),
  getAssembly: (id: string) => reqEnv<Row>(`${COMPOSER_BASE}/prompt-assemblies/${id}`),

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
