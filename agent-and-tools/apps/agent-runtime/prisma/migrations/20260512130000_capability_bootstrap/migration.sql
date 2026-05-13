CREATE TABLE "CapabilityBootstrapRun" (
  "id" TEXT NOT NULL,
  "capabilityId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "sourceSummary" JSONB NOT NULL DEFAULT '{}',
  "generatedAgentIds" JSONB NOT NULL DEFAULT '[]',
  "warnings" JSONB NOT NULL DEFAULT '[]',
  "errors" JSONB NOT NULL DEFAULT '[]',
  "createdBy" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CapabilityBootstrapRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CapabilityLearningCandidate" (
  "id" TEXT NOT NULL,
  "capabilityId" TEXT NOT NULL,
  "bootstrapRunId" TEXT,
  "groupKey" TEXT NOT NULL,
  "groupTitle" TEXT NOT NULL,
  "artifactType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "sourceType" TEXT,
  "sourceRef" TEXT,
  "confidence" DECIMAL(5,2),
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "materializedArtifactId" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CapabilityLearningCandidate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CapabilityBootstrapRun_capabilityId_createdAt_idx"
  ON "CapabilityBootstrapRun"("capabilityId", "createdAt");

CREATE INDEX "CapabilityBootstrapRun_status_createdAt_idx"
  ON "CapabilityBootstrapRun"("status", "createdAt");

CREATE INDEX "CapabilityLearningCandidate_capabilityId_status_idx"
  ON "CapabilityLearningCandidate"("capabilityId", "status");

CREATE INDEX "CapabilityLearningCandidate_bootstrapRunId_groupKey_idx"
  ON "CapabilityLearningCandidate"("bootstrapRunId", "groupKey");

CREATE INDEX "CapabilityLearningCandidate_sourceType_sourceRef_idx"
  ON "CapabilityLearningCandidate"("sourceType", "sourceRef");

ALTER TABLE "CapabilityBootstrapRun"
  ADD CONSTRAINT "CapabilityBootstrapRun_capabilityId_fkey"
  FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CapabilityLearningCandidate"
  ADD CONSTRAINT "CapabilityLearningCandidate_capabilityId_fkey"
  FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CapabilityLearningCandidate"
  ADD CONSTRAINT "CapabilityLearningCandidate_bootstrapRunId_fkey"
  FOREIGN KEY ("bootstrapRunId") REFERENCES "CapabilityBootstrapRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
