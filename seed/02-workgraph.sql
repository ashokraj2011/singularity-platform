-- Singularity demo seed — workgraph DB (`workgraph`)
--
-- Idempotent. Apply with:
--   psql -d workgraph -f seed/02-workgraph.sql
--
-- Lands a "Default" Team + a 3-node "Demo Workflow" template so /runs and
-- /play/new have something to launch.

BEGIN;

-- ── Default Team ──────────────────────────────────────────────────────────
INSERT INTO teams (id, name, description, "createdAt", "updatedAt")
VALUES (
  '50000000-0000-0000-0000-000000000001',
  'Default Demo Team',
  'Pre-seeded team for the Singularity demo path.',
  now(), now()
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "updatedAt" = now();

-- ── Default Workflow template ────────────────────────────────────────────
INSERT INTO workflow_templates
  (id, name, description, status, "currentVersion", "teamId", "capabilityId", variables, "createdAt", "updatedAt")
VALUES (
  '30000000-0000-0000-0000-000000000001',
  'Demo Workflow',
  'Start → Human Review → End. Use this as the first run from /runs to walk through the demo path.',
  'ACTIVE', 1,
  '50000000-0000-0000-0000-000000000001',
  '11111111-2222-3333-4444-555555555555',
  '[{"key":"summary","label":"Summary","type":"STRING","scope":"INPUT","defaultValue":""}]'::jsonb,
  now(), now()
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, "updatedAt" = now();

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
   '{"description":"Review the inputs and mark this complete to advance.","assignmentMode":"TEAM_QUEUE","teamId":"50000000-0000-0000-0000-000000000001","widgets":[]}'::jsonb,
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
