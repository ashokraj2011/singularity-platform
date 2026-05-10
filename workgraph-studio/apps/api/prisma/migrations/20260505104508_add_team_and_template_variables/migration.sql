-- AlterTable
ALTER TABLE "workflow_templates" ADD COLUMN     "variables" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "team_variables" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "type" TEXT NOT NULL DEFAULT 'STRING',
    "value" JSONB NOT NULL,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_variables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_variables_teamId_idx" ON "team_variables"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "team_variables_teamId_key_key" ON "team_variables"("teamId", "key");

-- AddForeignKey
ALTER TABLE "team_variables" ADD CONSTRAINT "team_variables_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
