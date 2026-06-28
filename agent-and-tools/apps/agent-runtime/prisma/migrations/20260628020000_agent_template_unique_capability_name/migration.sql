-- [P0] No silent duplicate agent profiles: a profile name is unique within a
-- capability. Nullable capabilityId ⇒ common-library templates (NULL) stay
-- unconstrained (Postgres treats NULLs as distinct). IF NOT EXISTS keeps it
-- idempotent for the bare-metal `prisma db push` path.
CREATE UNIQUE INDEX IF NOT EXISTS "AgentTemplate_capabilityId_name_key" ON "AgentTemplate" ("capabilityId", "name");
