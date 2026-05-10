export interface EventLogDTO {
  id: string
  eventType: string
  entityType: string
  entityId: string
  actorId?: string
  payload?: Record<string, unknown>
  occurredAt: string
}

export interface ReceiptDTO {
  id: string
  receiptType: string
  entityType: string
  entityId: string
  eventLogId?: string
  content: Record<string, unknown>
  generatedAt: string
}
