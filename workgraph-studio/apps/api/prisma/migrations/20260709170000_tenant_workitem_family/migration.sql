-- ============================================================================
-- TENANT RLS — WorkItem / trigger family (extends the 16-table cutover).
-- ============================================================================
-- Brings the WorkItem-routing + trigger-config tables under the same tenant RLS
-- regime as the 16 engine tables (20260709150000_force_tenant_rls). These seven
-- tables previously had NO tenantId at all, so they were entirely outside tenant
-- isolation.
--
-- APPROACH — differs from the 16-table path on purpose:
--   * Each table gets its OWN "tenantId" column with a DB-level DEFAULT 'default'.
--     `ADD COLUMN ... DEFAULT 'default'` backfills every existing row to 'default'
--     in one shot AND makes every future INSERT default to 'default' — including
--     bare `prisma.workItem.create()` calls that never pass tenantId. That is what
--     lets FORCE RLS's WITH CHECK pass without threading tenantId through every
--     create site (the 16-table path needed per-call write-wiring because those
--     columns had no DB default). The literal 'default' MUST match config
--     WORKGRAPH_DEFAULT_TENANT_ID and the app role's `SET app.tenant_id` default
--     (20260709145000 / bootstrap-app-role.sh) — collapse to one tenant is correct
--     for single-tenant; for multi-tenant, assign real tenants before deploying.
--   * Policy is the direct-tenant predicate ("tenantId" = current tenant), same as
--     workflow_instances — every one of these tables owns its tenantId.
--
-- FAIL-CLOSED. The preflight RAISEs (aborting the whole migration transaction) if
-- the applying role cannot bypass RLS — otherwise the WorkItemTrigger scheduler /
-- routing sweeps (which connect as this role) would silently stop seeing rows.
-- Guards C/D from the 16-table cutover are unnecessary here: ADD COLUMN DEFAULT +
-- the belt-and-suspenders UPDATEs below guarantee no NULL tenantId remains, and
-- the policies are installed in THIS migration immediately before FORCE.
--
-- No BEGIN/COMMIT — Prisma wraps each migration in its own transaction.
-- ============================================================================

DO $preflight$
DECLARE
  v_can_bypass boolean;
BEGIN
  -- Same guard as the 16-table cutover (B4): adminPrisma / trigger + routing
  -- sweeps connect as this role; under FORCE they must bypass RLS or go blind.
  SELECT rolsuper OR rolbypassrls INTO v_can_bypass FROM pg_roles WHERE rolname = current_user;
  IF NOT COALESCE(v_can_bypass, false) THEN
    RAISE EXCEPTION 'WorkItem-family RLS aborted [Guard B / B4]: role "%" is neither SUPERUSER nor BYPASSRLS. Under FORCE RLS, WorkItemTrigger/routing sweeps (same role) would silently stop. Fix: ALTER ROLE "%" BYPASSRLS; then re-deploy.', current_user, current_user;
  END IF;
  RAISE NOTICE 'WorkItem-family RLS preflight passed. Applying tenantId + policies + FORCE on 7 tables.';
END
$preflight$;

-- 1) tenantId column with DB default 'default' (backfills existing rows + defaults
--    every future insert). IF NOT EXISTS so re-runs are no-ops.
ALTER TABLE "work_items"                  ADD COLUMN IF NOT EXISTS "tenantId" TEXT DEFAULT 'default';
ALTER TABLE "work_item_targets"           ADD COLUMN IF NOT EXISTS "tenantId" TEXT DEFAULT 'default';
ALTER TABLE "work_item_events"            ADD COLUMN IF NOT EXISTS "tenantId" TEXT DEFAULT 'default';
ALTER TABLE "work_item_clarifications"    ADD COLUMN IF NOT EXISTS "tenantId" TEXT DEFAULT 'default';
ALTER TABLE "work_item_routing_policies"  ADD COLUMN IF NOT EXISTS "tenantId" TEXT DEFAULT 'default';
ALTER TABLE "work_item_triggers"          ADD COLUMN IF NOT EXISTS "tenantId" TEXT DEFAULT 'default';
ALTER TABLE "workflow_triggers"           ADD COLUMN IF NOT EXISTS "tenantId" TEXT DEFAULT 'default';

-- 2) Belt-and-suspenders: if the column pre-existed (partial prior run) as NULLable
--    without a default, ADD COLUMN IF NOT EXISTS skips it and old NULLs survive.
--    Force them to 'default' so FORCE's WITH CHECK / USING can never freeze a row.
UPDATE "work_items"                 SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "work_item_targets"          SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "work_item_events"           SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "work_item_clarifications"   SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "work_item_routing_policies" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "work_item_triggers"         SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "workflow_triggers"          SET "tenantId" = 'default' WHERE "tenantId" IS NULL;

-- 3) Indexes (names match the schema.prisma @@index maps so db push / migrate agree).
CREATE INDEX IF NOT EXISTS "ix_work_items_tenant"                 ON "work_items"("tenantId");
CREATE INDEX IF NOT EXISTS "ix_work_item_targets_tenant"          ON "work_item_targets"("tenantId");
CREATE INDEX IF NOT EXISTS "ix_work_item_events_tenant"           ON "work_item_events"("tenantId");
CREATE INDEX IF NOT EXISTS "ix_work_item_clarifications_tenant"   ON "work_item_clarifications"("tenantId");
CREATE INDEX IF NOT EXISTS "ix_work_item_routing_policies_tenant" ON "work_item_routing_policies"("tenantId");
CREATE INDEX IF NOT EXISTS "ix_work_item_triggers_tenant"         ON "work_item_triggers"("tenantId");
CREATE INDEX IF NOT EXISTS "ix_workflow_triggers_tenant"          ON "workflow_triggers"("tenantId");

-- 4) Install the direct-tenant policy on each table. workgraph_current_tenant_id()
--    persists from the 20260619123000 scaffold; the install helper was dropped
--    there, so re-create it (idempotent), use it, drop it — self-contained.
CREATE OR REPLACE FUNCTION public.workgraph_install_tenant_policy(table_name text, predicate text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = table_name AND policyname = 'tenant_isolation_policy'
  ) THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON public.%I FOR ALL USING (%s) WITH CHECK (%s)',
      table_name, predicate, predicate
    );
  END IF;
END;
$$;

SELECT public.workgraph_install_tenant_policy('work_items',                 '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('work_item_targets',          '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('work_item_events',           '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('work_item_clarifications',   '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('work_item_routing_policies', '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('work_item_triggers',         '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('workflow_triggers',          '"tenantId" = public.workgraph_current_tenant_id()');

DROP FUNCTION public.workgraph_install_tenant_policy(text, text);

-- 5) ENABLE + FORCE ROW LEVEL SECURITY.
ALTER TABLE "work_items"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_targets"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_events"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_clarifications"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_routing_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_triggers"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_triggers"          ENABLE ROW LEVEL SECURITY;

ALTER TABLE "work_items"                 FORCE ROW LEVEL SECURITY;
ALTER TABLE "work_item_targets"          FORCE ROW LEVEL SECURITY;
ALTER TABLE "work_item_events"           FORCE ROW LEVEL SECURITY;
ALTER TABLE "work_item_clarifications"   FORCE ROW LEVEL SECURITY;
ALTER TABLE "work_item_routing_policies" FORCE ROW LEVEL SECURITY;
ALTER TABLE "work_item_triggers"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "workflow_triggers"          FORCE ROW LEVEL SECURITY;
