-- Bare-metal uses `prisma db push`, which creates the declarative tables but
-- cannot install raw RLS policy SQL or the migration-only check constraints.
-- Keep this migration idempotent so both `prisma migrate deploy` and the
-- bare-metal post-push hardening pass enforce the same database boundary.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'business_objectives_valueScore_check'
  ) THEN
    ALTER TABLE "business_objectives"
      ADD CONSTRAINT "business_objectives_valueScore_check"
      CHECK ("valueScore" BETWEEN 1 AND 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'business_risks_severity_check'
  ) THEN
    ALTER TABLE "business_risks"
      ADD CONSTRAINT "business_risks_severity_check"
      CHECK ("severity" BETWEEN 1 AND 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attention_items_score_check'
  ) THEN
    ALTER TABLE "attention_items"
      ADD CONSTRAINT "attention_items_score_check"
      CHECK (
        "stakes" BETWEEN 0 AND 5
        AND "uncertainty" BETWEEN 0 AND 5
        AND "urgency" BETWEEN 0 AND 5
        AND "priority" >= 0
      );
  END IF;
END
$$;

ALTER TABLE "business_objectives" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_objectives" FORCE ROW LEVEL SECURITY;
ALTER TABLE "business_objective_projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_objective_projects" FORCE ROW LEVEL SECURITY;
ALTER TABLE "business_milestones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_milestones" FORCE ROW LEVEL SECURITY;
ALTER TABLE "business_readouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_readouts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "business_risks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_risks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "external_taxonomy_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_taxonomy_mappings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "attention_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attention_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "artifact_validation_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "artifact_validation_reports" FORCE ROW LEVEL SECURITY;
ALTER TABLE "artifact_validation_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "artifact_validation_sources" FORCE ROW LEVEL SECURITY;
ALTER TABLE "boards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "boards" FORCE ROW LEVEL SECURITY;
ALTER TABLE "board_branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_branches" FORCE ROW LEVEL SECURITY;
ALTER TABLE "board_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "board_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_snapshots" FORCE ROW LEVEL SECURITY;
ALTER TABLE "board_moments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "board_moments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ingested_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingested_artifacts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_verdicts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_verdicts" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "business_objectives";
CREATE POLICY "tenant_isolation_policy" ON "business_objectives"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "business_objective_projects";
CREATE POLICY "tenant_isolation_policy" ON "business_objective_projects"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "business_milestones";
CREATE POLICY "tenant_isolation_policy" ON "business_milestones"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "business_readouts";
CREATE POLICY "tenant_isolation_policy" ON "business_readouts"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "business_risks";
CREATE POLICY "tenant_isolation_policy" ON "business_risks"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "external_taxonomy_mappings";
CREATE POLICY "tenant_isolation_policy" ON "external_taxonomy_mappings"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "attention_items";
CREATE POLICY "tenant_isolation_policy" ON "attention_items"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "artifact_validation_reports";
CREATE POLICY "tenant_isolation_policy" ON "artifact_validation_reports"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "artifact_validation_sources";
CREATE POLICY "tenant_isolation_policy" ON "artifact_validation_sources"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "boards";
CREATE POLICY "tenant_isolation_policy" ON "boards"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "board_branches";
CREATE POLICY "tenant_isolation_policy" ON "board_branches"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "board_events";
CREATE POLICY "tenant_isolation_policy" ON "board_events"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "board_snapshots";
CREATE POLICY "tenant_isolation_policy" ON "board_snapshots"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "board_moments";
CREATE POLICY "tenant_isolation_policy" ON "board_moments"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "ingested_artifacts";
CREATE POLICY "tenant_isolation_policy" ON "ingested_artifacts"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());

DROP POLICY IF EXISTS "tenant_isolation_policy" ON "agent_verdicts";
CREATE POLICY "tenant_isolation_policy" ON "agent_verdicts"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
