/**
 * Ensure the raw `agent` schema exists at boot — idempotent self-heal.
 *
 * The agent-domain routes (/api/v1/agents CRUD, versions, learning
 * candidates/profiles/deltas, audit) query raw SQL tables in the `agent`
 * schema:
 *   - agent.agents / agent.agent_versions / agent.agent_audit_events
 *   - agent.agent_learning_profiles / agent.learning_candidates /
 *     agent.learning_profile_deltas
 *
 * Those tables are created by packages/db/init.sql — but ONLY as a Docker
 * postgres entrypoint (fresh-volume). On bare-metal the agent-tools DB is
 * provisioned by Prisma `db push`, which creates the public.* models but NOT
 * these raw `agent.*` tables; and existing Docker volumes that predate them
 * never re-run init.sql. Without this, the first agent CRUD / learning call
 * 500s with `relation "agent.agents" does not exist`.
 *
 * `agent.agent_learning_profiles` stores an `embedding vector(1536)` column
 * with an ivfflat index, so the `vector` (pgvector) extension is required in
 * addition to `pgcrypto` (for gen_random_uuid()) — same two extensions
 * init.sql loads at the top.
 *
 * Same self-heal pattern as ensureEventBusSchema() / ensureToolSchema() /
 * ensureLearningSchema(). Keep this DDL in sync with packages/db/init.sql
 * (AGENT SCHEMA section).
 */
import { pool } from "../../database";

export async function ensureAgentSchema(): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS agent;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS agent.agents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        capability_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_key TEXT NOT NULL UNIQUE,
        agent_uid TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        agent_type TEXT NOT NULL DEFAULT 'llm_agent',
        status TEXT NOT NULL DEFAULT 'draft',
        owner_user_id UUID,
        owner_team_id UUID,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (capability_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agents_capability ON agent.agents(capability_id);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agent.agents(status);
    CREATE INDEX IF NOT EXISTS idx_agents_metadata_gin ON agent.agents USING GIN(metadata);

    CREATE TABLE IF NOT EXISTS agent.agent_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_uid TEXT NOT NULL REFERENCES agent.agents(agent_uid) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        system_prompt TEXT NOT NULL,
        behavior_policy JSONB DEFAULT '{}'::jsonb,
        model_policy JSONB DEFAULT '{}'::jsonb,
        context_policy JSONB DEFAULT '{}'::jsonb,
        tool_policy JSONB DEFAULT '{}'::jsonb,
        approval_policy JSONB DEFAULT '{}'::jsonb,
        change_reason TEXT,
        created_by UUID,
        approved_by UUID,
        approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (agent_uid, version)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_versions_uid ON agent.agent_versions(agent_uid);
    CREATE INDEX IF NOT EXISTS idx_agent_versions_status ON agent.agent_versions(status);
    CREATE INDEX IF NOT EXISTS idx_agent_versions_model_policy_gin ON agent.agent_versions USING GIN(model_policy);
    CREATE INDEX IF NOT EXISTS idx_agent_versions_tool_policy_gin ON agent.agent_versions USING GIN(tool_policy);

    CREATE TABLE IF NOT EXISTS agent.agent_learning_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_uid TEXT NOT NULL REFERENCES agent.agents(agent_uid) ON DELETE CASCADE,
        profile_type TEXT NOT NULL DEFAULT 'durable_learning',
        version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        summary JSONB NOT NULL,
        summary_text TEXT,
        embedding vector(1536),
        source_session_ids JSONB DEFAULT '[]'::jsonb,
        source_memory_item_ids JSONB DEFAULT '[]'::jsonb,
        source_receipt_ids JSONB DEFAULT '[]'::jsonb,
        change_reason TEXT,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (agent_uid, profile_type, version)
    );

    CREATE INDEX IF NOT EXISTS idx_learning_profiles_uid
        ON agent.agent_learning_profiles(agent_uid, profile_type, version DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_profiles_summary_gin
        ON agent.agent_learning_profiles USING GIN(summary);
    CREATE INDEX IF NOT EXISTS idx_learning_profiles_embedding
        ON agent.agent_learning_profiles
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100);

    CREATE TABLE IF NOT EXISTS agent.learning_candidates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_uid TEXT NOT NULL REFERENCES agent.agents(agent_uid) ON DELETE CASCADE,
        capability_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT,
        session_id TEXT,
        workflow_id TEXT,
        task_id TEXT,
        candidate_type TEXT NOT NULL,
        content TEXT NOT NULL,
        content_json JSONB,
        confidence NUMERIC(5,2) DEFAULT 0.80,
        importance NUMERIC(5,2) DEFAULT 0.50,
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_by UUID,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_learning_candidates_agent
        ON agent.learning_candidates(agent_uid, status);
    CREATE INDEX IF NOT EXISTS idx_learning_candidates_session
        ON agent.learning_candidates(session_id);
    CREATE INDEX IF NOT EXISTS idx_learning_candidates_content_json_gin
        ON agent.learning_candidates USING GIN(content_json);

    CREATE TABLE IF NOT EXISTS agent.learning_profile_deltas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_uid TEXT NOT NULL REFERENCES agent.agents(agent_uid) ON DELETE CASCADE,
        profile_type TEXT NOT NULL DEFAULT 'durable_learning',
        from_version INTEGER,
        to_version INTEGER NOT NULL,
        delta JSONB NOT NULL,
        delta_summary TEXT,
        source_candidate_ids JSONB DEFAULT '[]'::jsonb,
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_learning_deltas_agent
        ON agent.learning_profile_deltas(agent_uid, profile_type, to_version DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_deltas_delta_gin
        ON agent.learning_profile_deltas USING GIN(delta);

    CREATE TABLE IF NOT EXISTS agent.agent_audit_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_uid TEXT,
        capability_id TEXT,
        agent_id TEXT,
        actor_user_id UUID,
        event_type TEXT NOT NULL,
        payload JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_agent_audit_agent
        ON agent.agent_audit_events(agent_uid, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_audit_event_type
        ON agent.agent_audit_events(event_type);
  `);
}
