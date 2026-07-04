import { config } from "../config";
import { emitAuditEvent } from "../lib/audit-gov-emit";
import { readUpstreamJsonBody, upstreamSnippet } from "../lib/upstream-json";
import type { ToolHandler } from "./registry";

function learningBase(): string {
  return config.LEARNING_SERVICE_URL.replace(/\/+$/, "");
}

function learningServiceHeaders(): Record<string, string> {
  const token = config.LEARNING_SERVICE_TOKEN ?? process.env.AUDIT_GOV_SERVICE_TOKEN ?? "";
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function readLearningJson(res: Response, path: string): Promise<unknown> {
  const body = await readUpstreamJsonBody(res);
  if (!body.raw.trim()) return null;
  if (!body.parseError) return body.data;
  throw new Error(`learning-service ${path} returned invalid JSON (${res.status}): ${body.parseError}; body=${upstreamSnippet(body.raw, 300)}`);
}

async function learningFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${learningBase()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...learningServiceHeaders(),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`learning-service ${res.status}: ${text.slice(0, 300)}`);
  }
  return readLearningJson(res, path);
}

export const queryLearningStateTool: ToolHandler = {
  descriptor: {
    name: "query_learning_state",
    description: "Fetch prior failure summaries and learned patterns for a capability or situation.",
    natural_language: "Use this before planning or coding to understand prior failures, successful patterns, and known blockers for similar capability work.",
    input_schema: {
      type: "object",
      properties: {
        situation: { type: "string" },
        capabilityId: { type: "string" },
        capabilityType: { type: "string" },
      },
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const params = new URLSearchParams();
    for (const key of ["situation", "capabilityId", "capabilityType"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) params.set(key, value.trim());
    }
    try {
      const output = await learningFetch(`/api/v1/state?${params.toString()}`);
      return { success: true, output };
    } catch (err) {
      return { success: true, output: { unavailable: true, error: (err as Error).message } };
    }
  },
};

export const querySimilarCapabilitiesTool: ToolHandler = {
  descriptor: {
    name: "query_similar_capabilities",
    description: "Find capabilities with similar learning patterns.",
    natural_language: "Use this to look up similar capability implementations and their convergence/failure patterns.",
    input_schema: {
      type: "object",
      properties: {
        capabilityId: { type: "string" },
        limit: { type: "number" },
      },
      required: ["capabilityId"],
    },
    risk_level: "LOW",
    requires_approval: false,
  },
  async execute(args) {
    const capabilityId = typeof args.capabilityId === "string" ? args.capabilityId.trim() : "";
    if (!capabilityId) return { success: false, output: null, error: "capabilityId is required", error_code: "VALIDATION" };
    const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 20);
    try {
      const output = await learningFetch(`/api/v1/similar-capabilities/${encodeURIComponent(capabilityId)}?limit=${limit}`);
      return { success: true, output };
    } catch (err) {
      return { success: true, output: { unavailable: true, error: (err as Error).message, items: [] } };
    }
  },
};

export const recordOutcomePatternTool: ToolHandler = {
  descriptor: {
    name: "record_outcome_pattern",
    description: "Record a reusable outcome pattern learned from a run.",
    natural_language: "Use this at the end of a run to record what worked or failed so future prompt assembly can include the lesson.",
    input_schema: {
      type: "object",
      properties: {
        capabilityId: { type: "string" },
        capabilityType: { type: "string" },
        patternKind: { type: "string" },
        summary: { type: "string" },
        evidence: { type: "object" },
        successRate: { type: "number" },
      },
      required: ["summary"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    const summary = typeof args.summary === "string" ? args.summary.trim() : "";
    if (!summary) return { success: false, output: null, error: "summary is required", error_code: "VALIDATION" };
    const payload = {
      capabilityId: typeof args.capabilityId === "string" ? args.capabilityId : undefined,
      capabilityType: typeof args.capabilityType === "string" ? args.capabilityType : undefined,
      patternKind: typeof args.patternKind === "string" ? args.patternKind : "outcome",
      summary,
      evidence: args.evidence && typeof args.evidence === "object" ? args.evidence : {},
      successRate: typeof args.successRate === "number" ? args.successRate : undefined,
    };
    try {
      const output = await learningFetch("/api/v1/patterns", { method: "POST", body: JSON.stringify(payload) });
      return { success: true, output };
    } catch (err) {
      emitAuditEvent({
        trace_id: "learning-pattern-fallback",
        source_service: "mcp-server",
        kind: "learning.pattern.record_failed",
        capability_id: payload.capabilityId,
        severity: "warn",
        payload: { ...payload, error: (err as Error).message },
      });
      return { success: true, output: { queued_for_audit: true, error: (err as Error).message, ...payload } };
    }
  },
};

function auditRecorderTool(name: string, kind: string, description: string): ToolHandler {
  return {
    descriptor: {
      name,
      description,
      natural_language: description,
      input_schema: {
        type: "object",
        properties: {
          capabilityId: { type: "string" },
          text: { type: "string" },
          context: { type: "object" },
        },
        required: ["text"],
      },
      risk_level: "LOW",
      requires_approval: false,
    },
    async execute(args) {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return { success: false, output: null, error: "text is required", error_code: "VALIDATION" };
      const capabilityId = typeof args.capabilityId === "string" ? args.capabilityId : undefined;
      emitAuditEvent({
        trace_id: `learning-${kind}-${capabilityId ?? 'anon'}`,
        source_service: "mcp-server",
        kind,
        capability_id: capabilityId,
        severity: kind.endsWith("blocker") ? "warn" : "info",
        payload: {
          text,
          context: args.context && typeof args.context === "object" ? args.context : {},
        },
      });
      return { success: true, output: { recorded: true, kind, capabilityId, text } };
    },
  };
}

export const recordAssumptionTool = auditRecorderTool(
  "record_assumption",
  "learning.assumption",
  "Record an assumption that influenced the run for later learning and audit.",
);

export const recordBlockerTool = auditRecorderTool(
  "record_blocker",
  "learning.blocker",
  "Record a blocker encountered by the coding agent for later learning and audit.",
);
