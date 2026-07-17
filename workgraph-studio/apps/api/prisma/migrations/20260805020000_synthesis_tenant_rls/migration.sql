-- Decision and economics records are tenant-owned execution evidence. The API
-- enters a tenant-scoped transaction before accessing them, so production can
-- enforce the same boundary at PostgreSQL rather than relying on query filters.

CREATE OR REPLACE FUNCTION public.workgraph_install_tenant_policy(table_name text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = table_name
      AND policyname = 'tenant_isolation_policy'
  ) THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON public.%I FOR ALL USING ("tenantId" = public.workgraph_current_tenant_id()) WITH CHECK ("tenantId" = public.workgraph_current_tenant_id())',
      table_name
    );
  END IF;
END;
$$;

SELECT public.workgraph_install_tenant_policy('decision_dossiers');
SELECT public.workgraph_install_tenant_policy('decision_options');
SELECT public.workgraph_install_tenant_policy('project_budget_envelopes');
SELECT public.workgraph_install_tenant_policy('project_token_ledger');

ALTER TABLE public.decision_dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decision_dossiers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.decision_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decision_options FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_budget_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_budget_envelopes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_token_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_token_ledger FORCE ROW LEVEL SECURITY;

DROP FUNCTION public.workgraph_install_tenant_policy(text);
