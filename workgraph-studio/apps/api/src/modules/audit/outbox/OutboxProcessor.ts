import cron from 'node-cron'
import { prisma } from '../../../lib/prisma'

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
          // Future: publish to Kafka/SNS
          // For now: no-op (internal listeners can subscribe via EventEmitter if needed)
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
