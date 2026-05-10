-- Singularity Neo — Agent & Tool schema init
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ==================== AGENT SCHEMA ====================
CREATE SCHEMA IF NOT EXISTS agent;

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

-- ==================== TOOL SCHEMA ====================
CREATE SCHEMA IF NOT EXISTS tool;

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
    -- M6: routing hint for the future MCP bridge.
    --   LOCAL  → executed by the customer-deployed MCP server (default; most tools)
    --   SERVER → executed by tool-service in our cloud (governed first-party tools)
    execution_target TEXT NOT NULL DEFAULT 'LOCAL',
    -- Optional pointer to iam.mcp_servers.id when execution_target=LOCAL. Cross-schema,
    -- so kept as plain UUID without an FK; resolved by context-fabric at run time.
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

CREATE TABLE IF NOT EXISTS tool.client_execution_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_execution_id UUID REFERENCES tool.tool_executions(id),
    assigned_runner_id TEXT REFERENCES tool.client_runners(id),
    status TEXT NOT NULL DEFAULT 'pending',
    job_payload JSONB NOT NULL,
    result_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_client_jobs_runner
    ON tool.client_execution_jobs(assigned_runner_id, status);
CREATE INDEX IF NOT EXISTS idx_client_jobs_status ON tool.client_execution_jobs(status);
CREATE INDEX IF NOT EXISTS idx_client_jobs_payload_gin ON tool.client_execution_jobs USING GIN(job_payload);

CREATE TABLE IF NOT EXISTS tool.tool_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_name TEXT,
    tool_version TEXT,
    capability_id TEXT,
    agent_uid TEXT,
    session_id TEXT,
    actor_user_id UUID,
    event_type TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_audit_tool
    ON tool.tool_audit_events(tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_audit_capability
    ON tool.tool_audit_events(capability_id, created_at DESC);
