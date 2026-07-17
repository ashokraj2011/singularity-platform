-- Master Design v2, Workstream E: one ranked Desk, governed intake/scaffold,
-- cited artifact validation, capability-tagged claims, and morning briefs.

ALTER TYPE "ProjectCapabilityRole" ADD VALUE IF NOT EXISTS 'SUPPORTING';
ALTER TYPE "ProjectCapabilityRole" ADD VALUE IF NOT EXISTS 'CONSUMES';
ALTER TYPE "ProjectCapabilityRole" ADD VALUE IF NOT EXISTS 'PROPOSED';
ALTER TYPE "BusinessReadoutKind" ADD VALUE IF NOT EXISTS 'MORNING';
ALTER TYPE "DiscoveryScopeType" ADD VALUE IF NOT EXISTS 'INITIATIVE';

ALTER TABLE "claims" ADD COLUMN "capabilityId" TEXT;
CREATE INDEX "claims_capabilityId_idx" ON "claims"("capabilityId");

ALTER TABLE "ingested_artifacts" ADD COLUMN "sourceSpans" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "discovery_sessions"
  ADD COLUMN "protocolStage" TEXT DEFAULT 'PROBLEM',
  ADD COLUMN "stageExtracts" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "sessionCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "tokensUsed" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "attention_items" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'default',
  "projectId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "band" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "actionHref" TEXT,
  "stakes" DOUBLE PRECISION NOT NULL,
  "uncertainty" DOUBLE PRECISION NOT NULL,
  "urgency" DOUBLE PRECISION NOT NULL,
  "priority" DOUBLE PRECISION NOT NULL,
  "rankingReason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "assignedToId" TEXT,
  "autoConfirmAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "resolution" TEXT,
  "resolutionNote" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "lastProjectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedById" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "attention_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "attention_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "attention_items_score_check" CHECK ("stakes" BETWEEN 0 AND 5 AND "uncertainty" BETWEEN 0 AND 5 AND "urgency" BETWEEN 0 AND 5 AND "priority" >= 0)
);
CREATE UNIQUE INDEX "attention_items_projectId_sourceType_sourceId_key" ON "attention_items"("projectId", "sourceType", "sourceId");
CREATE INDEX "attention_items_tenantId_projectId_status_priority_idx" ON "attention_items"("tenantId", "projectId", "status", "priority");
CREATE INDEX "attention_items_assignedToId_status_idx" ON "attention_items"("assignedToId", "status");

CREATE TABLE "artifact_validation_reports" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'default',
  "projectId" TEXT NOT NULL,
  "boardId" TEXT NOT NULL,
  "taxonomy" JSONB NOT NULL DEFAULT '[]',
  "findings" JSONB NOT NULL DEFAULT '[]',
  "tensions" JSONB NOT NULL DEFAULT '[]',
  "citations" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'READY',
  "contentHash" TEXT NOT NULL,
  "generatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "artifact_validation_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifact_validation_reports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_validation_reports_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "artifact_validation_reports_boardId_contentHash_key" ON "artifact_validation_reports"("boardId", "contentHash");
CREATE INDEX "artifact_validation_reports_tenantId_projectId_createdAt_idx" ON "artifact_validation_reports"("tenantId", "projectId", "createdAt");

CREATE TABLE "artifact_validation_sources" (
  "id" TEXT NOT NULL,
  "reportId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL DEFAULT 'default',
  CONSTRAINT "artifact_validation_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifact_validation_sources_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "artifact_validation_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_validation_sources_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "ingested_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "artifact_validation_sources_reportId_artifactId_key" ON "artifact_validation_sources"("reportId", "artifactId");
CREATE INDEX "artifact_validation_sources_artifactId_idx" ON "artifact_validation_sources"("artifactId");
CREATE INDEX "artifact_validation_sources_tenantId_idx" ON "artifact_validation_sources"("tenantId");

ALTER TABLE "attention_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attention_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "artifact_validation_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "artifact_validation_reports" FORCE ROW LEVEL SECURITY;
ALTER TABLE "artifact_validation_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "artifact_validation_sources" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_policy" ON "attention_items"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
CREATE POLICY "tenant_isolation_policy" ON "artifact_validation_reports"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
CREATE POLICY "tenant_isolation_policy" ON "artifact_validation_sources"
  USING ("tenantId" = public.workgraph_current_tenant_id())
  WITH CHECK ("tenantId" = public.workgraph_current_tenant_id());
