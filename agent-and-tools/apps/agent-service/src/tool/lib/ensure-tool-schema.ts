/**
 * Ensure the `tool` schema exists at boot — idempotent self-heal.
 *
 * The folded-in tool-service routes (/api/v1/tools, executions, discovery,
 * runners) and seedCoreToolkit() read the raw `tool.*` schema. That schema is
 * created by packages/db/init.sql — but ONLY as a Docker postgres entrypoint
 * (fresh-volume). On bare-metal the agent-tools DB is provisioned by Prisma
 * `db push`, which creates the public.* models (ToolDefinition, …) but NOT the
 * raw `tool` schema. Without this, seedCoreToolkit inserts into a missing table
 * and the Tools page (GET /api/v1/tools) is empty.
 *
 * Same self-heal pattern as ensureLearningSchema() in routes/learning-patterns.ts.
 * Keep this DDL in sync with packages/db/tool-schema.sql and init.sql
 * (AGENT/TOOL SCHEMA section).
 */
import { query } from "../database";

export async function ensureToolSchema(): Promise<void> {
  await query(`
    CREATE SCHEMA IF NOT EXISTS tool;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS tool.tools (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tool_name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1.0.0',
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        risk_level TEXT NOT NULL DEFAULT 'low',
        requires_approval BOOLEAN NOT NULL DEFAULT false,
        input_schema JSONB NOT NULL,
        output_schema JSONB,
        runtime JSONB NOT NULL,
        capabilities_required JSONB DEFAULT '{}'::jsonb,
        allowed_capabilities JSONB DEFAULT '[]'::jsonb,
        allowed_agents JSONB DEFAULT '[]'::jsonb,
        tags JSONB DEFAULT '[]'::jsonb,
        metadata JSONB DEFAULT '{}'::jsonb,
        execution_target TEXT NOT NULL DEFAULT 'LOCAL',
        mcp_server_ref UUID,
        created_by UUID,
        approved_by UUID,
        approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tool_name, version)
    );

    CREATE INDEX IF NOT EXISTS idx_tools_name ON tool.tools(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tools_status ON tool.tools(status);
    CREATE INDEX IF NOT EXISTS idx_tools_risk ON tool.tools(risk_level);
    CREATE INDEX IF NOT EXISTS idx_tools_execution_target ON tool.tools(execution_target);
    CREATE INDEX IF NOT EXISTS idx_tools_tags_gin ON tool.tools USING GIN(tags);
    CREATE INDEX IF NOT EXISTS idx_tools_allowed_capabilities_gin ON tool.tools USING GIN(allowed_capabilities);
    CREATE INDEX IF NOT EXISTS idx_tools_allowed_agents_gin ON tool.tools USING GIN(allowed_agents);

    ALTER TABLE tool.tools ADD COLUMN IF NOT EXISTS execution_target TEXT NOT NULL DEFAULT 'LOCAL';
    ALTER TABLE tool.tools ADD COLUMN IF NOT EXISTS mcp_server_ref UUID;

    CREATE TABLE IF NOT EXISTS tool.tool_executions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tool_name TEXT NOT NULL,
        tool_version TEXT,
        capability_id TEXT NOT NULL,
        agent_uid TEXT,
        agent_id TEXT,
        session_id TEXT,
        workflow_id TEXT,
        task_id TEXT,
        execution_location TEXT,
        runtime_type TEXT,
        status TEXT NOT NULL,
        arguments_json JSONB NOT NULL,
        output_json JSONB,
        output_summary TEXT,
        risk_level TEXT,
        requires_approval BOOLEAN,
        approved_by UUID,
        context_package_id UUID,
        model_call_id UUID,
        client_execution_id UUID,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS idx_tool_executions_capability
        ON tool.tool_executions(capability_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_agent
        ON tool.tool_executions(agent_uid, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_tool
        ON tool.tool_executions(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_args_gin
        ON tool.tool_executions USING GIN(arguments_json);

    CREATE TABLE IF NOT EXISTS tool.client_runners (
        id TEXT PRIMARY KEY,
        user_id UUID,
        runner_name TEXT,
        runner_type TEXT,
        runner_version TEXT,
        capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_client_runners_user ON tool.client_runners(user_id);
    CREATE INDEX IF NOT EXISTS idx_client_runners_status ON tool.client_runners(status);
    CREATE INDEX IF NOT EXISTS idx_client_runners_capabilities_gin ON tool.client_runners USING GIN(capabilities);
  `);
}
