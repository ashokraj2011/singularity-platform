-- Singularity demo seed — workgraph DB (`workgraph`)
--
-- Idempotent. Apply with:
--   psql -d workgraph -f seed/02-workgraph.sql
--
-- Lands an IAM-mirrored CCRE Team + a 3-node "Demo Workflow" template so
-- /runs and /play/new have something to launch.

BEGIN;

-- ── IAM Team mirror ───────────────────────────────────────────────────────
INSERT INTO teams
  (id, name, description, "externalIamTeamId", "externalTeamKey", source, "createdAt", "updatedAt")
VALUES
  ('89c22760-c5b6-4ec8-9443-d90cbfc80bc1',
   'Parent Team',
   'Mirrored from IAM seed; source of truth is iam.teams.',
   '89c22760-c5b6-4ec8-9443-d90cbfc80bc1',
   'parent-team',
   'IAM',
   now(), now()),
  ('a479bfcd-cc76-4fb7-9d1d-6edeebe0b8c3',
   'Child Team',
   'Mirrored from IAM seed; source of truth is iam.teams.',
   'a479bfcd-cc76-4fb7-9d1d-6edeebe0b8c3',
   'child-team',
   'IAM',
   now(), now()),
  ('e5baadba-d9a0-4b4f-8cca-dbff34f72d76',
   'CCRE team',
   'Mirrored from IAM seed; source of truth is iam.teams.',
   'e5baadba-d9a0-4b4f-8cca-dbff34f72d76',
   'ccre',
   'IAM',
   now(), now())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  "externalIamTeamId" = EXCLUDED."externalIamTeamId",
  "externalTeamKey" = EXCLUDED."externalTeamKey",
  source = EXCLUDED.source,
  "updatedAt" = now();

-- ── Default Workflow template ────────────────────────────────────────────
INSERT INTO workflow_templates
  (id, name, description, status, "currentVersion", "teamId", "capabilityId",
   variables, "budgetPolicy", "createdAt", "updatedAt")
VALUES (
  '30000000-0000-0000-0000-000000000001',
  'Demo Workflow',
  'Start → Human Review → End. Use this as the first run from /runs to walk through the demo path.',
  'ACTIVE', 1,
  'e5baadba-d9a0-4b4f-8cca-dbff34f72d76',
  '11111111-2222-3333-4444-555555555555',
  '[{"key":"summary","label":"Summary","type":"STRING","scope":"INPUT","defaultValue":""}]'::jsonb,
  '{
    "warnAtPercent": 80,
    "maxInputTokens": 100000,
    "maxOutputTokens": 25000,
    "maxTotalTokens": 125000,
    "maxEstimatedCost": null,
    "enforcementMode": "PAUSE_FOR_APPROVAL",
    "nodeTypeDefaults": {
      "AGENT_TASK": {
        "maxContextTokens": 6000,
        "inputTokenBudget": 6000,
        "outputTokenBudget": 1200,
        "maxOutputTokens": 1200
      },
      "WORKBENCH_TASK": {
        "maxContextTokens": 6000,
        "inputTokenBudget": 6000,
        "outputTokenBudget": 1200,
        "maxOutputTokens": 1200
      }
    }
  }'::jsonb,
  now(), now()
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  status = EXCLUDED.status,
  "teamId" = EXCLUDED."teamId",
  "capabilityId" = EXCLUDED."capabilityId",
  "budgetPolicy" = EXCLUDED."budgetPolicy",
  "updatedAt" = now();

-- ── Design phase ──────────────────────────────────────────────────────────
INSERT INTO workflow_design_phases (id, "workflowId", name, "displayOrder", color, "createdAt")
VALUES (
  '40000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'Main',
  0,
  '#0ea5e9',
  now()
)
ON CONFLICT (id) DO NOTHING;

-- ── Design nodes ──────────────────────────────────────────────────────────
INSERT INTO workflow_design_nodes
  (id, "workflowId", "phaseId", "nodeType", label, config, "executionLocation", "positionX", "positionY", "createdAt", "updatedAt")
VALUES
  ('41000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001',
   'START', 'Start', '{}'::jsonb, 'SERVER', 100, 200, now(), now()),
  ('41000000-0000-0000-0000-000000000002',
   '30000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001',
   'HUMAN_TASK', 'Human Review',
   '{"description":"Review the inputs and mark this complete to advance.","assignmentMode":"TEAM_QUEUE","teamId":"e5baadba-d9a0-4b4f-8cca-dbff34f72d76","widgets":[]}'::jsonb,
   'CLIENT', 400, 200, now(), now()),
  ('41000000-0000-0000-0000-000000000003',
   '30000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001',
   'END', 'End', '{}'::jsonb, 'SERVER', 700, 200, now(), now())
ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, config = EXCLUDED.config, "updatedAt" = now();

-- ── Design edges ──────────────────────────────────────────────────────────
INSERT INTO workflow_design_edges
  (id, "workflowId", "sourceNodeId", "targetNodeId", "edgeType", "createdAt")
VALUES
  ('42000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001',
   '41000000-0000-0000-0000-000000000001',
   '41000000-0000-0000-0000-000000000002',
   'SEQUENTIAL', now()),
  ('42000000-0000-0000-0000-000000000002',
   '30000000-0000-0000-0000-000000000001',
   '41000000-0000-0000-0000-000000000002',
   '41000000-0000-0000-0000-000000000003',
   'SEQUENTIAL', now())
ON CONFLICT (id) DO NOTHING;

COMMIT;

SELECT 'teams'                  AS table, COUNT(*) FROM teams
UNION ALL SELECT 'workflow_templates',     COUNT(*) FROM workflow_templates
UNION ALL SELECT 'workflow_design_nodes',  COUNT(*) FROM workflow_design_nodes
UNION ALL SELECT 'workflow_design_edges',  COUNT(*) FROM workflow_design_edges;
