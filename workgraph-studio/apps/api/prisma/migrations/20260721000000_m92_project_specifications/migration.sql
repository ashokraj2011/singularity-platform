-- M92: Project Specification — the project's shared upstream (analysis + design), one editable
-- package per Specification Project. Work Item specs still live in specification_versions; this
-- is the project-level layer above them.

CREATE TABLE IF NOT EXISTS "project_specifications" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "package" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_specifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_specifications_projectId_key" ON "project_specifications"("projectId");
CREATE INDEX IF NOT EXISTS "ix_project_specifications_tenant" ON "project_specifications"("tenantId");

DO $$ BEGIN
    ALTER TABLE "project_specifications"
        ADD CONSTRAINT "project_specifications_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
