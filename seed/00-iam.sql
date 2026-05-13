-- Singularity demo seed - IAM DB (`singularity_iam`)
--
-- Apply after singularity-iam-service has started once so SQLAlchemy has
-- created the iam.* tables and seeded default roles/permissions/admin user.
--
-- Idempotent. Lands canonical teams/capabilities used by Workgraph and
-- agent-and-tools smoke paths.

BEGIN;

SET search_path = iam, public;

-- Business unit used by seeded teams/capabilities.
INSERT INTO business_units
  (id, bu_key, name, description, metadata, tags, created_at, updated_at)
VALUES
  ('60000000-0000-0000-0000-000000000001',
   'platform',
   'Platform',
   'Default platform business unit for local/demo deployments.',
   '{"seed":"singularity"}'::jsonb,
   '["platform"]'::jsonb,
   now(), now())
ON CONFLICT (bu_key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  metadata = business_units.metadata || EXCLUDED.metadata,
  tags = EXCLUDED.tags,
  updated_at = now();

-- IAM is the source of truth for teams. Workgraph mirrors these rows locally.
INSERT INTO teams
  (id, team_key, name, description, bu_id, parent_team_id, metadata, tags, created_at, updated_at)
VALUES
  ('89c22760-c5b6-4ec8-9443-d90cbfc80bc1',
   'parent-team',
   'Parent Team',
   'Seeded parent team for hierarchy and picker smoke tests.',
   '60000000-0000-0000-0000-000000000001',
   NULL,
   '{"seed":"singularity"}'::jsonb,
   '["core"]'::jsonb,
   now(), now()),
  ('a479bfcd-cc76-4fb7-9d1d-6edeebe0b8c3',
   'child-team',
   'Child Team',
   'Seeded child team for hierarchy and picker smoke tests.',
   '60000000-0000-0000-0000-000000000001',
   '89c22760-c5b6-4ec8-9443-d90cbfc80bc1',
   '{"seed":"singularity","lead":"carol"}'::jsonb,
   '["sub","beta"]'::jsonb,
   now(), now()),
  ('e5baadba-d9a0-4b4f-8cca-dbff34f72d76',
   'ccre',
   'CCRE team',
   'Core Common Rule Engine owner team.',
   '60000000-0000-0000-0000-000000000001',
   NULL,
   '{"seed":"singularity"}'::jsonb,
   '["runtime","agentic-delivery"]'::jsonb,
   now(), now())
ON CONFLICT (team_key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  bu_id = EXCLUDED.bu_id,
  parent_team_id = EXCLUDED.parent_team_id,
  metadata = teams.metadata || EXCLUDED.metadata,
  tags = EXCLUDED.tags,
  updated_at = now();

-- Capability identity lives in IAM; runtime knowledge/agents live in
-- agent-and-tools and reference these rows through metadata.
INSERT INTO capabilities
  (id, capability_id, name, description, capability_type, status, visibility,
   owner_bu_id, owner_team_id, metadata, tags, created_by, created_at, updated_at)
SELECT
  '11111111-2222-3333-4444-555555555555',
  'default-demo',
  'Default Demo Capability',
  'Seeded capability used by the demo workflow and common agent smoke paths.',
  'platform_capability',
  'active',
  'private',
  '60000000-0000-0000-0000-000000000001',
  'e5baadba-d9a0-4b4f-8cca-dbff34f72d76',
  '{"seed":"singularity","agentRuntimeCapabilityId":"11111111-2222-3333-4444-555555555555"}'::jsonb,
  '["demo","agentic-delivery"]'::jsonb,
  (SELECT id FROM users WHERE email = 'admin@singularity.local' LIMIT 1),
  now(), now()
ON CONFLICT (capability_id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  capability_type = EXCLUDED.capability_type,
  owner_bu_id = EXCLUDED.owner_bu_id,
  owner_team_id = EXCLUDED.owner_team_id,
  metadata = capabilities.metadata || EXCLUDED.metadata,
  tags = EXCLUDED.tags,
  updated_at = now();

INSERT INTO capabilities
  (id, capability_id, name, description, capability_type, status, visibility,
   owner_bu_id, owner_team_id, metadata, tags, created_by, created_at, updated_at)
SELECT
  'e4ff5b14-743a-46b8-8aab-7409e9b3a7fe',
  'ccre',
  'CCRE',
  'Core Common Rule Engine capability.',
  'platform_capability',
  'active',
  'private',
  '60000000-0000-0000-0000-000000000001',
  'e5baadba-d9a0-4b4f-8cca-dbff34f72d76',
  '{"seed":"singularity","agentRuntimeCapabilityId":"f074c668-a1c5-4090-a86d-0bd9e386f305"}'::jsonb,
  '["rules","runtime"]'::jsonb,
  (SELECT id FROM users WHERE email = 'admin@singularity.local' LIMIT 1),
  now(), now()
ON CONFLICT (capability_id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  capability_type = EXCLUDED.capability_type,
  owner_bu_id = EXCLUDED.owner_bu_id,
  owner_team_id = EXCLUDED.owner_team_id,
  metadata = capabilities.metadata || EXCLUDED.metadata,
  tags = EXCLUDED.tags,
  updated_at = now();

-- Make the default admin immediately useful in team pickers, queue routing,
-- and capability-scoped authz checks.
DO $$
DECLARE
  admin_user_id uuid;
  capability_admin_role_id uuid;
  super_admin_role_id uuid;
  cap_key text;
BEGIN
  SELECT id INTO admin_user_id FROM users WHERE email = 'admin@singularity.local' LIMIT 1;
  SELECT id INTO capability_admin_role_id FROM roles WHERE role_key = 'capability_admin' LIMIT 1;
  SELECT id INTO super_admin_role_id FROM roles WHERE role_key = 'super_admin' LIMIT 1;

  IF admin_user_id IS NOT NULL THEN
    INSERT INTO team_memberships (id, team_id, user_id, membership_type, created_at)
    VALUES (gen_random_uuid(), 'e5baadba-d9a0-4b4f-8cca-dbff34f72d76', admin_user_id, 'owner', now())
    ON CONFLICT (team_id, user_id) DO UPDATE SET membership_type = EXCLUDED.membership_type;

    IF super_admin_role_id IS NOT NULL THEN
      INSERT INTO platform_role_assignments (id, user_id, role_id, granted_by, created_at)
      VALUES (gen_random_uuid(), admin_user_id, super_admin_role_id, admin_user_id, now())
      ON CONFLICT (user_id, role_id) DO NOTHING;
    END IF;

    IF capability_admin_role_id IS NOT NULL THEN
      FOREACH cap_key IN ARRAY ARRAY['default-demo','ccre']
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM capability_memberships
          WHERE capability_id = cap_key
            AND user_id = admin_user_id
            AND role_id = capability_admin_role_id
        ) THEN
          INSERT INTO capability_memberships
            (id, capability_id, user_id, team_id, role_id, status, granted_by, valid_from, metadata, created_at)
          VALUES
            (gen_random_uuid(), cap_key, admin_user_id, NULL, capability_admin_role_id, 'active', admin_user_id, now(),
             '{"seed":"singularity","membership":"admin-user"}'::jsonb, now());
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM capability_memberships
          WHERE capability_id = cap_key
            AND team_id = 'e5baadba-d9a0-4b4f-8cca-dbff34f72d76'
            AND role_id = capability_admin_role_id
        ) THEN
          INSERT INTO capability_memberships
            (id, capability_id, user_id, team_id, role_id, status, granted_by, valid_from, metadata, created_at)
          VALUES
            (gen_random_uuid(), cap_key, NULL, 'e5baadba-d9a0-4b4f-8cca-dbff34f72d76', capability_admin_role_id, 'active',
             admin_user_id, now(), '{"seed":"singularity","membership":"owner-team"}'::jsonb, now());
        END IF;
      END LOOP;
    END IF;
  END IF;
END$$;

-- Demo MCP server registry entry for context-fabric to resolve through IAM.
INSERT INTO mcp_servers
  (id, capability_id, name, description, base_url, auth_method, bearer_token,
   protocol, protocol_version, status, metadata, tags, created_by, created_at, updated_at)
SELECT
  '70000000-0000-0000-0000-000000000001',
  c.id,
  'Local MCP Demo',
  'Local reference MCP server used by bare-metal and local docker smoke tests.',
  'http://localhost:7100',
  'BEARER_TOKEN',
  'demo-bearer-token-must-be-min-16-chars',
  'MCP_HTTP',
  '2025-03-26',
  'active',
  '{"seed":"singularity"}'::jsonb,
  '["local","demo"]'::jsonb,
  (SELECT id FROM users WHERE email = 'admin@singularity.local' LIMIT 1),
  now(), now()
FROM capabilities c
WHERE c.capability_id = 'ccre'
ON CONFLICT ON CONSTRAINT uq_mcp_servers_capability_name DO UPDATE SET
  base_url = EXCLUDED.base_url,
  bearer_token = EXCLUDED.bearer_token,
  status = EXCLUDED.status,
  metadata = mcp_servers.metadata || EXCLUDED.metadata,
  tags = EXCLUDED.tags,
  updated_at = now();

COMMIT;

SELECT 'iam.business_units' AS table, COUNT(*) FROM business_units
UNION ALL SELECT 'iam.teams', COUNT(*) FROM teams
UNION ALL SELECT 'iam.capabilities', COUNT(*) FROM capabilities
UNION ALL SELECT 'iam.team_memberships', COUNT(*) FROM team_memberships
UNION ALL SELECT 'iam.capability_memberships', COUNT(*) FROM capability_memberships
UNION ALL SELECT 'iam.mcp_servers', COUNT(*) FROM mcp_servers;
