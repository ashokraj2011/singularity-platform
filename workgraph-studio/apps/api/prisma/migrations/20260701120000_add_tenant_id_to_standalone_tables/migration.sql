-- RLS Phase 2, slice 5a — tenant column for the standalone-capable tables.
--
-- Six of the 16 RLS-scoped tables can hold STANDALONE rows (instanceId IS NULL)
-- created outside any workflow instance — direct tasks, standalone agent runs
-- (agents.router / laptop), direct tool runs, etc. The scaffolded policy
-- (workgraph_instance_visible("instanceId")) cannot represent such a row: with a
-- NULL instanceId the predicate is never true, so under FORCE ROW LEVEL SECURITY
-- the row is invisible to every reader and un-insertable. This migration adds a
-- direct `tenantId` column to those six tables and revises their policy to
-- `tenantId = current_tenant OR instance-visible`, so both standalone and
-- instance-linked rows are representable.
--
-- SAFE TO AUTO-APPLY: the columns are NULLABLE + additive (no rewrite), the
-- backfill only touches rows where tenantId IS NULL, and the policy change is
-- INERT until FORCE ROW LEVEL SECURITY is enabled (the separate,
-- human-supervised cutover in prisma/rls-cutover-manual-apply-only.sql). This
-- migration does NOT enable or force RLS.

-- 1. Add the columns (idempotent).
ALTER TABLE public.tasks             ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE public.approval_requests ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE public.consumables       ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE public.agent_runs        ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE public.tool_runs         ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE public.documents         ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- 2. Backfill instance-linked rows from their parent workflow instance's tenant.
--    (Standalone rows stay NULL here — the write-path change in slice 5b sets
--    tenantId on new standalone rows; any pre-existing standalone rows must be
--    handled at cutover per the readiness audit.)
UPDATE public.tasks             t  SET "tenantId" = wi."tenantId" FROM public.workflow_instances wi WHERE t."instanceId"  = wi.id AND t."tenantId"  IS NULL;
UPDATE public.approval_requests a  SET "tenantId" = wi."tenantId" FROM public.workflow_instances wi WHERE a."instanceId"  = wi.id AND a."tenantId"  IS NULL;
UPDATE public.consumables       c  SET "tenantId" = wi."tenantId" FROM public.workflow_instances wi WHERE c."instanceId"  = wi.id AND c."tenantId"  IS NULL;
UPDATE public.agent_runs        r  SET "tenantId" = wi."tenantId" FROM public.workflow_instances wi WHERE r."instanceId"  = wi.id AND r."tenantId"  IS NULL;
UPDATE public.tool_runs         tr SET "tenantId" = wi."tenantId" FROM public.workflow_instances wi WHERE tr."instanceId" = wi.id AND tr."tenantId" IS NULL;
UPDATE public.documents         d  SET "tenantId" = wi."tenantId" FROM public.workflow_instances wi WHERE d."instanceId"  = wi.id AND d."tenantId"  IS NULL;

-- (Indexing "tenantId" for RLS-filter performance is a recommended follow-up;
-- kept out of this migration so the index is declared in schema.prisma too and
-- doesn't drift under bare-metal's `prisma db push`.)

-- 3. Revise the tenant policy for these six tables: visible when the direct
--    tenant matches (standalone rows) OR the parent instance is visible
--    (instance-linked rows — unchanged). Replaces the scaffold's instance-only
--    predicate. INERT until FORCE ROW LEVEL SECURITY is enabled.
--    workgraph_current_tenant_id() / workgraph_instance_visible() are defined by
--    the 20260619123000_tenant_rls_policy_scaffold migration.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['tasks','approval_requests','consumables','agent_runs','tool_runs','documents'];
  predicate text := '("tenantId" = public.workgraph_current_tenant_id() OR public.workgraph_instance_visible("instanceId"))';
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON public.%I FOR ALL USING (%s) WITH CHECK (%s)',
      t, predicate, predicate
    );
  END LOOP;
END $$;
