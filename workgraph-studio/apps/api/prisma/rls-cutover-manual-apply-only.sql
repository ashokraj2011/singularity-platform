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
-- #300, #301, #302, #303) exists solely to make running this file safe.
--
-- ----------------------------------------------------------------------------
-- PRE-FLIGHT CHECKLIST — do not run this file until every item is checked.
-- ----------------------------------------------------------------------------
--
-- [ ] 1. PRs #297-#303 have been live in production long enough to be
--        trusted. (Scope: WorkflowRuntime's cron/dispatch path + all
--        router-invoked lifecycle ops; TimerSweep + TriggerScheduler;
--        budget.ts + cloneDesignToRun.ts; the 5 blocking gate executors; all
--        20 node executors. Full detail in
--        ~/.claude/plans/lexical-brewing-sky.md and this repo's PR history.)
--
-- [ ] 2. GAP 1 — Trigger-spawned instances have tenantId: NULL. `Workflow`
--        and `WorkflowTrigger` have no tenant column, so
--        TriggerScheduler.spawnInstance() creates every scheduled/
--        event-triggered WorkflowInstance with tenantId = NULL. The
--        fail-closed RLS policy (workgraph_current_tenant_id() is NULL when
--        app.tenant_id is unset, and NULL "tenantId" never satisfies
--        "tenantId" = <anything>, even another NULL) makes these instances
--        INVISIBLE to every reader — including the engine itself — the
--        moment this file is applied.
--        CONSEQUENCE IF UNRESOLVED: all scheduled/event-triggered workflow
--        automation silently stops advancing (looks like the scheduler died;
--        it didn't — its rows just vanished from every RLS-filtered query).
--        RESOLVE BEFORE APPLYING if any production workflow template uses a
--        WorkflowTrigger: either add a tenant column to
--        Workflow/WorkflowTrigger and backfill it, or add an IAM
--        capability→tenant resolution call to TriggerScheduler.
--        Confirmed not addressed as of PR #303 (2026-07-01) — an explicit,
--        deliberate deferral (Decision C in the plan), not an oversight.
--
-- [ ] 3. GAP 2 — lib/admin-prisma.ts's adminPrisma (used only by
--        TimerSweep's cross-tenant TIMER/SLA discovery reads) connects via
--        WORKGRAPH_DATABASE_URL_ADMIN — the OWNER/admin DB role
--        (bootstrap-app-role.sh's ADMIN_USER, default `workgraph`), chosen
--        specifically so that role can see rows across every tenant.
--        FORCE ROW LEVEL SECURITY (below) makes RLS apply even to the table
--        OWNER — UNLESS that role is a genuine Postgres superuser, in which
--        case Postgres exempts it unconditionally regardless of FORCE.
--          - Local Docker dev (role provisioned via POSTGRES_USER in the
--            official postgres image) is typically a real superuser — FORCE
--            is a no-op for it there, adminPrisma keeps working unchanged.
--          - Many MANAGED Postgres services (AWS RDS, GCP Cloud SQL, etc.)
--            do NOT grant true SUPERUSER to their "admin" role — only
--            elevated-but-not-superuser privileges.
--        CONSEQUENCE IF THE PRODUCTION ADMIN ROLE IS NOT A REAL SUPERUSER:
--        TimerSweep's cross-tenant discovery queries silently become
--        tenant-filtered (that connection never sets app.tenant_id, so the
--        fail-closed policy returns zero rows) — TIMER nodes and Task SLA
--        sweeps silently stop firing, platform-wide, for every tenant.
--        BEFORE APPLYING in any non-local-Docker environment, run this
--        against the WORKGRAPH_DATABASE_URL_ADMIN connection:
--            SELECT rolname, rolsuper FROM pg_roles WHERE rolname = current_user;
--        If rolsuper is false: either run
--            ALTER ROLE <that_role> BYPASSRLS;
--        first, or do not apply this file until that's resolved.
--
-- [ ] 4. GAP 3 — SignalEmitExecutor's cross-instance signal broadcast
--        (PR #303) was deliberately narrowed to same-tenant delivery only —
--        a cross-tenant broadcast was judged to be a data-isolation gap, not
--        a feature worth preserving via adminPrisma. If any production
--        workflow relies on SIGNAL_EMIT waking a SIGNAL_WAIT node in a
--        DIFFERENT tenant's instance, that stops working at this cutover.
--        Confirmed not the case as of PR #303 — re-verify if new workflow
--        templates have shipped since.
--
-- [ ] 5. TENANT_ISOLATION_MODE and every other deploy-env flag are what you
--        expect in the target environment (bin/check-deploy-env.sh enforces
--        `strict` as the production expectation; confirm this migration's
--        target matches).
--
-- [ ] 6. A fresh backup/snapshot has been taken immediately before running
--        this file.
--
-- [ ] 7. The rollback block at the bottom of this file has been read and is
--        ready to run immediately if anything looks wrong after applying.
--
-- HOW TO APPLY (only after every box above is checked):
--     psql "$WORKGRAPH_DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 \
--       -f prisma/rls-cutover-manual-apply-only.sql
--
-- ============================================================================

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

-- ============================================================================
-- ROLLBACK — if anything looks wrong after applying, run the block below
-- immediately via the same admin connection. `NO FORCE` alone is enough if
-- the symptom is adminPrisma/TimerSweep losing cross-tenant visibility (GAP
-- 2); use the full `DISABLE` block if workgraph_app's own reads/writes are
-- failing (e.g. a tenant-less row exists and legitimately needs to be seen).
-- ============================================================================

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
