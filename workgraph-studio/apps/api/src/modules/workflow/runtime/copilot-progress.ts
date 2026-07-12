/**
 * Live run mirror — progress event shaping for an off-platform Copilot run.
 *
 * An exported Copilot run (the `CopilotWorkflowRun` YAML / runner.sh) runs each
 * phase on the operator's own machine. As it works it POSTs lightweight,
 * content-free progress ticks (phase started / completed, run started /
 * completed) to `POST /workflow-instances/:id/copilot-progress`. Each tick is
 * persisted as a `WorkflowEvent` row (eventType `CopilotRunProgress`) and
 * relayed to the run viewer over SSE (`.../copilot-progress/events/stream`), so
 * the workbench mirrors a laptop run in real time — the same DAG that #442's
 * signals already advance now lights up phase-by-phase as the work happens.
 *
 * This module is PURE (no DB, no network): schema + payload/row shaping only, so
 * it is trivially unit-testable. The router does the I/O.
 */
import { z } from 'zod'

/** WorkflowEvent.eventType used for every live-mirror progress tick. */
export const COPILOT_PROGRESS_EVENT_TYPE = 'CopilotRunProgress'

/**
 * A single progress tick as POSTed by the runner. Deliberately small — phase
 * coordinates + status, never file contents (results/artifacts go through the
 * separate governed `copilot-results` endpoint).
 */
export const copilotProgressEventSchema = z.object({
  /** e.g. run.started | phase.started | phase.completed | run.completed. */
  event: z.string().min(1).max(80),
  /** stage key (matches an exported `stages[].key`). */
  phase: z.string().max(160).optional(),
  /** the workflow node this phase maps to — lets the FE pulse the DAG node. */
  nodeId: z.string().uuid().optional(),
  /** completed | failed | running | … (free-form; drives row severity). */
  status: z.string().max(80).optional(),
  message: z.string().max(2000).optional(),
  /** client-monotonic sequence, for stable ordering within a wall-clock tick. */
  seq: z.number().int().nonnegative().optional(),
  /** client ISO timestamp of when the tick occurred on the laptop. */
  at: z.string().max(80).optional(),
  /** small free-form extras: durationMs, exitCode, changedFileCount, … */
  data: z.record(z.unknown()).optional(),
})
export type CopilotProgressEventInput = z.infer<typeof copilotProgressEventSchema>

/** The object persisted in `WorkflowEvent.payload`. */
export interface CopilotProgressPayload {
  event: string
  phase?: string
  nodeId?: string
  status?: string
  message?: string
  seq?: number
  at?: string
  data?: Record<string, unknown>
}

/**
 * Normalize a validated input into the stored payload. `nodeId` is kept only
 * when it names a real node of this run (so a stale/garbage id can't mislead the
 * DAG highlight); everything else is copied through when present.
 */
export function normalizeProgressEvent(
  input: CopilotProgressEventInput,
  validNodeIds: Set<string>,
): CopilotProgressPayload {
  const nodeId = input.nodeId && validNodeIds.has(input.nodeId) ? input.nodeId : undefined
  return {
    event: input.event,
    ...(input.phase ? { phase: input.phase } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(typeof input.seq === 'number' ? { seq: input.seq } : {}),
    ...(input.at ? { at: input.at } : {}),
    ...(input.data ? { data: input.data } : {}),
  }
}

/**
 * The row shape the run viewer consumes — identical envelope to
 * `/copilot-activity` and `/events/stream` (`{ id, kind, timestamp, severity,
 * payload }`) so the existing `CopilotActivityPanel` renders it with no new
 * mapping. `kind` is prefixed `copilot.progress.` so the panel can tint it.
 */
export interface CopilotProgressRow {
  id: string
  kind: string
  timestamp: string
  severity: 'info' | 'error'
  payload: CopilotProgressPayload
}

export function toProgressRow(
  id: string,
  occurredAt: Date | string,
  payload: CopilotProgressPayload,
): CopilotProgressRow {
  const status = (payload.status ?? '').toLowerCase()
  const severity: 'info' | 'error' = status === 'failed' || status === 'error' ? 'error' : 'info'
  return {
    id,
    kind: `copilot.progress.${payload.event}`,
    timestamp: typeof occurredAt === 'string' ? occurredAt : occurredAt.toISOString(),
    severity,
    payload,
  }
}
