-- M101: Studio board tenant policies.
--
-- The original tenant policy scaffold predates the event-sourced Studio board
-- tables, so those tables cannot be referenced from that earlier migration on
-- a fresh database. This migration runs after M97-M100 and installs the same
-- direct-tenant policy before the production cutover script enables FORCE RLS.

CREATE OR REPLACE FUNCTION public.workgraph_install_tenant_policy(table_name text, predicate text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = table_name
      AND policyname = 'tenant_isolation_policy'
  ) THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON public.%I FOR ALL USING (%s) WITH CHECK (%s)',
      table_name,
      predicate,
      predicate
    );
  END IF;
END;
$$;

SELECT public.workgraph_install_tenant_policy('boards', '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('board_branches', '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('board_events', '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('board_snapshots', '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('board_moments', '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('ingested_artifacts', '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('agent_verdicts', '"tenantId" = public.workgraph_current_tenant_id()');

DROP FUNCTION public.workgraph_install_tenant_policy(text, text);
