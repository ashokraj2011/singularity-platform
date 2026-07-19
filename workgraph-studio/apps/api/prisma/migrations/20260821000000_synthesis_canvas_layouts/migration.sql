-- Synthesis Strategy Canvas — per-user personal layout for the Idea Board. The board's notes are
-- DERIVED from a project's claims/probes; this table only stores each user's personal arrangement
-- on top of that projection (sticky position overrides, free-form text/shape/pen/image annotations,
-- and the last viewport). Keyed by (projectId, userId) so one person's rearrangement is private and
-- never moves anyone else's board. Plain DDL — matches the m86–m93 migrate-deploy pattern.

CREATE TABLE IF NOT EXISTS "synthesis_canvas_layouts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "positions" JSONB NOT NULL DEFAULT '{}',
    "objects" JSONB NOT NULL DEFAULT '[]',
    "viewport" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "synthesis_canvas_layouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "synthesis_canvas_layouts_projectId_userId_key"
    ON "synthesis_canvas_layouts"("projectId", "userId");
CREATE INDEX IF NOT EXISTS "synthesis_canvas_layouts_projectId_idx"
    ON "synthesis_canvas_layouts"("projectId");
CREATE INDEX IF NOT EXISTS "ix_synthesis_canvas_layouts_tenant"
    ON "synthesis_canvas_layouts"("tenantId");

DO $$ BEGIN
    ALTER TABLE "synthesis_canvas_layouts"
        ADD CONSTRAINT "synthesis_canvas_layouts_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
