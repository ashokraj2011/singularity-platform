-- Step 1: add the column as nullable so we can backfill safely
ALTER TABLE "workflow_templates" ADD COLUMN "teamId" TEXT;

-- Step 2: backfill from the creator's team (users.teamId)
UPDATE "workflow_templates" wt
SET "teamId" = u."teamId"
FROM "users" u
WHERE wt."createdById" = u."id" AND u."teamId" IS NOT NULL;

-- Step 3: any rows still null (no creator, or creator has no team) — assign a synthesized "Default" team
DO $$
DECLARE
  default_team_id TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM "workflow_templates" WHERE "teamId" IS NULL) THEN
    SELECT "id" INTO default_team_id FROM "teams" WHERE "name" = 'Default' LIMIT 1;
    IF default_team_id IS NULL THEN
      default_team_id := gen_random_uuid()::text;
      INSERT INTO "teams" ("id", "name", "description", "createdAt", "updatedAt")
      VALUES (default_team_id, 'Default', 'Auto-created for migrated workflow templates', NOW(), NOW());
    END IF;
    UPDATE "workflow_templates" SET "teamId" = default_team_id WHERE "teamId" IS NULL;
  END IF;
END $$;

-- Step 4: enforce NOT NULL now that every row has a value
ALTER TABLE "workflow_templates" ALTER COLUMN "teamId" SET NOT NULL;

-- Step 5: index + FK
CREATE INDEX "workflow_templates_teamId_idx" ON "workflow_templates"("teamId");
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
