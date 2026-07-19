-- ============================================================================
-- Synthesis R0 0.4 — ENABLE + FORCE ROW LEVEL SECURITY on the Synthesis + domain-spine tables.
-- MANUAL, guarded cutover. Mirrors prisma/rls-cutover-manual-apply-only.sql.
-- ============================================================================
-- WHY THIS IS NOT AUTO-APPLIED (the load-bearing prerequisite):
--   app.tenant_id is set PER-TRANSACTION by withTenantDbTransaction
--   (`select set_config('app.tenant_id', $tenant, true)` — transaction-local), and the
--   `prisma` Proxy only routes to that transaction when one is active. So under FORCE RLS,
--   any read OR write that is NOT wrapped in withTenantDbTransaction sees a NULL app.tenant_id
--   and the policy `"tenantId" = workgraph_current_tenant_id()` matches nothing:
--     • reads  → 0 rows
--     • writes → WITH CHECK violation
--   Today the spine reads (studio-projects / rooms / work-items / specifications services) use
--   plain prisma + an explicit `where: { tenantId }` filter, NOT withTenantDbTransaction. So
--   before running this cutover you MUST thread withTenantDbTransaction through every read AND
--   write of the tables below, and VALIDATE it against a live (reseeded) database. The
--   synthesis services need the same threading.
--
-- FAIL-CLOSED: the preflight RAISEs (aborting with ZERO changes) if any precondition is unmet.
-- APPLY:    psql "$DATABASE_URL" -f prisma/rls-cutover-synthesis-spine.sql   (as a BYPASSRLS admin)
-- ROLLBACK: the NO FORCE / DISABLE block at the bottom.
-- ============================================================================

BEGIN;

DO $preflight$
DECLARE
  v_tables text[] := ARRAY[
    -- domain spine (policies scaffolded by 20260819000000_synthesis_spine_rls_policies)
    'specification_projects','work_items','rooms','claims','studios','studio_proposals',
    'specification_versions','spec_comments','decision_dossiers','decision_options','project_specifications',
    -- synthesis (policies installed at table creation)
    'synthesis_workspaces','workspace_threads','workspace_messages','context_references','context_manifests',
    'synthesis_documents','document_versions','document_blocks','proposal_items'
  ];
  v_missing text;
  v_can_bypass boolean;
  v_tbl text;
  v_nulls bigint;
  v_null_report text := '';
BEGIN
  -- Guard A — every target table must already carry the scaffolded policy; forcing a
  -- policy-less table denies ALL access to it.
  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(v_tables) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation_policy'
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'RLS cutover aborted [Guard A]: tenant_isolation_policy missing on: %. Run the policy-scaffold migrations first.', v_missing;
  END IF;

  -- Guard B — the applying role must survive FORCE (adminPrisma / background sweeps connect
  -- as this same role; without BYPASSRLS their cross-tenant discovery silently stops).
  SELECT rolsuper OR rolbypassrls INTO v_can_bypass FROM pg_roles WHERE rolname = current_user;
  IF NOT COALESCE(v_can_bypass, false) THEN
    RAISE EXCEPTION 'RLS cutover aborted [Guard B]: role "%" is neither SUPERUSER nor BYPASSRLS. Run: ALTER ROLE "%" BYPASSRLS; then re-apply.', current_user, current_user;
  END IF;

  -- Guard C — rows with NULL tenantId become invisible to every reader at cutover.
  FOREACH v_tbl IN ARRAY v_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "tenantId" IS NULL', v_tbl) INTO v_nulls;
    IF v_nulls > 0 THEN v_null_report := v_null_report || format('%s=%s ', v_tbl, v_nulls); END IF;
  END LOOP;
  IF length(v_null_report) > 0 THEN
    RAISE EXCEPTION 'RLS cutover aborted [Guard C]: NULL-tenant rows exist (%). Backfill tenantId (or reseed) first.', trim(v_null_report);
  END IF;

  RAISE NOTICE 'Synthesis + spine RLS preflight passed. Forcing % tables.', array_length(v_tables, 1);

  FOREACH v_tbl IN ARRAY v_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_tbl);
  END LOOP;
END
$preflight$;

COMMIT;

-- ── Rollback (run as a BYPASSRLS admin) ─────────────────────────────────────
-- DO $rollback$
-- DECLARE v_tbl text; v_tables text[] := ARRAY[
--   'specification_projects','work_items','rooms','claims','studios','studio_proposals',
--   'specification_versions','spec_comments','decision_dossiers','decision_options','project_specifications',
--   'synthesis_workspaces','workspace_threads','workspace_messages','context_references','context_manifests',
--   'synthesis_documents','document_versions','document_blocks','proposal_items'];
-- BEGIN
--   FOREACH v_tbl IN ARRAY v_tables LOOP
--     EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', v_tbl);
--     EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', v_tbl);
--   END LOOP;
-- END $rollback$;
