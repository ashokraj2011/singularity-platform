-- Backfill NULL tenantId -> the default tenant, so the FORCE RLS cutover
-- (20260709150000_force_tenant_rls) Guards C/D pass and no pre-existing row is
-- frozen/invisible under forced RLS. Timestamped BEFORE the force migration so
-- Prisma applies it first.
--
-- The literal 'default' MUST match config WORKGRAPH_DEFAULT_TENANT_ID (default
-- 'default') and the app role's `SET app.tenant_id` default. If you override that
-- env to a real tenant id, re-run these UPDATEs with your value BEFORE the force
-- migration applies. This collapses all pre-existing untenanted rows to one
-- tenant (correct for a single-tenant deployment; for multi-tenant, assign real
-- tenants first instead of running this).
--
-- Only tables with their OWN tenantId column are backfilled; the instance-linked
-- RLS tables (workflow_phases/nodes/edges/mutations/events, workflow_run_budgets
-- + events, pending_executions) become visible via their (now-tenanted) instance
-- through workgraph_instance_visible(), so they need no direct backfill.

UPDATE "workflow_instances" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "run_snapshots"      SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "tasks"              SET "tenantId" = 'default' WHERE "tenantId" IS NULL AND "instanceId" IS NULL;
UPDATE "approval_requests"  SET "tenantId" = 'default' WHERE "tenantId" IS NULL AND "instanceId" IS NULL;
UPDATE "consumables"        SET "tenantId" = 'default' WHERE "tenantId" IS NULL AND "instanceId" IS NULL;
UPDATE "agent_runs"         SET "tenantId" = 'default' WHERE "tenantId" IS NULL AND "instanceId" IS NULL;
UPDATE "tool_runs"          SET "tenantId" = 'default' WHERE "tenantId" IS NULL AND "instanceId" IS NULL;
UPDATE "documents"          SET "tenantId" = 'default' WHERE "tenantId" IS NULL AND "instanceId" IS NULL;
