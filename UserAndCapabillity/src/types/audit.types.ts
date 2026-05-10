export interface AuditEvent {
  id: string
  actor_user_id?: string
  event_type: string
  capability_id?: string
  target_type?: string
  target_id?: string
  payload: Record<string, unknown>
  ip_address?: string
  user_agent?: string
  created_at: string
}
