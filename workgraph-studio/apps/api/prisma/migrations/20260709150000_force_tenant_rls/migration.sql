-- ============================================================================
-- TENANT RLS CUTOVER — AUTO-APPLIED (per explicit operator decision).
-- ============================================================================
-- This migration flips ENABLE + FORCE ROW LEVEL SECURITY on the 16 tenant-scoped
-- tables the 20260619123000 scaffold defined policies for. It is the same SQL as
-- prisma/rls-cutover-manual-apply-only.sql, moved into prisma/migrations/ so
-- `prisma migrate deploy` applies it automatically on deploy (the operator chose
-- auto-apply over the manual `psql -f` cutover).
--
-- FAIL-CLOSED BY CONSTRUCTION. The preflight DO-block below RAISEs — aborting
-- this migration's transaction with ZERO changes — if any hard precondition is
-- unmet (a policy-less target table, an applying role that can't bypass RLS, a
-- NULL-tenant workflow_instance, or a standalone row with both instanceId and
-- tenantId NULL). Because `migrate deploy` runs each migration in a transaction,
-- a RAISE here fails the deploy LOUDLY and applies nothing — it never leaves RLS
-- half-forced or silently breaks data access. The guards are retained from the
-- manual cutover deliberately: without them a naked FORCE would (per the cutover
-- file's BLOCKERS B1/B3/B4) reject task CRUD, freeze trigger-spawned instances,
-- and stop TimerSweep platform-wide.
--
-- CONSEQUENCE OF AUTO-APPLY: until BLOCKERS B1 (untenanted non-engine routes),
-- B3 (NULL-tenant trigger-spawned instances) and B4 (admin role BYPASSRLS) are
-- resolved, this migration's guards WILL abort — which fails `migrate deploy`
-- and therefore blocks API boot on that environment. That is the intended
-- fail-closed outcome: resolve the blockers (backfill NULL-tenant instances,
-- tenant-scope the offender routes, grant BYPASSRLS to the admin role), then the
-- next deploy applies FORCE cleanly. Rollback: run the NO FORCE / DISABLE blocks
-- at the bottom of prisma/rls-cutover-manual-apply-only.sql via the admin role.
--
-- NOTE: no BEGIN/COMMIT here — Prisma wraps the migration in its own transaction,
-- so an explicit one would error. The manual cutover file keeps its BEGIN/COMMIT
-- because it is applied by psql outside Prisma.
-- ============================================================================

DO $preflight$
DECLARE
  v_tables text[] := ARRAY[
    'workflow_instances','run_snapshots','workflow_run_budgets','workflow_run_budget_events',
    'workflow_phases','workflow_nodes','workflow_edges','workflow_mutations','workflow_events',
    'tasks','approval_requests','consumables','agent_runs','tool_runs','documents','pending_executions'
  ];
  v_nullable_instance_tables text[] := ARRAY[
    'tasks','approval_requests','consumables','agent_runs','tool_runs','documents'
  ];
  v_missing_policies text;
  v_can_bypass boolean;
  v_null_tenant_instances bigint;
  v_orphan_report text := '';
  v_tbl text;
  v_cnt bigint;
BEGIN
  -- Guard A — every target table must already carry the scaffolded policy;
  -- forcing RLS on a policy-less table denies ALL access to it.
  SELECT string_agg(t, ', ')
    INTO v_missing_policies
    FROM unnest(v_tables) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation_policy'
   );
  IF v_missing_policies IS NOT NULL THEN
    RAISE EXCEPTION 'RLS cutover aborted [Guard A]: tenant_isolation_policy missing on: %. The 20260619123000_tenant_rls_policy_scaffold migration must run first.', v_missing_policies;
  END IF;

  -- Guard B (B4) — the applying role must survive FORCE RLS for cross-tenant
  -- reads (adminPrisma/TimerSweep connect as this same admin role).
  SELECT rolsuper OR rolbypassrls INTO v_can_bypass FROM pg_roles WHERE rolname = current_user;
  IF NOT COALESCE(v_can_bypass, false) THEN
    RAISE EXCEPTION 'RLS cutover aborted [Guard B / B4]: role "%" is neither SUPERUSER nor BYPASSRLS. Under FORCE RLS, TimerSweep''s cross-tenant discovery (adminPrisma, same role) would silently stop firing platform-wide. Fix: ALTER ROLE "%" BYPASSRLS; then re-deploy.', current_user, current_user;
  END IF;

  -- Guard C (B3 / Decision C) — tenant-less instances vanish at cutover.
  SELECT count(*) INTO v_null_tenant_instances
    FROM public.workflow_instances WHERE "tenantId" IS NULL;
  IF v_null_tenant_instances > 0 THEN
    RAISE EXCEPTION 'RLS cutover aborted [Guard C / B3]: % workflow_instances row(s) have tenantId IS NULL (trigger-spawned). They and all their child rows become invisible to every reader at cutover. Backfill tenantId or resolve the trigger-tenant gap first.', v_null_tenant_instances;
  END IF;

  -- Guard D (B2) — a standalone row is representable as long as it carries a
  -- direct tenantId; the hazard is rows with BOTH instanceId AND tenantId NULL.
  FOREACH v_tbl IN ARRAY v_nullable_instance_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "instanceId" IS NULL AND "tenantId" IS NULL', v_tbl) INTO v_cnt;
    IF v_cnt > 0 THEN
      v_orphan_report := v_orphan_report || format('%s=%s ', v_tbl, v_cnt);
    END IF;
  END LOOP;
  IF length(v_orphan_report) > 0 THEN
    RAISE EXCEPTION 'RLS cutover aborted [Guard D / B2]: rows with BOTH instanceId AND tenantId NULL exist (%). They satisfy neither branch of the tenantId-OR-instance policy and would be frozen/invisible. Backfill tenantId on these pre-existing standalone rows first.', trim(v_orphan_report);
  END IF;

  RAISE NOTICE 'RLS cutover preflight passed. Applying ENABLE/FORCE on % tables.', array_length(v_tables, 1);
END
$preflight$;

-- ENABLE + FORCE ROW LEVEL SECURITY on the 16 scaffolded tables.
ALTER TABLE public.workflow_instances         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_snapshots              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_run_budgets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_run_budget_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_phases            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_nodes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_edges             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_mutations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_requests          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consumables                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_runs                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_executions         ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.workflow_instances         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.run_snapshots              FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_run_budgets       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_run_budget_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_phases            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_nodes             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_edges             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_mutations         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_events            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tasks                      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.approval_requests          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.consumables                FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs                 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tool_runs                  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.documents                  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pending_executions         FORCE ROW LEVEL SECURITY;
