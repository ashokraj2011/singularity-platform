-- Add a first-class tenant spine to browser-runtime snapshots.
--
-- RunSnapshot rows are browser-driven run evidence. Strict tenant isolation
-- must not treat them as tenant-neutral, so new writes require tenantId and
-- RLS can later enforce the same SET LOCAL app.tenant_id predicate as
-- workflow_instances.

ALTER TABLE "run_snapshots"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "run_snapshots_tenantId_idx"
  ON "run_snapshots"("tenantId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'run_snapshots'
      AND policyname = 'tenant_isolation_policy'
  ) THEN
    CREATE POLICY tenant_isolation_policy
      ON public.run_snapshots
      FOR ALL
      USING ("tenantId" = public.workgraph_current_tenant_id())
      WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
  END IF;
END;
$$;
