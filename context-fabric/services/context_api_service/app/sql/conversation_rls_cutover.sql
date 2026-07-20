-- ============================================================================
-- ENABLE + FORCE ROW LEVEL SECURITY on Context Fabric's conversation tables.
-- MANUAL, guarded cutover. Mirrors
-- workgraph-studio/apps/api/prisma/rls-cutover-synthesis-spine.sql.
-- ============================================================================
-- WHY THIS IS NOT AUTO-APPLIED (the load-bearing prerequisite):
--   app.tenant_id is set PER-TRANSACTION by conversation_rls.tenant_scoped_conn()
--   (`select set_config('app.tenant_id', %s, true)` -- the `true` means
--   transaction-local). Under FORCE RLS, any read OR write that is NOT wrapped
--   in a tenant-scoped transaction sees a NULL app.tenant_id and the policy
--   `tenant_id = cf_current_tenant_id()` matches nothing:
--     * reads  -> 0 rows
--     * writes -> WITH CHECK violation
--   So before running this, every caller must be going through the store's
--   tenant-scoped helpers, and a caller that cannot name a tenant must be
--   treated as a bug rather than defaulted to something.
--
-- FORCE, not merely ENABLE: without FORCE, the table OWNER bypasses its own
-- policies. CF connects with a single role that is usually the owner, so plain
-- ENABLE would look correct in pg_policies and isolate nothing at runtime. This
-- is the failure mode most likely to be mistaken for success.
--
-- APPLY:    psql "$URL" -f conversation_rls_cutover.sql   (as a BYPASSRLS admin)
--           or, preferred: bin/enable-cf-conversation-forced-rls.py --apply
-- ROLLBACK: the NO FORCE / DISABLE block at the bottom.
-- ============================================================================

BEGIN;

DO $preflight$
DECLARE
  v_tables text[] := ARRAY['cf_conversations', 'cf_conversation_turns'];
  v_missing text;
  v_can_bypass boolean;
  v_tbl text;
  v_nulls bigint;
  v_null_report text := '';
BEGIN
  -- Guard A -- every target table must already carry the scaffolded policy.
  -- Forcing RLS on a policy-less table denies ALL access to it, which reads as
  -- "the store is broken" rather than "the cutover was misordered".
  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(v_tables) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation_policy'
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'CF conversation RLS cutover aborted [Guard A]: tenant_isolation_policy missing on: %. Apply sql/conversation_rls_policies.sql first.', v_missing;
  END IF;

  -- Guard B -- the applying role must survive FORCE. Any operational or
  -- background query that legitimately spans tenants (retention sweeps,
  -- migrations) runs as this role; without BYPASSRLS it silently returns
  -- nothing after cutover instead of failing.
  SELECT rolsuper OR rolbypassrls INTO v_can_bypass FROM pg_roles WHERE rolname = current_user;
  IF NOT COALESCE(v_can_bypass, false) THEN
    RAISE EXCEPTION 'CF conversation RLS cutover aborted [Guard B]: role "%" is neither SUPERUSER nor BYPASSRLS. Run: ALTER ROLE "%" BYPASSRLS; then re-apply.', current_user, current_user;
  END IF;

  -- Guard C -- rows with NULL tenant_id become invisible to EVERY reader at
  -- cutover, including the tenant that owns them. tenant_id is nullable on both
  -- tables and the pre-RLS store allowed conversations to be created without
  -- one, so this is a live possibility, not a theoretical one.
  FOREACH v_tbl IN ARRAY v_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id IS NULL', v_tbl) INTO v_nulls;
    IF v_nulls > 0 THEN v_null_report := v_null_report || format('%s=%s ', v_tbl, v_nulls); END IF;
  END LOOP;
  IF length(v_null_report) > 0 THEN
    RAISE EXCEPTION 'CF conversation RLS cutover aborted [Guard C]: NULL-tenant rows exist (%). Backfill tenant_id first -- after cutover they are unreachable by every tenant.', trim(v_null_report);
  END IF;

  -- Guard D -- a turn whose tenant_id disagrees with its conversation's is a
  -- pre-existing data bug that RLS turns into a split-brain transcript: the
  -- conversation is visible to one tenant and some of its turns to another.
  -- Cheaper to find here than in an incident.
  IF EXISTS (
    SELECT 1
      FROM public.cf_conversation_turns t
      JOIN public.cf_conversations c ON c.conversation_id = t.conversation_id
     WHERE t.tenant_id IS DISTINCT FROM c.tenant_id
  ) THEN
    RAISE EXCEPTION 'CF conversation RLS cutover aborted [Guard D]: turns exist whose tenant_id differs from their conversation''s. Reconcile before forcing RLS.';
  END IF;

  RAISE NOTICE 'CF conversation RLS preflight passed. Forcing % tables.', array_length(v_tables, 1);

  FOREACH v_tbl IN ARRAY v_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_tbl);
  END LOOP;
END
$preflight$;

COMMIT;

-- ── Rollback (run as a BYPASSRLS admin) ─────────────────────────────────────
-- DO $rollback$
-- DECLARE v_tbl text; v_tables text[] := ARRAY['cf_conversations', 'cf_conversation_turns'];
-- BEGIN
--   FOREACH v_tbl IN ARRAY v_tables LOOP
--     EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', v_tbl);
--     EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', v_tbl);
--   END LOOP;
-- END $rollback$;
