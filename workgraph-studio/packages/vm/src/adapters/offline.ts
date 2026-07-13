// ─────────────────────────────────────────────────────────────────────────────
// Offline adapters — the default adapter set used when the VM runs disconnected
// from central services. Service-bound capabilities report offline() === false
// and throw OfflineError, which the executors translate into a BLOCKED outcome
// so the run parks and can resume/sync later. Deterministic capabilities (clock)
// always work.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Adapters,
  IamAdapter,
  LlmAdapter,
  McpToolAdapter,
  GitAdapter,
  HumanTaskAdapter,
  AuditAdapter,
  Clock,
} from '../types.js'
import { OfflineError } from '../types.js'
import type { StateStore, OutboxEntry } from '../state/StateStore.js'
import { randomUUID } from 'node:crypto'

const offlineIam: IamAdapter = {
  online: () => false,
  authzCheck: async () => {
    throw new OfflineError('iam')
  },
}

const offlineLlm: LlmAdapter = {
  online: () => false,
  complete: async () => {
    throw new OfflineError('llm')
  },
}

const offlineTool: McpToolAdapter = {
  online: () => false,
  invoke: async () => {
    throw new OfflineError('tool')
  },
}

const offlineGit: GitAdapter = {
  online: () => false,
  push: async () => {
    throw new OfflineError('git')
  },
}

const offlineHuman: HumanTaskAdapter = {
  online: () => false,
  requestDecision: async () => {
    throw new OfflineError('human')
  },
}

export const systemClock: Clock = {
  now: () => new Date(),
}

/**
 * Offline audit adapter — never drops events. It queues every event into the
 * StateStore outbox so `wgvm sync` can replay them to audit-gov on reconnect.
 * (Fixes the fire-and-forget "audit events silently lost" pattern for VM runs.)
 */
export function queuingAuditAdapter(store: StateStore, clock: Clock = systemClock): AuditAdapter {
  return {
    online: () => false,
    emit: async event => {
      const entry: OutboxEntry = {
        id: randomUUID(),
        runId: event.runId,
        kind: `audit:${event.kind}`,
        payload: event,
        createdAt: clock.now().toISOString(),
      }
      store.enqueueOutbox(entry)
    },
  }
}

export function offlineAdapters(store: StateStore, clock: Clock = systemClock): Adapters {
  return {
    iam: offlineIam,
    llm: offlineLlm,
    tool: offlineTool,
    git: offlineGit,
    human: offlineHuman,
    audit: queuingAuditAdapter(store, clock),
    clock,
  }
}
