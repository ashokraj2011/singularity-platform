-- Synthesis R0 0.4 (policy scaffold). Install the tenant_isolation_policy on the domain-spine
-- tables the Synthesis Working Session rests on, so they join the runtime + board tables as
-- policy-ready. (The synthesis tables — synthesis_workspaces, workspace_threads,
-- workspace_messages, context_references, context_manifests, synthesis_documents,
-- document_versions, document_blocks, proposal_items — already installed their policies at
-- creation time.)
--
-- This migration is SAFE: it creates policies WITHOUT ENABLE/FORCE, so there is NO runtime
-- effect (a policy is inert until RLS is forced on the table). Turning RLS ON is a separate,
-- guarded, MANUAL cutover — prisma/rls-cutover-synthesis-spine.sql — because it is an explicit
-- operator decision that fails closed until every read AND write of these tables runs inside a
-- tenant DB transaction (app.tenant_id is transaction-local; see the cutover file's header).
--
-- workgraph_current_tenant_id() is created by the 20260619123000 scaffold and persists.

CREATE OR REPLACE FUNCTION public.workgraph_install_tenant_policy(table_name text, predicate text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = table_name AND policyname = 'tenant_isolation_policy'
  ) THEN
    EXECUTE format('CREATE POLICY tenant_isolation_policy ON public.%I FOR ALL USING (%s) WITH CHECK (%s)', table_name, predicate, predicate);
  END IF;
END; $$;

SELECT public.workgraph_install_tenant_policy(t, '"tenantId" = public.workgraph_current_tenant_id()')
FROM (VALUES
  ('specification_projects'),
  ('work_items'),
  ('rooms'),
  ('claims'),
  ('studios'),
  ('studio_proposals'),
  ('specification_versions'),
  ('spec_comments'),
  ('decision_dossiers'),
  ('decision_options'),
  ('project_specifications')
) AS s(t);

DROP FUNCTION public.workgraph_install_tenant_policy(text, text);
