/**
 * M21 — fire-and-forget emitter for the audit-governance-service.
 *
 * Producers should NEVER await this — emission failures must not block the
 * agent loop. Errors land on stderr only. Set AUDIT_GOV_URL="" to disable.
 */
import { log } from "../shared/log";

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
 *
 * Pass `undefined` only when a trace genuinely cannot be derived (e.g.,
 * boot-time events, GC events without a run context). When `undefined` is
 * provided, we log a warning so we can surface and fix call sites over time.
 * Without trace_id, an audit_events row can't be joined back to a run, which
 * makes debugging fail-closed governance decisions effectively impossible.
 */
export interface EmitInput {
  trace_id: string | undefined;
  source_service: string;
  kind: string;
  subject_type?: string;
  subject_id?: string;
  actor_id?: string;
  capability_id?: string;
  tenant_id?: string;
  severity?: "info" | "warn" | "error" | "audit";
  payload?: Record<string, unknown>;
}

export function emitAuditEvent(input: EmitInput): void {
  if (!AUDIT_GOV_URL) return;
  // M35.4 — surface call sites that lost their trace_id so we can fix them.
  if (!input.trace_id) {
    log.warn(`audit-gov emit ${input.source_service}/${input.kind} missing trace_id — event will not be joinable to a run`);
  }
  // Fire-and-forget — explicit `void` so the linter doesn't yell about
  // unhandled promises.
  void (async () => {
    try {
      const res = await fetch(`${AUDIT_GOV_URL.replace(/\/$/, "")}/api/v1/events`, {
        method: "POST",
        headers: auditHeaders(),
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        // M35.4 — capture raw body for debug, include status + url
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 500);
        } catch (textErr) {
          detail = `<body read failed: ${(textErr as Error).message}>`;
        }
        log.warn({ kind: input.kind, status: res.status, detail, trace_id: input.trace_id },
          `audit-gov emit ${input.kind} → ${res.status}`);
      }
    } catch (err) {
      log.warn({ kind: input.kind, err: (err as Error).message, trace_id: input.trace_id },
        `audit-gov emit ${input.kind} failed`);
    }
  })();
}
