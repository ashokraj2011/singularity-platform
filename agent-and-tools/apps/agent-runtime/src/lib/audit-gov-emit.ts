/**
 * M22/M23 — fire-and-forget emitter for the audit-governance-service.
 *
 * Mirrors the pattern from mcp-server/workgraph-api/tool-service/context-fabric.
 * Producers should NEVER await this — emission failures must not block the
 * request handler. Errors land on stderr only. Set AUDIT_GOV_URL="" to
 * disable.
 */
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
  if (!input.trace_id) {
    console.warn(`audit-gov emit ${input.source_service}/${input.kind} missing trace_id — event will not be joinable to a run`);
  }
  void (async () => {
    try {
      const res = await fetch(`${AUDIT_GOV_URL.replace(/\/$/, "")}/api/v1/events`, {
        method: "POST",
        headers: auditHeaders(),
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        // M35.4 — capture raw body for debug, include status + trace_id
        let detail = "";
        try {
          detail = (await res.text()).slice(0, 500);
        } catch (textErr) {
          detail = `<body read failed: ${(textErr as Error).message}>`;
        }
        console.warn(`audit-gov emit ${input.kind} → ${res.status} (trace_id=${input.trace_id ?? "—"}): ${detail}`);
      }
    } catch (err) {
      console.warn(`audit-gov emit ${input.kind} failed (trace_id=${input.trace_id ?? "—"}): ${(err as Error).message}`);
    }
  })();
}
