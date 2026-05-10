-- CreateTable
CREATE TABLE "artifact_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'DELIVERABLE',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "sections" JSONB NOT NULL DEFAULT '[]',
    "parties" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB,
    "createdById" TEXT NOT NULL,
    "teamName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artifact_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artifact_templates_type_idx" ON "artifact_templates"("type");

-- CreateIndex
CREATE INDEX "artifact_templates_status_idx" ON "artifact_templates"("status");
