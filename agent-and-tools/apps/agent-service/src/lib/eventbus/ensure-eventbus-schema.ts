/**
 * Ensure the raw event-bus schema exists at boot — idempotent self-heal.
 *
 * Both dispatchers in this service query raw SQL tables:
 *   - startEventDispatcher()     → agent.event_outbox / agent.event_subscriptions / agent.event_deliveries
 *   - startToolEventDispatcher() → tool.event_outbox  / tool.event_subscriptions  / tool.event_deliveries
 *
 * Those tables are created by packages/db/init.sql — but ONLY as a Docker
 * postgres entrypoint (fresh-volume). On bare-metal the agent-tools DB is
 * provisioned by Prisma `db push`, which creates the public.* models but NOT
 * these raw `agent.*` / `tool.*` tables; and existing Docker volumes that
 * predate them never re-run init.sql. Without this, every 30s safety sweep logs
 * `relation "agent.event_outbox" does not exist` and no domain events are ever
 * dispatched.
 *
 * Same self-heal pattern as ensureToolSchema() / ensureLearningSchema().
 * Keep this DDL in sync with packages/db/init.sql (M11.e Event Bus sections).
 */
import { pool } from "../../database";

export async function ensureEventBusSchema(): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS agent;
    CREATE SCHEMA IF NOT EXISTS tool;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    -- ─── Event Bus (agent-service, namespaced under the agent schema) ─────────
    CREATE TABLE IF NOT EXISTS agent.event_outbox (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_name      TEXT NOT NULL,
        source_service  TEXT NOT NULL,
        trace_id        TEXT,
        subject_kind    TEXT NOT NULL,
        subject_id      TEXT NOT NULL,
        envelope        JSONB NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        emitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_attempt_at TIMESTAMPTZ,
        last_error      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_event_outbox_as_status_emitted
        ON agent.event_outbox(status, emitted_at);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_as_event_name
        ON agent.event_outbox(event_name);

    CREATE TABLE IF NOT EXISTS agent.event_subscriptions (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscriber_id  TEXT NOT NULL,
        event_pattern  TEXT NOT NULL,
        target_url     TEXT NOT NULL,
        secret         TEXT,
        is_active      BOOLEAN NOT NULL DEFAULT true,
        metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_event_subscriptions_as_active
        ON agent.event_subscriptions(is_active, event_pattern);

    CREATE TABLE IF NOT EXISTS agent.event_deliveries (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        outbox_id       UUID NOT NULL REFERENCES agent.event_outbox(id) ON DELETE CASCADE,
        subscription_id UUID NOT NULL REFERENCES agent.event_subscriptions(id) ON DELETE CASCADE,
        status          TEXT NOT NULL DEFAULT 'queued',
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMPTZ,
        last_error      TEXT,
        delivered_at    TIMESTAMPTZ,
        response_status INTEGER,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (outbox_id, subscription_id)
    );
    CREATE INDEX IF NOT EXISTS idx_event_deliveries_as_status
        ON agent.event_deliveries(status, created_at);

    -- ─── Event Bus (folded-in tool-service, tool schema) ─────────────────────
    CREATE TABLE IF NOT EXISTS tool.event_outbox (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_name      TEXT NOT NULL,
        source_service  TEXT NOT NULL,
        trace_id        TEXT,
        subject_kind    TEXT NOT NULL,
        subject_id      TEXT NOT NULL,
        envelope        JSONB NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        emitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_attempt_at TIMESTAMPTZ,
        last_error      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_event_outbox_status_emitted
        ON tool.event_outbox(status, emitted_at);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_event_name
        ON tool.event_outbox(event_name);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_trace
        ON tool.event_outbox(trace_id);

    CREATE TABLE IF NOT EXISTS tool.event_subscriptions (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscriber_id  TEXT NOT NULL,
        event_pattern  TEXT NOT NULL,
        target_url     TEXT NOT NULL,
        secret         TEXT,
        is_active      BOOLEAN NOT NULL DEFAULT true,
        metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_event_subscriptions_active
        ON tool.event_subscriptions(is_active, event_pattern);

    CREATE TABLE IF NOT EXISTS tool.event_deliveries (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        outbox_id       UUID NOT NULL REFERENCES tool.event_outbox(id) ON DELETE CASCADE,
        subscription_id UUID NOT NULL REFERENCES tool.event_subscriptions(id) ON DELETE CASCADE,
        status          TEXT NOT NULL DEFAULT 'queued',
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMPTZ,
        last_error      TEXT,
        delivered_at    TIMESTAMPTZ,
        response_status INTEGER,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (outbox_id, subscription_id)
    );
    CREATE INDEX IF NOT EXISTS idx_event_deliveries_status
        ON tool.event_deliveries(status, created_at);
  `);
}
