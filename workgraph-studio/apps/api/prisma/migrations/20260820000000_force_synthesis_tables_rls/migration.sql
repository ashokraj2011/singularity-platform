-- ============================================================================
-- SYNTHESIS TABLES — TENANT RLS ENABLEMENT (auto-applied FORCE cutover).
-- ============================================================================
-- Flips ENABLE + FORCE ROW LEVEL SECURITY on the 9 synthesis-module tables. Their
-- tenant_isolation_policy was scaffolded at table-creation (20260815/16/17) but left
-- INERT (a CREATE POLICY does nothing until RLS is enabled). This migration turns it on.
--
-- WHY THIS IS SAFE TO AUTO-APPLY (and the spine cutover, prisma/rls-cutover-synthesis-spine.sql,
-- is NOT): app.tenant_id is set PER-TRANSACTION by withTenantDbTransaction, and the `prisma`
-- Proxy only routes to that transaction when one is active. So under FORCE RLS every read AND
-- write of a target table MUST be wrapped in withTenantDbTransaction, or the policy
-- `"tenantId" = workgraph_current_tenant_id()` matches nothing (reads → 0 rows; writes → WITH
-- CHECK violation). These 9 tables are accessed EXCLUSIVELY by the modules/synthesis/* services
-- (workspace / message / context-reference / context-manifest / document / block / proposal),
-- and every one of those functions is now wrapped in withTenantDbTransaction. The domain spine
-- (specification_projects, work_items, rooms, …) is read by many still-unthreaded services, so
-- it stays a guarded MANUAL cutover — not this migration.
--
-- FAIL-CLOSED BY CONSTRUCTION. The preflight DO-block RAISEs — aborting this migration's
-- transaction with ZERO changes — if any precondition is unmet (a policy-less target table, an
-- applying role that cannot bypass RLS, or a NULL-tenant row). `migrate deploy` runs each
-- migration in a transaction, so a RAISE here fails the deploy LOUDLY and applies nothing — it
-- never leaves a table half-forced or silently unreadable. Resolve the flagged blocker (reseed
-- to clear NULL-tenant rows, or `ALTER ROLE … BYPASSRLS`), then the next deploy applies cleanly.
--
-- NOTE: no BEGIN/COMMIT — Prisma wraps the migration in its own transaction.
-- ROLLBACK: the NO FORCE / DISABLE block at the bottom (run as a BYPASSRLS admin).
-- ============================================================================

DO $preflight$
DECLARE
  v_tables text[] := ARRAY[
    'synthesis_workspaces','workspace_threads','workspace_messages','context_references','context_manifests',
    'synthesis_documents','document_versions','document_blocks','proposal_items'
  ];
  v_missing_policies text;
  v_can_bypass boolean;
  v_tbl text;
  v_nulls bigint;
  v_null_report text := '';
BEGIN
  -- Guard A — every target table must already carry the scaffolded policy; forcing a
  -- policy-less table would deny ALL access to it. (Policies come from 20260815/16/17.)
  SELECT string_agg(t, ', ') INTO v_missing_policies
    FROM unnest(v_tables) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation_policy'
   );
  IF v_missing_policies IS NOT NULL THEN
    RAISE EXCEPTION 'Synthesis RLS enablement aborted [Guard A]: tenant_isolation_policy missing on: %. The synthesis table-creation migrations (20260815/16/17) must run first.', v_missing_policies;
  END IF;

  -- Guard B — the applying role must survive FORCE RLS (adminPrisma / background sweeps
  -- connect as this same role; without BYPASSRLS their cross-tenant discovery silently stops).
  SELECT rolsuper OR rolbypassrls INTO v_can_bypass FROM pg_roles WHERE rolname = current_user;
  IF NOT COALESCE(v_can_bypass, false) THEN
    RAISE EXCEPTION 'Synthesis RLS enablement aborted [Guard B]: role "%" is neither SUPERUSER nor BYPASSRLS. Under FORCE RLS a same-role admin/sweep connection would silently see 0 rows. Fix: ALTER ROLE "%" BYPASSRLS; then re-deploy.', current_user, current_user;
  END IF;

  -- Guard C — a NULL-tenant row becomes invisible to every reader the instant FORCE lands.
  -- These tables are new and every synthesis write stamps tenantId, so this should be empty;
  -- if not, abort loudly rather than silently orphaning rows.
  FOREACH v_tbl IN ARRAY v_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "tenantId" IS NULL', v_tbl) INTO v_nulls;
    IF v_nulls > 0 THEN v_null_report := v_null_report || format('%s=%s ', v_tbl, v_nulls); END IF;
  END LOOP;
  IF length(v_null_report) > 0 THEN
    RAISE EXCEPTION 'Synthesis RLS enablement aborted [Guard C]: NULL-tenant rows exist (%). Backfill tenantId (or reseed) first.', trim(v_null_report);
  END IF;

  RAISE NOTICE 'Synthesis RLS enablement preflight passed. Forcing % tables.', array_length(v_tables, 1);
END
$preflight$;

-- ENABLE + FORCE ROW LEVEL SECURITY on the 9 synthesis tables (policies already scaffolded).
ALTER TABLE public.synthesis_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_threads    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_references   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_manifests    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.synthesis_documents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_versions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_blocks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proposal_items       ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.synthesis_workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_threads    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_messages   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.context_references   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.context_manifests    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.synthesis_documents  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_versions    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_blocks      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.proposal_items       FORCE ROW LEVEL SECURITY;

-- ── Rollback (run as a BYPASSRLS admin) ─────────────────────────────────────
-- DO $rollback$
-- DECLARE v_tbl text; v_tables text[] := ARRAY[
--   'synthesis_workspaces','workspace_threads','workspace_messages','context_references','context_manifests',
--   'synthesis_documents','document_versions','document_blocks','proposal_items'];
-- BEGIN
--   FOREACH v_tbl IN ARRAY v_tables LOOP
--     EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', v_tbl);
--     EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', v_tbl);
--   END LOOP;
-- END $rollback$;
