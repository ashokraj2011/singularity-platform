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

-- run_snapshots receives tenantId in the immediately following migration.
-- On upgraded databases the column may already exist; on a clean replay it
-- does not yet. Install here only when safe and let the next migration own the
-- normal fresh-install policy creation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'run_snapshots'
      AND column_name = 'tenantId'
  ) THEN
    PERFORM public.workgraph_install_tenant_policy(
      'run_snapshots',
      '"tenantId" = public.workgraph_current_tenant_id()'
    );
  END IF;
END;
$$;

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

-- Studio board tables were introduced after this scaffold migration. Keep the
-- deployment/cutover script self-contained by installing their policies when
-- they already exist, while allowing a fresh Prisma migration to run before
-- those later tables are created. M101 installs the same policies in normal
-- migration order.
DO $$
BEGIN
  IF to_regclass('public.boards') IS NOT NULL THEN
    PERFORM public.workgraph_install_tenant_policy('boards', '"tenantId" = public.workgraph_current_tenant_id()');
    PERFORM public.workgraph_install_tenant_policy('board_branches', '"tenantId" = public.workgraph_current_tenant_id()');
    PERFORM public.workgraph_install_tenant_policy('board_events', '"tenantId" = public.workgraph_current_tenant_id()');
    PERFORM public.workgraph_install_tenant_policy('board_snapshots', '"tenantId" = public.workgraph_current_tenant_id()');
    PERFORM public.workgraph_install_tenant_policy('board_moments', '"tenantId" = public.workgraph_current_tenant_id()');
    PERFORM public.workgraph_install_tenant_policy('ingested_artifacts', '"tenantId" = public.workgraph_current_tenant_id()');
    PERFORM public.workgraph_install_tenant_policy('agent_verdicts', '"tenantId" = public.workgraph_current_tenant_id()');
  END IF;
END;
$$;

DROP FUNCTION public.workgraph_install_tenant_policy(text, text);
