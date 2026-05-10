-- CreateEnum
CREATE TYPE "BlueprintSourceType" AS ENUM ('GITHUB', 'LOCALDIR');

-- CreateEnum
CREATE TYPE "BlueprintSessionStatus" AS ENUM ('DRAFT', 'SNAPSHOTTED', 'RUNNING', 'COMPLETED', 'APPROVED', 'FAILED');

-- CreateEnum
CREATE TYPE "BlueprintStage" AS ENUM ('ARCHITECT', 'DEVELOPER', 'QA');

-- CreateEnum
CREATE TYPE "BlueprintStageStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "blueprint_sessions" (
    "id" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "sourceType" "BlueprintSourceType" NOT NULL,
    "sourceUri" TEXT NOT NULL,
    "sourceRef" TEXT,
    "includeGlobs" JSONB NOT NULL DEFAULT '[]',
    "excludeGlobs" JSONB NOT NULL DEFAULT '[]',
    "capabilityId" TEXT NOT NULL,
    "architectAgentTemplateId" TEXT NOT NULL,
    "developerAgentTemplateId" TEXT NOT NULL,
    "qaAgentTemplateId" TEXT NOT NULL,
    "status" "BlueprintSessionStatus" NOT NULL DEFAULT 'DRAFT',
    "workflowInstanceId" TEXT,
    "phaseId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blueprint_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_source_snapshots" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "manifest" JSONB NOT NULL DEFAULT '[]',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" INTEGER NOT NULL DEFAULT 0,
    "rootHash" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blueprint_source_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_stage_runs" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "stage" "BlueprintStage" NOT NULL,
    "status" "BlueprintStageStatus" NOT NULL DEFAULT 'PENDING',
    "task" TEXT NOT NULL,
    "response" TEXT,
    "error" TEXT,
    "correlation" JSONB,
    "tokensUsed" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blueprint_stage_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprint_artifacts" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "stage" "BlueprintStage",
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blueprint_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blueprint_sessions_capabilityId_idx" ON "blueprint_sessions"("capabilityId");

-- CreateIndex
CREATE INDEX "blueprint_sessions_createdById_idx" ON "blueprint_sessions"("createdById");

-- CreateIndex
CREATE INDEX "blueprint_sessions_status_idx" ON "blueprint_sessions"("status");

-- CreateIndex
CREATE INDEX "blueprint_source_snapshots_sessionId_idx" ON "blueprint_source_snapshots"("sessionId");

-- CreateIndex
CREATE INDEX "blueprint_stage_runs_sessionId_stage_idx" ON "blueprint_stage_runs"("sessionId", "stage");

-- CreateIndex
CREATE INDEX "blueprint_artifacts_sessionId_idx" ON "blueprint_artifacts"("sessionId");

-- CreateIndex
CREATE INDEX "blueprint_artifacts_kind_idx" ON "blueprint_artifacts"("kind");

-- AddForeignKey
ALTER TABLE "blueprint_source_snapshots" ADD CONSTRAINT "blueprint_source_snapshots_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "blueprint_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_stage_runs" ADD CONSTRAINT "blueprint_stage_runs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "blueprint_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blueprint_artifacts" ADD CONSTRAINT "blueprint_artifacts_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "blueprint_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
