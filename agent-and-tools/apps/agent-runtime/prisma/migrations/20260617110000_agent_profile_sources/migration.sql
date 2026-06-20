ALTER TABLE "AgentTemplate"
  ADD COLUMN IF NOT EXISTS "instructions" TEXT;

CREATE TABLE IF NOT EXISTS "AgentSkillSource" (
  "id" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceRef" TEXT,
  "capabilityId" TEXT,
  "permissions" JSONB NOT NULL DEFAULT '["read"]',
  "readOnly" BOOLEAN NOT NULL DEFAULT true,
  "providerLocked" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AgentSkillSource_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentSkillSource_skillId_fkey'
  ) THEN
    ALTER TABLE "AgentSkillSource"
      ADD CONSTRAINT "AgentSkillSource_skillId_fkey"
      FOREIGN KEY ("skillId") REFERENCES "AgentSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AgentSkillSource_skillId_idx" ON "AgentSkillSource"("skillId");
CREATE INDEX IF NOT EXISTS "AgentSkillSource_sourceType_sourceRef_idx" ON "AgentSkillSource"("sourceType", "sourceRef");
CREATE INDEX IF NOT EXISTS "AgentSkillSource_capabilityId_idx" ON "AgentSkillSource"("capabilityId");

ALTER TABLE "AgentTemplateSkill"
  ADD COLUMN IF NOT EXISTS "sourceType" TEXT NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS "sourceRef" TEXT,
  ADD COLUMN IF NOT EXISTS "capabilityId" TEXT,
  ADD COLUMN IF NOT EXISTS "permissions" JSONB NOT NULL DEFAULT '["read", "invoke"]',
  ADD COLUMN IF NOT EXISTS "readOnly" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "providerLocked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "AgentTemplateSkill_sourceType_sourceRef_idx" ON "AgentTemplateSkill"("sourceType", "sourceRef");
CREATE INDEX IF NOT EXISTS "AgentTemplateSkill_capabilityId_idx" ON "AgentTemplateSkill"("capabilityId");
