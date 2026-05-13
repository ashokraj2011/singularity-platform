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

export interface EmitInput {
  trace_id?:      string;
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
  void (async () => {
    try {
      const res = await fetch(`${AUDIT_GOV_URL.replace(/\/$/, "")}/api/v1/events`, {
        method:  "POST",
        headers: auditHeaders(),
        body:    JSON.stringify({ ...input, source_service: input.source_service || "prompt-composer" }),
        signal:  AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        logger.warn(`audit-gov emit ${input.kind} → ${res.status}: ${detail}`);
      }
    } catch (err) {
      logger.warn(`audit-gov emit ${input.kind} failed: ${(err as Error).message}`);
    }
  })();
}
