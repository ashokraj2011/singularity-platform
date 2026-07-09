-- P2 — hot-path + tenant indexes.
-- workflow_nodes/edges/events had ZERO indexes: every advance() queries nodes by
-- instanceId, every SIGNAL_EMIT/TimerSweep scans nodes by (nodeType,status), and
-- activateDownstream loads edges by sourceNodeId — all full seq scans. Plus the 6
-- standalone tenantId columns (added in 20260701120000) were never indexed, which
-- the RLS-filter reads need. Index names match the schema.prisma @@index(map:)
-- values so the bare-metal `db push` path and this `migrate deploy` path converge.
-- IF NOT EXISTS keeps it safe if db push already created them.

-- Runtime graph tables (the zero-index offenders)
CREATE INDEX IF NOT EXISTS "ix_workflow_nodes_instance_status" ON "workflow_nodes"("instanceId", "status");
CREATE INDEX IF NOT EXISTS "ix_workflow_nodes_type_status"     ON "workflow_nodes"("nodeType", "status");
CREATE INDEX IF NOT EXISTS "ix_workflow_edges_source"          ON "workflow_edges"("sourceNodeId");
CREATE INDEX IF NOT EXISTS "ix_workflow_edges_instance"        ON "workflow_edges"("instanceId");
CREATE INDEX IF NOT EXISTS "ix_workflow_events_instance_time"  ON "workflow_events"("instanceId", "occurredAt");
CREATE INDEX IF NOT EXISTS "ix_workflow_instances_status"      ON "workflow_instances"("status");
CREATE INDEX IF NOT EXISTS "ix_workflow_mutations_instance"    ON "workflow_mutations"("instanceId");
CREATE INDEX IF NOT EXISTS "ix_workflow_phases_instance"       ON "workflow_phases"("instanceId");

-- tasks (zero-index; SLA sweep scans it every 5s by status/dueAt)
CREATE INDEX IF NOT EXISTS "ix_tasks_tenant"                   ON "tasks"("tenantId");
CREATE INDEX IF NOT EXISTS "ix_tasks_instance"                 ON "tasks"("instanceId");
CREATE INDEX IF NOT EXISTS "ix_tasks_status_due"              ON "tasks"("status", "dueAt");

-- standalone tenantId columns (RLS-filter performance follow-up from 20260701120000)
CREATE INDEX IF NOT EXISTS "ix_approval_requests_tenant"       ON "approval_requests"("tenantId");
CREATE INDEX IF NOT EXISTS "ix_consumables_tenant"            ON "consumables"("tenantId");
CREATE INDEX IF NOT EXISTS "ix_agent_runs_tenant"            ON "agent_runs"("tenantId");
CREATE INDEX IF NOT EXISTS "ix_tool_runs_tenant"             ON "tool_runs"("tenantId");
CREATE INDEX IF NOT EXISTS "ix_documents_tenant"             ON "documents"("tenantId");
