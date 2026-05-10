-- M10 — agent / tool tables become snapshots of agent-and-tools entities.
-- New nullable columns + unique indexes; no data migration needed.

ALTER TABLE "agents"
  ADD COLUMN "externalTemplateId" TEXT,
  ADD COLUMN "externalSyncedAt"   TIMESTAMP(3);
CREATE UNIQUE INDEX "agents_externalTemplateId_key" ON "agents"("externalTemplateId");

ALTER TABLE "tools"
  ADD COLUMN "externalToolName"   TEXT,
  ADD COLUMN "externalVersion"    TEXT,
  ADD COLUMN "externalSyncedAt"   TIMESTAMP(3);
CREATE UNIQUE INDEX "tools_externalToolName_key" ON "tools"("externalToolName");
