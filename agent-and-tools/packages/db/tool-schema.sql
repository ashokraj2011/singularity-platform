-- Singularity — tool subsystem schema (canonical, standalone, idempotent).
--
-- This is the SAME `tool` schema defined inline in init.sql, extracted into a
-- standalone file with NO psql meta-commands (no \connect / CREATE DATABASE), so
-- it can be applied by ANY seed path against the agent-tools DB:
--   • Docker        → init.sql (entrypoint) keeps its inline copy
--   • bare-metal    → bin/bare-metal.sh runs THIS file (psql -f)
--   • runtime self-heal → agent-service ensureToolSchema() runs the same DDL
--
-- The folded-in tool-service routes (agent-service /api/v1/tools, executions,
-- discovery, runners) + seedCoreToolkit() read `tool.*`. Prisma db push only
-- creates the public.* models, so without this the Tools page is empty.
--
-- Keep in sync with init.sql (AGENT/TOOL SCHEMA section) and
-- apps/agent-service/src/tool/lib/ensure-tool-schema.ts.

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

-- Idempotent ALTERs (apply to existing databases that pre-date M6).
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
