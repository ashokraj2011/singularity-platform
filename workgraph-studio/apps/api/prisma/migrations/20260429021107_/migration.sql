/*
  Warnings:

  - A unique constraint covering the columns `[toolId,idempotencyKey]` on the table `tool_runs` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "WorkflowPermissionAction" AS ENUM ('VIEW', 'EDIT', 'START', 'ADMIN');

-- CreateEnum
CREATE TYPE "TriggerType" AS ENUM ('WEBHOOK', 'SCHEDULE', 'EVENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NodeType" ADD VALUE 'TIMER';
ALTER TYPE "NodeType" ADD VALUE 'SIGNAL_WAIT';
ALTER TYPE "NodeType" ADD VALUE 'CALL_WORKFLOW';
ALTER TYPE "NodeType" ADD VALUE 'FOREACH';
ALTER TYPE "NodeType" ADD VALUE 'INCLUSIVE_GATEWAY';
ALTER TYPE "NodeType" ADD VALUE 'EVENT_GATEWAY';
ALTER TYPE "NodeType" ADD VALUE 'CUSTOM';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "formData" JSONB,
ADD COLUMN     "formSchema" JSONB;

-- AlterTable
ALTER TABLE "tool_runs" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "workflow_instances" ADD COLUMN     "parentInstanceId" TEXT,
ADD COLUMN     "parentNodeId" TEXT;

-- AlterTable
ALTER TABLE "workflow_nodes" ADD COLUMN     "compensationConfig" JSONB;

-- CreateTable
CREATE TABLE "workflow_permissions" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "action" "WorkflowPermissionAction" NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_triggers" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "type" "TriggerType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_node_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "icon" TEXT NOT NULL DEFAULT 'Box',
    "baseType" TEXT NOT NULL DEFAULT 'HUMAN_TASK',
    "fields" JSONB NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_node_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_permissions_templateId_roleId_action_key" ON "workflow_permissions"("templateId", "roleId", "action");

-- CreateIndex
CREATE INDEX "workflow_triggers_type_isActive_idx" ON "workflow_triggers"("type", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "custom_node_types_name_key" ON "custom_node_types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "tool_runs_toolId_idempotencyKey_key" ON "tool_runs"("toolId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "workflow_permissions" ADD CONSTRAINT "workflow_permissions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_parentInstanceId_fkey" FOREIGN KEY ("parentInstanceId") REFERENCES "workflow_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
