-- M96 — Completion fan-out: a work item can auto-execute a Work Program when it finalizes,
-- spawning the next stage of work items (each bound to a workflow). The program is resolved
-- from the item first, then its project.

-- New Work Item timeline events for the fan-out (idempotent; not referenced in this tx).
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'NEXT_STAGE_SPAWNED';
ALTER TYPE "WorkItemEventType" ADD VALUE IF NOT EXISTS 'NEXT_STAGE_SPAWN_FAILED';

-- Per-item attached program.
ALTER TABLE "work_items" ADD COLUMN IF NOT EXISTS "completionProgramId" TEXT;
ALTER TABLE "work_items"
  ADD CONSTRAINT "work_items_completionProgramId_fkey"
  FOREIGN KEY ("completionProgramId") REFERENCES "work_programs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "ix_work_items_completion_program"
  ON "work_items"("completionProgramId");

-- Project-level default program (fallback when the item has none).
ALTER TABLE "specification_projects" ADD COLUMN IF NOT EXISTS "completionProgramId" TEXT;
ALTER TABLE "specification_projects"
  ADD CONSTRAINT "specification_projects_completionProgramId_fkey"
  FOREIGN KEY ("completionProgramId") REFERENCES "work_programs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "ix_specification_projects_completion_program"
  ON "specification_projects"("completionProgramId");
