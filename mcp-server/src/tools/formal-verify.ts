import type { ToolHandler } from "./registry";
import { config } from "../config";

const FORMAL_VERIFICATION_TIMEOUT_MS = config.FORMAL_VERIFICATION_TIMEOUT_MS;
const FORMAL_VERIFICATION_HTTP_GRACE_MS = config.FORMAL_VERIFICATION_HTTP_GRACE_MS;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function positiveTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), FORMAL_VERIFICATION_TIMEOUT_MS)
    : FORMAL_VERIFICATION_TIMEOUT_MS;
}

export const formalVerifyTool: ToolHandler = {
  descriptor: {
    name: "formal_verify",
    description: "Run a formal verification query against the configured Formal Verifier service and return a structured verification receipt.",
    natural_language:
      "Use this when code, workflow, or governance constraints need solver-backed verification. SAT means a violation or target state is possible; UNSAT means the forbidden state is impossible.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Verification scope, for example CODE_CHANGE_FINISH or WORKFLOW_POLICY." },
        facts: { type: "object", description: "Known facts used by constraints and query." },
        constraints: { type: "array", items: { type: "object" }, description: "Policy or domain constraints." },
        query: { type: "object", description: "Solver query expression." },
        artifactRefs: { type: "array", items: { type: "object" }, description: "Optional evidence references." },
        timeoutMs: { type: "number", description: "Verifier timeout in milliseconds." },
      },
      required: ["scope", "facts", "query"],
    },
    risk_level: "MEDIUM",
    requires_approval: false,
  },
  async execute(args) {
    const scope = String(args.scope ?? "").trim();
    if (!scope) return { success: false, output: null, error: "scope is required" };
    const timeoutMs = positiveTimeout(args.timeoutMs);
    const payload = {
      scope,
      facts: asRecord(args.facts),
      constraints: asRecordArray(args.constraints),
      query: asRecord(args.query),
      artifactRefs: asRecordArray(args.artifactRefs),
      options: { timeoutMs },
      metadata: {
        generatedBy: "mcp-server",
        tool: "formal_verify",
      },
    };
    const started = Date.now();
    try {
      const res = await fetch(`${config.FORMAL_VERIFIER_URL.replace(/\/+$/, "")}/api/v1/verification/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs + FORMAL_VERIFICATION_HTTP_GRACE_MS),
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
      } catch {
        parsed = { message: text };
      }
      if (!res.ok) {
        return {
          success: false,
          output: {
            kind: "verification_result",
            verification_kind: "formal",
            command: "formal_verify",
            passed: false,
            result: "ERROR",
            error: String(parsed.message ?? `formal verifier returned HTTP ${res.status}`),
            payload,
            duration_ms: Date.now() - started,
          },
          error: String(parsed.message ?? `formal verifier returned HTTP ${res.status}`),
        };
      }
      const result = String(parsed.result ?? "UNKNOWN").toUpperCase();
      const passed = result === "UNSAT" || (result === "UNKNOWN" && !config.FORMAL_VERIFICATION_BLOCK_ON_UNKNOWN);
      return {
        success: true,
        output: {
          kind: "verification_result",
          verification_kind: "formal",
          command: "formal_verify",
          passed,
          result,
          riskLevel: typeof parsed.riskLevel === "string" ? parsed.riskLevel : undefined,
          requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined,
          resultId: typeof parsed.resultId === "string" ? parsed.resultId : undefined,
          receiptId: typeof parsed.receiptId === "string" ? parsed.receiptId : undefined,
          counterexample: parsed.counterexample,
          explanation: typeof parsed.explanation === "string" ? parsed.explanation : undefined,
          recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : undefined,
          solver: parsed.solver,
          hashes: parsed.hashes,
          payload,
          duration_ms: Date.now() - started,
        },
      };
    } catch (err) {
      return {
        success: false,
        output: {
          kind: "verification_result",
          verification_kind: "formal",
          command: "formal_verify",
          passed: false,
          result: "ERROR",
          error: (err as Error).message,
          payload,
          duration_ms: Date.now() - started,
        },
        error: (err as Error).message,
      };
    }
  },
};
