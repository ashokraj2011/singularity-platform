-- ============================================================================
-- Tenant RLS policy scaffold for Context Fabric's conversation store.
-- ============================================================================
-- Conversation turns are raw user text -- the most sensitive content the
-- platform stores -- and until now they were protected by app-level tenant
-- scoping only. conversation_store.py's own docstring said so: "this is the
-- weakest protection on the most sensitive data in the platform; forced RLS is
-- a tracked follow-up." This is that follow-up.
--
-- SHAPE BORROWED FROM WORKGRAPH, deliberately, rather than invented here. CF has
-- no RLS precedent, and a second, subtly different tenancy idiom in the same
-- platform is how one of them ends up wrong. Mirrors:
--   workgraph-studio/apps/api/prisma/migrations/20260619123000_tenant_rls_policy_scaffold/
--   workgraph-studio/apps/api/prisma/migrations/20260819000000_synthesis_spine_rls_policies/
--
-- Two differences from workgraph, both forced by CF's schema:
--   1. CF columns are snake_case and unquoted (tenant_id), not "tenantId".
--   2. Both tables carry tenant_id directly, so both get a direct predicate.
--      Workgraph needed a workgraph_instance_visible() subquery for child tables
--      that had no tenant column of their own. cf_conversation_turns has one, so
--      the simpler and stricter direct comparison applies -- no join to trust.
--
-- THIS FILE IS INERT. It creates a helper function and two policies and does NOT
-- enable or force RLS, so applying it has NO runtime effect: a policy does
-- nothing until RLS is turned on for the table. Turning it on is a separate,
-- guarded, operator-initiated cutover -- bin/enable-cf-conversation-forced-rls.py
-- -- because it fails closed and every read AND write must first run inside a
-- tenant-scoped transaction.
--
-- POSTGRES ONLY. conversation_store.py also supports a SQLite target (the
-- standalone/dev default, ./data/conversations.db). SQLite has no row-level
-- security of any kind, so on that backend tenancy remains app-level and this
-- file is never applied. That is a real gap, not a technicality: a deployment
-- holding regulated conversation data must run the store on Postgres.
-- ============================================================================

-- NULL, not '', when unset. That is what makes an unscoped session see ZERO
-- rows instead of everything: `tenant_id = NULL` evaluates to NULL, which is not
-- true, so the policy matches nothing. Fail-closed by construction rather than
-- by remembering to add a guard at every call site.
CREATE OR REPLACE FUNCTION public.cf_current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')
$$;

CREATE OR REPLACE FUNCTION public.cf_install_tenant_policy(table_name text, predicate text)
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

-- Installed only when the tables exist, so this file is safe to apply against a
-- database whose conversation store has not been initialised yet (init_db() runs
-- at service startup, which may be after an operator applies this).
DO $$
BEGIN
  IF to_regclass('public.cf_conversations') IS NOT NULL THEN
    PERFORM public.cf_install_tenant_policy(
      'cf_conversations',
      'tenant_id = public.cf_current_tenant_id()'
    );
  END IF;

  IF to_regclass('public.cf_conversation_turns') IS NOT NULL THEN
    PERFORM public.cf_install_tenant_policy(
      'cf_conversation_turns',
      'tenant_id = public.cf_current_tenant_id()'
    );
  END IF;
END;
$$;

DROP FUNCTION public.cf_install_tenant_policy(text, text);
