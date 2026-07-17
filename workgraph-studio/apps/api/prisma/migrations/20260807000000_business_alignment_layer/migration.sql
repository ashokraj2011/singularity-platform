-- Workstream D: objective-to-evidence traceability, sponsor consent, milestones,
-- composed risks, consequence-priced change control, and external taxonomy export.

ALTER TYPE "ChangeControlStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "ChangeControlStatus" ADD VALUE IF NOT EXISTS 'SPONSOR_REVIEW';

CREATE TYPE "BusinessObjectiveStatus" AS ENUM ('ACTIVE', 'ACHIEVED_DECLARED', 'DROPPED', 'DEFERRED');
CREATE TYPE "BusinessMilestoneStatus" AS ENUM ('PLANNED', 'AT_RISK', 'LATE', 'DELIVERED');
CREATE TYPE "BusinessReadoutKind" AS ENUM ('SPONSOR', 'WEEKLY');
CREATE TYPE "BusinessReadoutStatus" AS ENUM ('DRAFT', 'PENDING_SPONSOR', 'SIGNED', 'SUPERSEDED');
CREATE TYPE "BusinessRiskStatus" AS ENUM ('OPEN', 'MITIGATING', 'ACCEPTED', 'CLOSED');

CREATE TABLE "business_objectives" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'default',
  "studioProjectId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "targetMetric" JSONB NOT NULL DEFAULT '{}',
  "valueScore" INTEGER NOT NULL DEFAULT 1,
  "valueRationale" TEXT,
  "budgetLineRef" TEXT,
  "period" JSONB NOT NULL DEFAULT '{}',
  "status" "BusinessObjectiveStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "business_objectives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_objectives_studioProjectId_fkey" FOREIGN KEY ("studioProjectId") REFERENCES "specification_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "business_objectives_valueScore_check" CHECK ("valueScore" BETWEEN 1 AND 5)
);
CREATE INDEX "business_objectives_tenantId_status_idx" ON "business_objectives"("tenantId", "status");
CREATE INDEX "business_objectives_studioProjectId_idx" ON "business_objectives"("studioProjectId");

CREATE TABLE "business_objective_projects" (
  "id" TEXT NOT NULL,
  "objectiveId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'default',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_objective_projects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_objective_projects_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "business_objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "business_objective_projects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "business_objective_projects_objectiveId_projectId_key" ON "business_objective_projects"("objectiveId", "projectId");
CREATE INDEX "business_objective_projects_tenantId_projectId_idx" ON "business_objective_projects"("tenantId", "projectId");

CREATE TABLE "business_milestones" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'default',
  "studioProjectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "valueStatement" TEXT NOT NULL,
  "targetDate" TIMESTAMP(3) NOT NULL,
  "completionDefinition" JSONB NOT NULL DEFAULT '{}',
  "status" "BusinessMilestoneStatus" NOT NULL DEFAULT 'PLANNED',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "business_milestones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_milestones_studioProjectId_fkey" FOREIGN KEY ("studioProjectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "business_milestones_tenantId_studioProjectId_idx" ON "business_milestones"("tenantId", "studioProjectId");
CREATE INDEX "business_milestones_targetDate_status_idx" ON "business_milestones"("targetDate", "status");

CREATE TABLE "business_readouts" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'default',
  "studioProjectId" TEXT NOT NULL,
  "objectiveId" TEXT,
  "specificationVersionId" TEXT,
  "kind" "BusinessReadoutKind" NOT NULL,
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "content" JSONB NOT NULL DEFAULT '{}',
  "citations" JSONB NOT NULL DEFAULT '[]',
  "renderedMarkdown" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "status" "BusinessReadoutStatus" NOT NULL DEFAULT 'DRAFT',
  "sponsorApprovalId" TEXT,
  "generatedById" TEXT,
  "signedAt" TIMESTAMP(3),
  "supersedesId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "business_readouts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_readouts_studioProjectId_fkey" FOREIGN KEY ("studioProjectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "business_readouts_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "business_objectives"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "business_readouts_specificationVersionId_fkey" FOREIGN KEY ("specificationVersionId") REFERENCES "specification_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "business_readouts_studioProjectId_contentHash_kind_key" ON "business_readouts"("studioProjectId", "contentHash", "kind");
CREATE INDEX "business_readouts_tenantId_studioProjectId_kind_status_idx" ON "business_readouts"("tenantId", "studioProjectId", "kind", "status");
CREATE INDEX "business_readouts_objectiveId_createdAt_idx" ON "business_readouts"("objectiveId", "createdAt");

CREATE TABLE "business_risks" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'default',
  "studioProjectId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "ownerId" TEXT,
  "mitigation" TEXT,
  "severity" INTEGER NOT NULL DEFAULT 3,
  "status" "BusinessRiskStatus" NOT NULL DEFAULT 'OPEN',
  "sourceHref" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "business_risks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_risks_studioProjectId_fkey" FOREIGN KEY ("studioProjectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "business_risks_severity_check" CHECK ("severity" BETWEEN 1 AND 5)
);
CREATE UNIQUE INDEX "business_risks_studioProjectId_sourceType_sourceId_key" ON "business_risks"("studioProjectId", "sourceType", "sourceId");
CREATE INDEX "business_risks_tenantId_studioProjectId_status_severity_idx" ON "business_risks"("tenantId", "studioProjectId", "status", "severity");

CREATE TABLE "external_taxonomy_mappings" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'default',
  "studioProjectId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "externalSystem" TEXT NOT NULL,
  "externalType" TEXT NOT NULL,
  "externalLabel" TEXT,
  "costCenterRef" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "external_taxonomy_mappings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_taxonomy_mappings_studioProjectId_fkey" FOREIGN KEY ("studioProjectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "external_taxonomy_mappings_tenantId_externalSystem_entityType_entityId_key" ON "external_taxonomy_mappings"("tenantId", "externalSystem", "entityType", "entityId");
CREATE INDEX "external_taxonomy_mappings_studioProjectId_externalSystem_idx" ON "external_taxonomy_mappings"("studioProjectId", "externalSystem");

ALTER TABLE "generation_plan_rows"
  ADD COLUMN "objectiveValueScore" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "milestoneId" TEXT;
ALTER TABLE "generation_plan_rows"
  ADD CONSTRAINT "generation_plan_rows_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "business_milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "generation_plan_rows_milestoneId_idx" ON "generation_plan_rows"("milestoneId");

ALTER TABLE "specification_change_requests"
  ADD COLUMN "requirementDeltas" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "costDelta" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "scheduleDelta" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "milestoneImpacts" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "sponsorApprovalId" TEXT,
  ADD COLUMN "readoutId" TEXT,
  ADD COLUMN "resultingVersionId" TEXT;

ALTER TABLE "approval_requests" ADD COLUMN "approvedContentHash" TEXT;

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

CREATE POLICY "tenant_isolation_policy" ON "business_objectives"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
CREATE POLICY "tenant_isolation_policy" ON "business_objective_projects"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
CREATE POLICY "tenant_isolation_policy" ON "business_milestones"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
CREATE POLICY "tenant_isolation_policy" ON "business_readouts"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
CREATE POLICY "tenant_isolation_policy" ON "business_risks"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
CREATE POLICY "tenant_isolation_policy" ON "external_taxonomy_mappings"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
