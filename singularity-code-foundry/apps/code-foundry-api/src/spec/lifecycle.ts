/**
 * M42.1 — Spec lifecycle state machine.
 *
 * Per spec §8.15. Every transition writes a SpecLifecycleEvent row and
 * fires an audit-gov event (best-effort — failure does not block the
 * transition). The legal transitions are:
 *
 *   DRAFT           → VALIDATED        (zod + cross-field checks pass)
 *   VALIDATED       → POLICY_APPROVED  (all policies pass)
 *   POLICY_APPROVED → FROZEN           (spec is committed to a run)
 *   FROZEN          → GENERATED        (at least one CodegenRun exists; M42.3+)
 *   any             → SUPERSEDED       (a newer version replaces this one)
 *
 * Once a spec is FROZEN its canonicalJson/specHash become read-only.
 */
import type { SpecLifecycleState } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { emitAudit } from '../audit/emit.js'

const LEGAL: Record<SpecLifecycleState, SpecLifecycleState[]> = {
  DRAFT:           ['VALIDATED', 'SUPERSEDED'],
  VALIDATED:       ['POLICY_APPROVED', 'DRAFT', 'SUPERSEDED'],
  POLICY_APPROVED: ['FROZEN', 'VALIDATED', 'SUPERSEDED'],
  FROZEN:          ['GENERATED', 'SUPERSEDED'],
  GENERATED:       ['SUPERSEDED'],
  SUPERSEDED:      [],
}

export class IllegalTransitionError extends Error {
  constructor(from: SpecLifecycleState, to: SpecLifecycleState) {
    super(`Illegal spec transition ${from} → ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

export interface TransitionInput {
  specId: string
  toState: SpecLifecycleState
  actorId?: string
  reason?: string
  payload?: Record<string, unknown>
}

export async function transitionSpec(input: TransitionInput): Promise<void> {
  const spec = await prisma.codegenSpec.findUnique({
    where: { id: input.specId },
    select: { id: true, specName: true, version: true, state: true, specHash: true },
  })
  if (!spec) throw new Error(`spec ${input.specId} not found`)
  if (!LEGAL[spec.state].includes(input.toState)) {
    throw new IllegalTransitionError(spec.state, input.toState)
  }
  await prisma.$transaction([
    prisma.codegenSpec.update({
      where: { id: spec.id },
      data: { state: input.toState },
    }),
    prisma.specLifecycleEvent.create({
      data: {
        specId: spec.id,
        fromState: spec.state,
        toState: input.toState,
        actorId: input.actorId,
        reason: input.reason,
        payload: (input.payload ?? undefined) as object | undefined,
      },
    }),
  ])
  // Audit fan-out is best-effort. The DB write is the source of truth.
  await emitAudit({
    event: 'SPEC_TRANSITIONED',
    subjectKind: 'CodegenSpec',
    subjectId: spec.id,
    actorId: input.actorId,
    payload: {
      specName: spec.specName,
      version: spec.version,
      specHash: spec.specHash,
      fromState: spec.state,
      toState: input.toState,
      reason: input.reason ?? null,
    },
  }).catch(() => { /* logged inside emitAudit */ })
}
