-- ============================================================================
-- TENANT RLS CUTOVER — MANUAL, HUMAN-SUPERVISED APPLY ONLY.
-- ============================================================================
--
-- DO NOT rename this file into prisma/migrations/. This repo's Docker image
-- CMD (workgraph-studio/apps/api/Dockerfile, both the dev and prod stages)
-- runs `npx prisma migrate deploy` unconditionally on every container start,
-- with no confirmation gate. If this SQL lived inside prisma/migrations/, the
-- next routine restart of ANY environment running that image — a developer's
-- `docker compose up`, a redeploy, a crash-restart — would silently apply it.
-- That is not a hypothetical: it is exactly how the prior scaffold migration
-- (20260619123000_tenant_rls_policy_scaffold) reached every Docker-based
-- environment. This file is deliberately kept OUTSIDE prisma/migrations/ so
-- it is never auto-discovered or auto-applied. Applying it is a manual,
-- one-time `psql -f` a human runs deliberately, during a planned maintenance
-- window, against the admin/owner connection — mirroring how
-- bootstrap-app-role.sh (this same directory) is invoked explicitly rather
-- than through Prisma's migration runner.
--
-- WHAT THIS DOES: flips FORCE ROW LEVEL SECURITY on for real, for the 16
-- tenant-scoped tables the 20260619123000 migration scaffolded policies for
-- but deliberately left inert. Every slice in the "thread tenant-scoped
-- transactions through the workflow engine" initiative (PRs #297, #298, #299,
-- #300, #301, #302, #303) exists solely to make running this file safe FOR
-- THE ENGINE'S OWN QUERY PATHS. It does NOT, on its own, make every API
-- surface safe — see BLOCKERS below.
--
-- SAFE BY CONSTRUCTION, NOT JUST BY CHECKLIST: the whole file runs inside one
-- transaction (BEGIN/COMMIT), and a preflight DO-block RAISEs — aborting the
-- entire transaction with zero changes applied — if any of the known hard
-- preconditions below are not met. A human can still comment out an individual
-- guard if they have genuinely resolved that item another way, but the default
-- is fail-closed: unmet precondition ⇒ nothing happens.
--
-- ----------------------------------------------------------------------------
-- BLOCKERS — verified 2026-07-01 against the code on `main` at cutover-authoring
-- time. Each is ALSO enforced by a preflight guard below where it can be
-- expressed in SQL; the ones that are code-shape problems (not data-at-rest)
-- can only be carried here, so read this list even though the guards exist.
-- ----------------------------------------------------------------------------
--
-- [ ] B1. NON-ENGINE API SURFACES ARE NOT TENANT-SCOPED. This initiative
--        threaded withTenantDbTransaction through the ENGINE (scheduler +
--        WorkflowRuntime + all 20 executors + budget/clone). It did NOT touch
--        several MOUNTED HTTP routes / services that read and write the same
--        16 RLS tables with bare `prisma.*` (no withTenantDbTransaction, so no
--        SET LOCAL app.tenant_id — the global tenantDbContextMiddleware only
--        populates AsyncLocalStorage, it does not open a tenant-scoped tx).
--        Confirmed offenders (non-exhaustive — re-audit before applying):
--          - src/modules/task/tasks.router.ts  (/api/tasks): create, list,
--            my-work, team-queue, get, claim, complete, form-submit — every
--            task CRUD op. After cutover: create/claim/complete are REJECTED
--            by the tasks WITH CHECK; list/get return EMPTY.
--          - src/modules/agent/agents.router.ts (/api/agents/:id/runs):
--            creates agent_runs with an OPTIONAL instanceId.
--          - src/modules/laptop/laptop.service.ts: creates agent_runs with NO
--            instanceId at all (origin='laptop').
--          - src/modules/tool/gateway/ToolGatewayService.ts: creates tool_runs
--            with an OPTIONAL instanceId.
--        RESOLVE BEFORE APPLYING: either (a) finish tenant-scoping these
--        surfaces (wrap their reads/writes in withTenantDbTransaction and give
--        them a tenant source), or (b) hold the affected tables OUT of this
--        cutover (see B2 for which tables) until they are.
--
-- [x] B2. SIX TABLES HAVE A STANDALONE (NULL instanceId) ROW MODE — RESOLVED.
--        Of the 16 tables, these six have a NULLABLE instanceId and can hold
--        non-workflow rows:
--            tasks, approval_requests, consumables,
--            agent_runs, tool_runs, documents
--        This WAS unrepresentable under the scaffolded
--        workgraph_instance_visible("instanceId") policy (a NULL instanceId
--        satisfies nothing). RESOLVED by migration
--        20260701120000_add_tenant_id_to_standalone_tables, which adds a direct
--        tenantId column to these six and revises their policy to
--            "tenantId" = workgraph_current_tenant_id() OR workgraph_instance_visible("instanceId")
--        so standalone rows are visible via their direct tenant and
--        instance-linked rows via their instance (unchanged). The standalone
--        WRITE PATHS (tasks.router direct create, agents.router /:id/runs,
--        laptop.service, ToolGatewayService) now stamp tenantId on new rows.
--        REMAINING CHECK: pre-existing standalone rows created BEFORE that work
--        may have both instanceId AND tenantId NULL — Guard D below hard-stops on
--        those; backfill their tenantId first. (B1's other unscoped-surface
--        concern is likewise closed: the router/service layer was tenant-scoped
--        in Phase 2, PRs #305-#311.)
--
-- [ ] B3. TRIGGER-SPAWNED INSTANCES HAVE tenantId: NULL (Decision C). Workflow
--        and WorkflowTrigger have no tenant column, so
--        TriggerScheduler.spawnInstance() creates every scheduled/
--        event-triggered WorkflowInstance with tenantId = NULL. Fail-closed
--        RLS makes those instances (and, transitively, all their child rows)
--        invisible to every reader at cutover — scheduled/event automation
--        silently stops advancing. Guard C below HARD-STOPS if any NULL-tenant
--        instance exists. Confirmed unresolved as of PR #303.
--
-- [ ] B4. adminPrisma's OWNER-ROLE CROSS-TENANT BYPASS BREAKS UNDER FORCE RLS
--        UNLESS THAT ROLE IS SUPERUSER OR BYPASSRLS. lib/admin-prisma.ts
--        (TimerSweep's cross-tenant TIMER/SLA discovery, slice 2) connects via
--        WORKGRAPH_DATABASE_URL_ADMIN — the owner/admin role — specifically to
--        see rows across every tenant. FORCE ROW LEVEL SECURITY applies RLS
--        even to the table owner, UNLESS the role is a real superuser (Postgres
--        exempts those unconditionally) or has BYPASSRLS. Local Docker's admin
--        is usually a real superuser (FORCE is a no-op for it there); many
--        MANAGED services (RDS, Cloud SQL) do NOT grant true superuser. If the
--        prod admin role is neither, TimerSweep's cross-tenant sweeps silently
--        return zero rows — TIMER nodes and Task SLAs stop firing platform-wide.
--        Guard B below HARD-STOPS if the APPLYING role (current_user, which by
--        the documented apply command IS this admin role) lacks both. Note it
--        can only check the applying role; also confirm adminPrisma is actually
--        wired to a bypass-capable role in the target env (if
--        WORKGRAPH_DATABASE_URL_ADMIN is unset, adminPrisma falls back to the
--        NOBYPASSRLS app role and TimerSweep breaks anyway).
--
-- [ ] B5. CHILD/DETAIL TABLES ARE NOT DB-RLS PROTECTED. This cutover (and the
--        scaffold it forces) covers parent tables only. Related child tables —
--        task_assignments, team_queue_items, task_comments, task_status_history,
--        approval_decisions, agent_run_outputs, agent_run_inputs,
--        tool_run_approvals, consumable_versions, and others — have NO tenant
--        policy, so DB-level isolation for them is nonexistent; isolation there
--        rests entirely on application-layer scoping and on not exposing
--        cross-tenant queries (e.g. tasks.router team-queue reads teamQueueItem
--        by teamId with no tenant guard). This is a known limitation of the
--        current RLS design, not something this file changes. If a complete
--        DB-level boundary is required, those child tables need their own
--        policies (a new scaffold migration) before this is considered "done".
--
-- [ ] B6. Standard pre-cutover hygiene: PRs #297-#303 have soaked in prod long
--        enough to trust; TENANT_ISOLATION_MODE and other deploy-env flags
--        match the target (bin/check-deploy-env.sh expects `strict` in prod);
--        a fresh backup/snapshot was taken immediately before; and the rollback
--        block at the bottom of this file has been read and is ready to run.
--
-- [ ] B7. SignalEmitExecutor's cross-instance signal broadcast was narrowed to
--        same-tenant delivery in PR #303. If any workflow relies on SIGNAL_EMIT
--        waking a SIGNAL_WAIT in a DIFFERENT tenant, that stops at cutover.
--        Confirmed not the case as of #303 — re-verify if templates changed.
--
-- HOW TO APPLY (only after every box above is checked and, for B1/B2, actually
-- resolved — the guards catch data-at-rest, not the code paths):
--     psql "$WORKGRAPH_DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 \
--       -f prisma/rls-cutover-manual-apply-only.sql
--   The file wraps itself in a single transaction, so do NOT also pass
--   --single-transaction. ON_ERROR_STOP=1 makes any guard RAISE abort psql,
--   rolling the whole transaction back with nothing applied.
--
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- PREFLIGHT GUARDS — abort the whole transaction (nothing applied) if any
-- known hard precondition is unmet. Comment out an individual guard ONLY if you
-- have deliberately, verifiably resolved that specific item another way.
-- ----------------------------------------------------------------------------
DO $preflight$
DECLARE
  v_tables text[] := ARRAY[
    'workflow_instances','run_snapshots','workflow_run_budgets','workflow_run_budget_events',
    'workflow_phases','workflow_nodes','workflow_edges','workflow_mutations','workflow_events',
    'tasks','approval_requests','consumables','agent_runs','tool_runs','documents','pending_executions'
  ];
  -- The six tables with a NULLABLE instanceId (B2) — standalone rows here are
  -- unrepresentable under the instance-visibility policy.
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
  -- Guard A — every target table must already carry the scaffolded policy.
  -- Forcing RLS on a policy-less table denies ALL access to it.
  SELECT string_agg(t, ', ')
    INTO v_missing_policies
    FROM unnest(v_tables) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation_policy'
   );
  IF v_missing_policies IS NOT NULL THEN
    RAISE EXCEPTION 'RLS cutover aborted [Guard A]: tenant_isolation_policy missing on: %. Apply the 20260619123000_tenant_rls_policy_scaffold migration first.', v_missing_policies;
  END IF;

  -- Guard B (B4) — the applying role must survive FORCE RLS for cross-tenant
  -- reads. adminPrisma/TimerSweep connect as this same admin role.
  SELECT rolsuper OR rolbypassrls INTO v_can_bypass FROM pg_roles WHERE rolname = current_user;
  IF NOT COALESCE(v_can_bypass, false) THEN
    RAISE EXCEPTION 'RLS cutover aborted [Guard B / B4]: role "%" is neither SUPERUSER nor BYPASSRLS. Under FORCE RLS, TimerSweep''s cross-tenant discovery (adminPrisma, same role) would silently stop firing platform-wide. Fix: ALTER ROLE "%" BYPASSRLS; then re-run. Only comment out this guard if adminPrisma is separately wired to a verified bypass-capable role.', current_user, current_user;
  END IF;

  -- Guard C (B3 / Decision C) — tenant-less instances vanish at cutover.
  SELECT count(*) INTO v_null_tenant_instances
    FROM public.workflow_instances WHERE "tenantId" IS NULL;
  IF v_null_tenant_instances > 0 THEN
    RAISE EXCEPTION 'RLS cutover aborted [Guard C / B3]: % workflow_instances row(s) have tenantId IS NULL (trigger-spawned). They and all their child rows become invisible to every reader at cutover. Backfill tenantId or resolve the trigger-tenant gap first.', v_null_tenant_instances;
  END IF;

  -- Guard D (B2) — as of the tenantId-column work (migration
  -- 20260701120000_add_tenant_id_to_standalone_tables + the tenantId-OR-instance
  -- policy), a standalone row is representable AS LONG AS it carries a direct
  -- tenantId. So the hazard is now only rows with BOTH instanceId AND tenantId
  -- NULL — those satisfy neither branch of the policy and would be frozen. The
  -- write paths (tasks/agents/laptop/ToolGateway) now stamp tenantId on new
  -- standalone rows; this guard catches any PRE-EXISTING un-tenanted standalone
  -- data at rest. (Data-at-rest only — it can't see code paths.)
  FOREACH v_tbl IN ARRAY v_nullable_instance_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE "instanceId" IS NULL AND "tenantId" IS NULL', v_tbl) INTO v_cnt;
    IF v_cnt > 0 THEN
      v_orphan_report := v_orphan_report || format('%s=%s ', v_tbl, v_cnt);
    END IF;
  END LOOP;
  IF length(v_orphan_report) > 0 THEN
    RAISE EXCEPTION 'RLS cutover aborted [Guard D / B2]: rows with BOTH instanceId AND tenantId NULL exist (%). These satisfy neither branch of the tenantId-OR-instance policy and would be frozen/invisible. Backfill tenantId on these pre-existing standalone rows (from their originating actor/capability) before cutover.', trim(v_orphan_report);
  END IF;

  RAISE NOTICE 'RLS cutover preflight passed (policies present; applying role can bypass; no NULL-tenant instances; no NULL-instance standalone rows). Proceeding with ENABLE/FORCE on % tables.', array_length(v_tables, 1);
END
$preflight$;

-- ----------------------------------------------------------------------------
-- ENABLE + FORCE ROW LEVEL SECURITY on the 16 scaffolded tables.
-- ----------------------------------------------------------------------------
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

COMMIT;

-- ============================================================================
-- ROLLBACK — if anything looks wrong after applying, run the block below
-- immediately via the same admin connection. `NO FORCE` alone is enough if the
-- symptom is adminPrisma/TimerSweep losing cross-tenant visibility (B4); use
-- the full `DISABLE` block if the app role's own reads/writes are failing
-- (e.g. a tenant-less or NULL-instance row legitimately needs to be seen).
-- Wrapped in its own transaction so rollback is also all-or-nothing.
-- ============================================================================

-- BEGIN;
-- ALTER TABLE public.workflow_instances         NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.run_snapshots              NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_run_budgets       NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_run_budget_events NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_phases            NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_nodes             NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_edges             NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_mutations         NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_events            NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.tasks                      NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.approval_requests          NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.consumables                NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.agent_runs                 NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.tool_runs                  NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.documents                  NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE public.pending_executions         NO FORCE ROW LEVEL SECURITY;
-- COMMIT;

-- BEGIN;
-- ALTER TABLE public.workflow_instances         DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.run_snapshots              DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_run_budgets       DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_run_budget_events DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_phases            DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_nodes             DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_edges             DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_mutations         DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.workflow_events            DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.tasks                      DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.approval_requests          DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.consumables                DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.agent_runs                 DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.tool_runs                  DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.documents                  DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pending_executions         DISABLE ROW LEVEL SECURITY;
-- COMMIT;
