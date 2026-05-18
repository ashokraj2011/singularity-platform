/**
 * M42.1 — Best-effort audit event emitter.
 *
 * POSTs to audit-governance-service /api/v1/events using the shape from
 * audit-governance-service/src/types.ts (eventSchema). Failure is
 * swallowed and logged — audit-gov outages must not block the local
 * lifecycle write.
 */
import axios from 'axios'
import { config } from '../config.js'
import { log } from '../lib/log.js'
import type { AuditEnvelope } from './types.js'

export async function emitAudit(env: AuditEnvelope): Promise<void> {
  const url = `${config.AUDIT_GOV_URL.replace(/\/$/, '')}/api/v1/events`
  const body = {
    trace_id:       env.traceId,
    source_service: 'code-foundry-api',
    kind:           env.event,
    subject_type:   env.subjectKind,
    subject_id:     env.subjectId,
    actor_id:       env.actorId,
    severity:       'audit' as const,
    payload:        env.payload ?? {},
  }
  try {
    await axios.post(url, body, {
      headers: { 'X-Service-Token': config.AUDIT_GOV_SERVICE_TOKEN },
      timeout: 4_000,
    })
  } catch (err) {
    log.warn(
      { err: (err as Error).message, event: env.event, subjectId: env.subjectId },
      'audit-gov emit failed (non-blocking)',
    )
  }
}
