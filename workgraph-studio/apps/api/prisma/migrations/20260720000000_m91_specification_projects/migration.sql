-- M91: Specification Project — the optional, project-level root of the studio.
-- Groups the shared upstream (analysis → requirements → design) that many Work Items draw on.
-- Work Items reference a project via work_items.projectId but stay standalone-capable
-- (a null projectId is a solo item that keeps its own spec).

DO $$ BEGIN
    CREATE TYPE "SpecificationProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "specification_projects" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mission" TEXT,
    "status" "SpecificationProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "tenantId" TEXT DEFAULT 'default',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "specification_projects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "specification_projects_code_key" ON "specification_projects"("code");
CREATE INDEX IF NOT EXISTS "specification_projects_status_idx" ON "specification_projects"("status");
CREATE INDEX IF NOT EXISTS "ix_specification_projects_tenant" ON "specification_projects"("tenantId");

-- Work Items opt into a project (nullable → standalone-capable).
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "projectId" TEXT;
CREATE INDEX IF NOT EXISTS "ix_work_items_project" ON "work_items"("projectId");

DO $$ BEGIN
    ALTER TABLE "work_items"
        ADD CONSTRAINT "work_items_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
