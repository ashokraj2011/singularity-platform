-- Extend tenant isolation to authorization evidence.
--
-- Workflow templates and their design graph still have legacy runtime/design
-- paths that issue direct Prisma calls. Their tenantId + centralized access
-- checks are enforced at the API boundary in this release. Do not FORCE RLS
-- on those tables until every legacy read/write has been moved behind
-- withTenantDbTransaction; doing so now would make the designer fail closed
-- with unset app.tenant_id on otherwise valid requests.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'workflow_authorization_snapshots' AND policyname = 'tenant_isolation_policy') THEN
    CREATE POLICY tenant_isolation_policy ON public.workflow_authorization_snapshots
      FOR ALL USING ("tenantId" = public.workgraph_current_tenant_id())
      WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
  END IF;
END $$;

ALTER TABLE public.workflow_authorization_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_authorization_snapshots FORCE ROW LEVEL SECURITY;
