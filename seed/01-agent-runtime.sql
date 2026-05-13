-- Singularity demo seed — agent-runtime DB (`singularity`)
--
-- Idempotent: ON CONFLICT DO NOTHING / DO UPDATE everywhere.
--   psql -d singularity -f seed/01-agent-runtime.sql
--
-- Lands the Agent Studio governance baseline:
--   • 2 Capabilities (Default Demo + CCRE)
--   • 4 PromptLayers (platform + 4 role contracts) + 4 PromptProfiles
--   • 4 locked common AgentTemplate baselines (ARCHITECT / DEVELOPER / QA / GOVERNANCE)
--   • Capability bindings so capability detail pages show usable agents
--   • 4 ToolDefinitions (always-on demo toolkit)
--
-- Re-run any time. To wipe + reset:
--   TRUNCATE "AgentTemplate","PromptProfileLayer","PromptProfile","PromptLayer","Capability","ToolDefinition" CASCADE;
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

-- ── PromptLayers ─────────────────────────────────────────────────────────
-- Platform constitution (applies to every prompt)
INSERT INTO "PromptLayer" (id, name, "layerType", "scopeType", content, priority, "isRequired", status, "createdAt", "updatedAt")
VALUES (
  '00000000-0000-0000-0000-000000000a01',
  'Platform Constitution',
  'PLATFORM_CONSTITUTION', 'PLATFORM',
  'You are an agent operating inside the Singularity governed agent platform. Every action is audited. Refuse requests that bypass governance gates. Stay within your role contract.',
  10, true, 'ACTIVE', now(), now()
) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, "updatedAt" = now();

-- Output contract (applies to every prompt)
INSERT INTO "PromptLayer" (id, name, "layerType", "scopeType", content, priority, "isRequired", status, "createdAt", "updatedAt")
VALUES (
  '00000000-0000-0000-0000-000000000a02',
  'Output Contract',
  'OUTPUT_CONTRACT', 'PLATFORM',
  'Return clear, structured output. Mark uncertain claims explicitly. Cite the tool calls or knowledge artifacts you relied on.',
  950, true, 'ACTIVE', now(), now()
) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, "updatedAt" = now();

-- Role contracts (layerType = AGENT_ROLE — the enum value the DB uses)
INSERT INTO "PromptLayer" (id, name, "layerType", "scopeType", content, priority, "isRequired", status, "createdAt", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-000000000c01', 'Architect Role Contract',
   'AGENT_ROLE', 'AGENT_TEMPLATE',
   'You are an Architect Agent. Analyze design, dependencies, risks, and tradeoffs. Never approve or deploy your own recommendations.',
   100, false, 'ACTIVE', now(), now()),
  ('00000000-0000-0000-0000-000000000c02', 'Developer Role Contract',
   'AGENT_ROLE', 'AGENT_TEMPLATE',
   'You are a Developer Agent. Implement changes safely, write code with tests, prefer small reversible steps.',
   100, false, 'ACTIVE', now(), now()),
  ('00000000-0000-0000-0000-000000000c03', 'QA Role Contract',
   'AGENT_ROLE', 'AGENT_TEMPLATE',
   'You are a QA Agent. Identify regressions, edge cases, performance risks, and missing test coverage.',
   100, false, 'ACTIVE', now(), now()),
  ('00000000-0000-0000-0000-000000000c04', 'Governance Role Contract',
   'AGENT_ROLE', 'AGENT_TEMPLATE',
   'You are a Governance Agent. Verify approvals, audits, security, and compliance. You can block release.',
   100, false, 'ACTIVE', now(), now())
ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, "updatedAt" = now();

-- ── PromptProfiles (one per role baseline) ────────────────────────────────
INSERT INTO "PromptProfile" (id, name, description, "ownerScopeType", status, "createdAt", "updatedAt")
VALUES
  ('00000000-0000-0000-0000-0000000000b1', 'ARCHITECT Base Prompt Profile',
   'Base prompt profile for generic architect agents.', 'AGENT_TEMPLATE', 'ACTIVE', now(), now()),
  ('00000000-0000-0000-0000-0000000000b2', 'DEVELOPER Base Prompt Profile',
   'Base prompt profile for generic developer agents.', 'AGENT_TEMPLATE', 'ACTIVE', now(), now()),
  ('00000000-0000-0000-0000-0000000000b3', 'QA Base Prompt Profile',
   'Base prompt profile for generic QA agents.', 'AGENT_TEMPLATE', 'ACTIVE', now(), now()),
  ('00000000-0000-0000-0000-0000000000b4', 'GOVERNANCE Base Prompt Profile',
   'Base prompt profile for generic governance agents.', 'AGENT_TEMPLATE', 'ACTIVE', now(), now())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "updatedAt" = now();

-- ── PromptProfileLayer (link layers to each profile) ──────────────────────
-- Each profile gets: platform constitution (priority 10) + role contract (100) + output contract (950)
DO $$
DECLARE
  pair RECORD;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000a01', 10),
      ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000c01', 100),
      ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000a02', 950),
      ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000a01', 10),
      ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000c02', 100),
      ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000a02', 950),
      ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-000000000a01', 10),
      ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-000000000c03', 100),
      ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-000000000a02', 950),
      ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-000000000a01', 10),
      ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-000000000c04', 100),
      ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-000000000a02', 950)
    ) AS t(profile_id, layer_id, prio)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM "PromptProfileLayer"
      WHERE "promptProfileId" = pair.profile_id AND "promptLayerId" = pair.layer_id
    ) THEN
      INSERT INTO "PromptProfileLayer" (id, "promptProfileId", "promptLayerId", priority, "isEnabled", "createdAt")
      VALUES (gen_random_uuid(), pair.profile_id, pair.layer_id, pair.prio, true, now());
    END IF;
  END LOOP;
END$$;

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
UNION ALL SELECT 'PromptProfile',      COUNT(*) FROM "PromptProfile"
UNION ALL SELECT 'PromptLayer',        COUNT(*) FROM "PromptLayer"
UNION ALL SELECT 'PromptProfileLayer', COUNT(*) FROM "PromptProfileLayer"
UNION ALL SELECT 'AgentCapabilityBinding', COUNT(*) FROM "AgentCapabilityBinding"
UNION ALL SELECT 'ToolDefinition',     COUNT(*) FROM "ToolDefinition"
UNION ALL SELECT 'Capability',         COUNT(*) FROM "Capability";
