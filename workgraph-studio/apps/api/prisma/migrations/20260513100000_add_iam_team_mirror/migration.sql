ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "externalIamTeamId" TEXT;
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "externalTeamKey" TEXT;
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'LOCAL';

CREATE UNIQUE INDEX IF NOT EXISTS "teams_externalIamTeamId_key"
  ON "teams"("externalIamTeamId");

CREATE INDEX IF NOT EXISTS "teams_externalTeamKey_idx" ON "teams"("externalTeamKey");
CREATE INDEX IF NOT EXISTS "teams_source_idx" ON "teams"("source");
