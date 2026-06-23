-- Singularity demo seed — agent-runtime DB (`singularity`)
--
-- Idempotent: ON CONFLICT DO NOTHING / DO UPDATE everywhere.
--   psql -d singularity -f seed/01-agent-runtime.sql
--
-- Lands the Agent Studio governance baseline:
--   • 2 Capabilities (Default Demo + CCRE)
--   • 4 locked common AgentTemplate baselines (ARCHITECT / DEVELOPER / QA / GOVERNANCE)
--     that reference Prompt Composer-owned base profile IDs b1-b4
--   • Capability bindings so capability detail pages show usable agents
--   • 4 ToolDefinitions (always-on demo toolkit)
--
-- Re-run any time. To wipe + reset:
--   TRUNCATE "AgentTemplate","AgentCapabilityBinding","Capability","ToolDefinition" CASCADE;
--   \i seed/01-agent-runtime.sql

BEGIN;

-- ── Capability ────────────────────────────────────────────────────────────
INSERT INTO "Capability"
  (id, name, "capabilityType", "businessUnitId", "ownerTeamId", criticality, description, status, "createdAt", "updatedAt")
VALUES
  ('11111111-2222-3333-4444-555555555555',
   'Default Demo Capability',
   'PLATFORM',
   '60000000-0000-0000-0000-000000000001',
   'e5baadba-d9a0-4b4f-8cca-dbff34f72d76',
   'MEDIUM',
   'Pre-seeded capability for the Singularity demo path — used by Agent Studio derivation and the seeded Demo Workflow.',
   'ACTIVE',
   now(), now()),
  ('f074c668-a1c5-4090-a86d-0bd9e386f305',
   'Core Common Rule Engine',
   'APPLICATION',
   '60000000-0000-0000-0000-000000000001',
   'e5baadba-d9a0-4b4f-8cca-dbff34f72d76',
   'HIGH',
   'Rule evaluation engine.',
   'ACTIVE',
   now(), now())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  "capabilityType" = EXCLUDED."capabilityType",
  "businessUnitId" = EXCLUDED."businessUnitId",
  "ownerTeamId" = EXCLUDED."ownerTeamId",
  criticality = EXCLUDED.criticality,
  description = EXCLUDED.description,
  status = EXCLUDED.status,
  "updatedAt" = now();

-- Prompt profiles/layers are owned by prompt-composer in the
-- `singularity_composer` database. The stable IDs below are seeded by
-- agent-and-tools/apps/prompt-composer/prisma/seed.ts and referenced here.

-- ── AgentTemplates — the 4 locked common baselines ────────────────────────
INSERT INTO "AgentTemplate"
  (id, name, "roleType", description, "basePromptProfileId", status, "lockedReason", "capabilityId", "baseTemplateId", "createdAt", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'Architect Agent',
   'ARCHITECT',  'You are an Architect Agent.',  '00000000-0000-0000-0000-0000000000b1',
   'ACTIVE', 'common platform baseline', NULL, NULL, now(), now()),
  ('00000000-0000-0000-0000-0000000000d2', 'Developer Agent',
   'DEVELOPER',  'You are a Developer Agent.',  '00000000-0000-0000-0000-0000000000b2',
   'ACTIVE', 'common platform baseline', NULL, NULL, now(), now()),
  ('00000000-0000-0000-0000-0000000000d3', 'Qa Agent',
   'QA',         'You are a QA Agent.',         '00000000-0000-0000-0000-0000000000b3',
   'ACTIVE', 'common platform baseline', NULL, NULL, now(), now()),
  ('00000000-0000-0000-0000-0000000000d4', 'Governance Agent',
   'GOVERNANCE', 'You are a Governance Agent.', '00000000-0000-0000-0000-0000000000b4',
   'ACTIVE', 'common platform baseline', NULL, NULL, now(), now())
ON CONFLICT (id) DO UPDATE SET
  "lockedReason" = EXCLUDED."lockedReason",
  "basePromptProfileId" = EXCLUDED."basePromptProfileId",
  "updatedAt" = now();

-- ── AgentCapabilityBinding — make seeded capabilities immediately runnable ─
INSERT INTO "AgentCapabilityBinding"
  (id, "agentTemplateId", "capabilityId", "bindingName", "roleInCapability", "promptProfileId", status, "createdAt", "updatedAt")
VALUES
  ('10000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1',
   '11111111-2222-3333-4444-555555555555', 'Demo Architect', 'ARCHITECT',
   '00000000-0000-0000-0000-0000000000b1', 'ACTIVE', now(), now()),
  ('10000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000d2',
   '11111111-2222-3333-4444-555555555555', 'Demo Developer', 'DEVELOPER',
   '00000000-0000-0000-0000-0000000000b2', 'ACTIVE', now(), now()),
  ('10000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000d3',
   '11111111-2222-3333-4444-555555555555', 'Demo QA', 'QA',
   '00000000-0000-0000-0000-0000000000b3', 'ACTIVE', now(), now()),
  ('10000000-0000-0000-0000-0000000001d1', '00000000-0000-0000-0000-0000000000d1',
   'f074c668-a1c5-4090-a86d-0bd9e386f305', 'CCRE Architect', 'ARCHITECT',
   '00000000-0000-0000-0000-0000000000b1', 'ACTIVE', now(), now()),
  ('10000000-0000-0000-0000-0000000001d2', '00000000-0000-0000-0000-0000000000d2',
   'f074c668-a1c5-4090-a86d-0bd9e386f305', 'CCRE Developer', 'DEVELOPER',
   '00000000-0000-0000-0000-0000000000b2', 'ACTIVE', now(), now()),
  ('10000000-0000-0000-0000-0000000001d3', '00000000-0000-0000-0000-0000000000d3',
   'f074c668-a1c5-4090-a86d-0bd9e386f305', 'CCRE QA', 'QA',
   '00000000-0000-0000-0000-0000000000b3', 'ACTIVE', now(), now())
ON CONFLICT (id) DO UPDATE SET
  "bindingName" = EXCLUDED."bindingName",
  "roleInCapability" = EXCLUDED."roleInCapability",
  "promptProfileId" = EXCLUDED."promptProfileId",
  status = EXCLUDED.status,
  "updatedAt" = now();

-- ── ToolDefinitions — the always-on demo toolkit ──────────────────────────
-- (Risk levels + input schemas live on ToolContract — skipped in v0 seed.)
INSERT INTO "ToolDefinition"
  (id, namespace, name, version, description, "toolType", status, "createdAt", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000000e1',
   'repo', 'search', 1, 'Search source code in approved repositories.',
   'CODE_INTELLIGENCE', 'ACTIVE', now(), now()),
  ('00000000-0000-0000-0000-0000000000e2',
   'repo', 'read', 1, 'Read a file from an approved repository.',
   'CODE_INTELLIGENCE', 'ACTIVE', now(), now()),
  ('00000000-0000-0000-0000-0000000000e3',
   'document', 'read', 1, 'Read a knowledge artifact / document.',
   'KNOWLEDGE', 'ACTIVE', now(), now()),
  ('00000000-0000-0000-0000-0000000000e4',
   'deployment', 'execute', 1, 'Execute a deployment to an environment. Requires approval.',
   'DEPLOYMENT', 'ACTIVE', now(), now())
ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description, "updatedAt" = now();

COMMIT;

-- Verify
SELECT 'AgentTemplate'    AS table, COUNT(*) FROM "AgentTemplate"
UNION ALL SELECT 'AgentCapabilityBinding', COUNT(*) FROM "AgentCapabilityBinding"
UNION ALL SELECT 'ToolDefinition',     COUNT(*) FROM "ToolDefinition"
UNION ALL SELECT 'Capability',         COUNT(*) FROM "Capability";
