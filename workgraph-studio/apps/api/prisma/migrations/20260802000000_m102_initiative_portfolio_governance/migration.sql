-- M102: initiative portfolio governance and capability impact assessments.

DO $$ BEGIN
  CREATE TYPE "ProjectCapabilityRole" AS ENUM ('PRIMARY', 'IMPACTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ImpactAssessmentStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "specification_projects"
  ADD COLUMN IF NOT EXISTS "primaryCapabilityId" TEXT,
  ADD COLUMN IF NOT EXISTS "primaryCapabilityName" TEXT,
  ADD COLUMN IF NOT EXISTS "tokenBudget" INTEGER NOT NULL DEFAULT 250000,
  ADD COLUMN IF NOT EXISTS "tokenUsed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "costBudgetUsd" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "costUsedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "businessValue" INTEGER,
  ADD COLUMN IF NOT EXISTS "customerImpact" INTEGER,
  ADD COLUMN IF NOT EXISTS "strategicAlignment" INTEGER,
  ADD COLUMN IF NOT EXISTS "urgency" INTEGER,
  ADD COLUMN IF NOT EXISTS "deliveryRisk" INTEGER,
  ADD COLUMN IF NOT EXISTS "technicalRisk" INTEGER,
  ADD COLUMN IF NOT EXISTS "regulatoryRisk" INTEGER,
  ADD COLUMN IF NOT EXISTS "confidence" INTEGER,
  ADD COLUMN IF NOT EXISTS "effort" INTEGER,
  ADD COLUMN IF NOT EXISTS "targetDate" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewCadenceDays" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS "lastReviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sponsorId" TEXT,
  ADD COLUMN IF NOT EXISTS "productOwnerId" TEXT,
  ADD COLUMN IF NOT EXISTS "successMetrics" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS "specification_project_capabilities" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "capabilityId" TEXT NOT NULL,
  "capabilityName" TEXT,
  "role" "ProjectCapabilityRole" NOT NULL DEFAULT 'IMPACTED',
  "impactArea" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "specification_project_capabilities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "specification_project_capabilities_projectId_capabilityId_key"
  ON "specification_project_capabilities"("projectId", "capabilityId");
CREATE INDEX IF NOT EXISTS "specification_project_capabilities_capabilityId_role_idx"
  ON "specification_project_capabilities"("capabilityId", "role");
CREATE INDEX IF NOT EXISTS "ix_specification_project_capabilities_tenant"
  ON "specification_project_capabilities"("tenantId");

CREATE TABLE IF NOT EXISTS "capability_impact_assessments" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "capabilityId" TEXT NOT NULL,
  "capabilityName" TEXT,
  "agentTemplateId" TEXT,
  "agentTemplateName" TEXT,
  "status" "ImpactAssessmentStatus" NOT NULL DEFAULT 'PENDING',
  "summary" TEXT,
  "recommendations" JSONB NOT NULL DEFAULT '[]',
  "risks" JSONB NOT NULL DEFAULT '[]',
  "dependencies" JSONB NOT NULL DEFAULT '[]',
  "suggestedClaims" JSONB NOT NULL DEFAULT '[]',
  "traceId" TEXT,
  "tokensUsed" INTEGER NOT NULL DEFAULT 0,
  "estimatedCostUsd" DOUBLE PRECISION,
  "error" TEXT,
  "assessedAt" TIMESTAMP(3),
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capability_impact_assessments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "capability_impact_assessments_projectId_capabilityId_key"
  ON "capability_impact_assessments"("projectId", "capabilityId");
CREATE INDEX IF NOT EXISTS "capability_impact_assessments_status_updatedAt_idx"
  ON "capability_impact_assessments"("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "ix_capability_impact_assessments_tenant"
  ON "capability_impact_assessments"("tenantId");

DO $$ BEGIN
  ALTER TABLE "specification_project_capabilities"
    ADD CONSTRAINT "specification_project_capabilities_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "capability_impact_assessments"
    ADD CONSTRAINT "capability_impact_assessments_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.workgraph_install_tenant_policy(table_name text, predicate text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = table_name AND policyname = 'tenant_isolation_policy'
  ) THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON public.%I FOR ALL USING (%s) WITH CHECK (%s)',
      table_name, predicate, predicate
    );
  END IF;
END;
$$;

SELECT public.workgraph_install_tenant_policy('specification_project_capabilities', '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('capability_impact_assessments', '"tenantId" = public.workgraph_current_tenant_id()');

DROP FUNCTION public.workgraph_install_tenant_policy(text, text);

ALTER TABLE public.specification_project_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capability_impact_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.specification_project_capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE public.capability_impact_assessments FORCE ROW LEVEL SECURITY;
