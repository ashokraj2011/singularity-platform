/**
 * M22 / fan-out — fire-and-forget emitter to audit-governance-service.
 *
 * Producers should NEVER await this — emission failures must not block any
 * request handler. Set AUDIT_GOV_URL="" to disable.
 */
import { logger } from "../config/logger";

const AUDIT_GOV_URL = process.env.AUDIT_GOV_URL ?? "http://host.docker.internal:8500";
const TIMEOUT_MS    = 5_000;
const AUDIT_GOV_SERVICE_TOKEN = process.env.AUDIT_GOV_SERVICE_TOKEN ?? "";

function auditHeaders(): Record<string, string> {
  return AUDIT_GOV_SERVICE_TOKEN
    ? { "content-type": "application/json", authorization: `Bearer ${AUDIT_GOV_SERVICE_TOKEN}` }
    : { "content-type": "application/json" };
}

/**
 * M35.4 — trace_id is now mandatory (TypeScript-level required field).
 * Pass `undefined` only when a trace genuinely cannot be derived. We log
 * a warning at runtime so call sites that lose their trace_id surface.
 */
export interface EmitInput {
  trace_id:       string | undefined;
  source_service: string;
  kind:           string;
  subject_type?:  string;
  subject_id?:    string;
  actor_id?:      string;
  capability_id?: string;
  tenant_id?:     string;
  severity?:      "info" | "warn" | "error" | "audit";
  payload?:       Record<string, unknown>;
}

export function emitAuditEvent(input: EmitInput): void {
  if (!AUDIT_GOV_URL) return;
  if (!input.trace_id) {
    logger.warn(`audit-gov emit ${input.source_service}/${input.kind} missing trace_id — event will not be joinable to a run`);
  }
  void (async () => {
    try {
      const res = await fetch(`${AUDIT_GOV_URL.replace(/\/$/, "")}/api/v1/events`, {
        method:  "POST",
        headers: auditHeaders(),
        body:    JSON.stringify({ ...input, source_service: input.source_service || "prompt-composer" }),
        signal:  AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        // M35.4 — capture raw body for debug, include trace_id
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 500);
        } catch (textErr) {
          detail = `<body read failed: ${(textErr as Error).message}>`;
        }
        logger.warn({ kind: input.kind, status: res.status, detail, trace_id: input.trace_id },
          `audit-gov emit ${input.kind} → ${res.status}`);
      }
    } catch (err) {
      logger.warn({ kind: input.kind, err: (err as Error).message, trace_id: input.trace_id },
        `audit-gov emit ${input.kind} failed`);
    }
  })();
}
