-- AlterTable
ALTER TABLE "workflow_templates" ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'DRAFT';

-- CreateIndex
CREATE INDEX "workflow_templates_status_idx" ON "workflow_templates"("status");
