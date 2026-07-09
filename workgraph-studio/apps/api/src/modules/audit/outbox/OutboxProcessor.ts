import cron from 'node-cron'
import { prisma } from '../../../lib/prisma'

/**
 * Legacy `outbox_events` drain. Historically this was the PENDING→PROCESSED gate
 * the internal trigger sweep depended on (it read only PROCESSED rows). As of the
 * P2 consolidation the sweep reads PENDING∪PROCESSED, so this processor is no
 * longer load-bearing — it advances rows out of PENDING for observability/back-compat.
 *
 * The two event buses are deliberately still separate on the consumer side; a
 * physical merge is deferred pending staging validation (in-flight rows +
 * dedup-key compatibility + not spamming external subscribers with internal events):
 *   - outbox_events (this table, via publishOutbox) → INTERNAL trigger firing
 *     (TriggerScheduler: WorkflowTrigger + WorkItemTrigger EVENT sweeps)
 *   - event_outbox  (via publishEvent → dispatcher) → EXTERNAL webhook delivery
 *     (event_subscriptions). publishOutbox dual-writes it, so subscribers also
 *     receive internal events — the producer side is already consolidated.
 */
export function startOutboxProcessor(): void {
  cron.schedule('*/5 * * * * *', async () => {
    try {
      const events = await prisma.outboxEvent.findMany({
        where: { status: 'PENDING' },
        take: 50,
        orderBy: { createdAt: 'asc' },
      })

      for (const event of events) {
        try {
          // Mark the legacy outbox row PROCESSED. This is a back-compat status
          // transition for observability — NOT delivery. External fan-out is the
          // M11.e dispatcher on event_outbox (publishOutbox dual-writes it), and
          // the internal trigger sweep (TriggerScheduler.loadMatchingOutboxEvents)
          // now reads PENDING∪PROCESSED, so it no longer depends on this flip.
          // Safe to retire once nothing distinguishes PENDING from PROCESSED here.
          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: { status: 'PROCESSED', processedAt: new Date() },
          })
        } catch (err) {
          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: { status: 'FAILED', errorMessage: String(err) },
          })
        }
      }
    } catch (err) {
      console.error('Outbox processor error:', err)
    }
  })
  console.log('Outbox processor started')
}
