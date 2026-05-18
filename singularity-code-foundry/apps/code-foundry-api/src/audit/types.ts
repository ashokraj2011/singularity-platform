/**
 * M42.1 — Audit event envelope sent to audit-governance-service.
 * Matches the canonical event-bus envelope used elsewhere in the
 * platform (same `subject`, `actor`, `payload` shape).
 */
export interface AuditEnvelope {
  event: string
  subjectKind: string
  subjectId: string
  actorId?: string
  payload?: Record<string, unknown>
  traceId?: string
}
