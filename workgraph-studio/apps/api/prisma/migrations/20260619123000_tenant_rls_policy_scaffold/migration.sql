-- Tenant RLS policy scaffold for Workgraph runtime tables.
--
-- This migration intentionally creates helper functions and policies without
-- enabling row-level security. Enabling/FORCE RLS is a deployment cutover that
-- must happen only after request-scoped DB transactions set app.tenant_id with
-- SET LOCAL for all tenant-sensitive query paths.

CREATE OR REPLACE FUNCTION public.workgraph_current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')
$$;

CREATE OR REPLACE FUNCTION public.workgraph_instance_visible(instance_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workflow_instances wi
    WHERE wi.id = instance_id
      AND wi."tenantId" = public.workgraph_current_tenant_id()
  )
$$;

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

SELECT public.workgraph_install_tenant_policy(
  'workflow_instances',
  '"tenantId" = public.workgraph_current_tenant_id()'
);

SELECT public.workgraph_install_tenant_policy(
  'run_snapshots',
  '"tenantId" = public.workgraph_current_tenant_id()'
);

SELECT public.workgraph_install_tenant_policy('workflow_run_budgets', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('workflow_run_budget_events', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('workflow_phases', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('workflow_nodes', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('workflow_edges', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('workflow_mutations', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('workflow_events', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('tasks', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('approval_requests', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('consumables', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('agent_runs', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('tool_runs', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('documents', 'public.workgraph_instance_visible("instanceId")');
SELECT public.workgraph_install_tenant_policy('pending_executions', 'public.workgraph_instance_visible("instanceId")');

DROP FUNCTION public.workgraph_install_tenant_policy(text, text);
