-- Singularity demo seed — one capability per demo user (IAM DB `singularity_iam`).
--
-- Apply AFTER seed/04-demo-users.sql (the user1..user10 accounts must exist).
-- Idempotent. Gives each demo user their OWN capability so multi-tenant
-- isolation is visible in the context picker: user1 → "User 1 Workspace"
-- (capability_id 'demo-u1'), user2 → 'demo-u2', … each owned + admin'd by that
-- user only. (They also keep the shared ccre/default-demo memberships from 04.)

BEGIN;

SET search_path = iam, public;

DO $$
DECLARE
  cap_admin_role_id uuid;
  bu_id       uuid := '60000000-0000-0000-0000-000000000001';   -- seeded business unit
  owner_team  uuid := 'e5baadba-d9a0-4b4f-8cca-dbff34f72d76';    -- seeded owner team
  i int;
  uid uuid;
  cap_key text;
BEGIN
  SELECT id INTO cap_admin_role_id FROM roles WHERE role_key = 'capability_admin' LIMIT 1;

  FOR i IN 1..10 LOOP
    uid := NULL;
    SELECT id INTO uid FROM users WHERE email = 'user' || i || '@singularity.local' LIMIT 1;
    CONTINUE WHEN uid IS NULL;

    cap_key := 'demo-u' || i;

    -- the per-user capability, created_by = the user
    INSERT INTO capabilities
      (id, capability_id, name, description, capability_type, status, visibility,
       owner_bu_id, owner_team_id, metadata, tags, created_by, created_at, updated_at)
    VALUES
      (gen_random_uuid(), cap_key, 'User ' || i || ' Workspace',
       'Per-user demo capability owned by user' || i || ' — multi-tenant isolation.',
       'application_capability', 'active', 'private',
       bu_id, owner_team, '{"seed":"demo-user-capabilities"}'::jsonb, '["demo","per-user"]'::jsonb,
       uid, now(), now())
    ON CONFLICT (capability_id) DO UPDATE SET
      name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now();

    -- the user owns + admins their own capability
    IF cap_admin_role_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM capability_memberships
      WHERE capability_id = cap_key AND user_id = uid AND role_id = cap_admin_role_id
    ) THEN
      INSERT INTO capability_memberships
        (id, capability_id, user_id, team_id, role_id, status, granted_by, valid_from, metadata, created_at)
      VALUES
        (gen_random_uuid(), cap_key, uid, NULL, cap_admin_role_id, 'active', uid, now(),
         '{"seed":"demo-user-capabilities"}'::jsonb, now());
    END IF;
  END LOOP;

  RAISE NOTICE 'seeded 10 per-user capabilities (demo-u1..demo-u10)';
END$$;

COMMIT;
