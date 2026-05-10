-- CreateEnum
CREATE TYPE "ExecutionLocation" AS ENUM ('SERVER', 'CLIENT', 'EDGE', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ConnectorType" AS ENUM ('HTTP', 'EMAIL', 'TEAMS', 'SLACK', 'JIRA', 'GIT', 'CONFLUENCE', 'DATADOG', 'SERVICENOW', 'LLM_GATEWAY', 'S3', 'POSTGRES');

-- AlterEnum
ALTER TYPE "NodeType" ADD VALUE 'DATA_SINK';

-- AlterTable
ALTER TABLE "workflow_instances" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "templateVersion" INTEGER;

-- AlterTable
ALTER TABLE "workflow_nodes" ADD COLUMN     "executionLocation" "ExecutionLocation" NOT NULL DEFAULT 'SERVER';

-- AlterTable
ALTER TABLE "workflow_templates" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "connectors" (
    "id" TEXT NOT NULL,
    "type" "ConnectorType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "credentials" JSONB NOT NULL DEFAULT '{}',
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_executions" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "location" "ExecutionLocation" NOT NULL,
    "claimToken" TEXT NOT NULL,
    "payload" JSONB,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "result" JSONB,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_executions_claimToken_key" ON "pending_executions"("claimToken");

-- CreateIndex
CREATE INDEX "pending_executions_instanceId_completedAt_idx" ON "pending_executions"("instanceId", "completedAt");

-- CreateIndex
CREATE INDEX "pending_executions_location_completedAt_expiresAt_idx" ON "pending_executions"("location", "completedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "pending_executions" ADD CONSTRAINT "pending_executions_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "workflow_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_executions" ADD CONSTRAINT "pending_executions_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "workflow_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
