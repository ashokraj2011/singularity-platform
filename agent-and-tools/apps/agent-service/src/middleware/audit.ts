import { query } from "../database";

export async function emitAuditEvent(
  event_type: string,
  payload: {
    agent_uid?: string;
    capability_id?: string;
    agent_id?: string;
    actor_user_id?: string;
    data?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await query(
      `INSERT INTO agent.agent_audit_events (agent_uid, capability_id, agent_id, actor_user_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        payload.agent_uid ?? null,
        payload.capability_id ?? null,
        payload.agent_id ?? null,
        payload.actor_user_id ?? null,
        event_type,
        JSON.stringify(payload.data ?? {}),
      ]
    );
  } catch (err) {
    console.error("[audit] failed to emit event", event_type, err);
  }
}
