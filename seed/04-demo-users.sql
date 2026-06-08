-- Singularity demo seed — 10 local users (IAM DB `singularity_iam`).
--
-- Apply AFTER singularity-iam-service has started once (so iam.* tables +
-- default roles + the admin user exist) and AFTER seed/00-iam.sql (teams +
-- capabilities). Idempotent — safe to re-run.
--
-- Creates user1@singularity.local … user10@singularity.local, each:
--   • a local credential with password  Admin1234!  (same as admin, for testing)
--   • capability_admin on capabilities 'ccre' and 'default-demo'
--   • a member of the seeded owner team (if present)
--
-- The password hash is bcrypt('Admin1234!') — passlib-compatible (the scheme
-- singularity-iam-service/app/auth/password.py uses). Any valid bcrypt hash of
-- the password verifies, so reusing one hash for all 10 is fine.

BEGIN;

SET search_path = iam, public;

DO $$
DECLARE
  cap_admin_role_id uuid;
  team_id_owner uuid := 'e5baadba-d9a0-4b4f-8cca-dbff34f72d76';
  pw_hash text := '$2b$12$sVtv9vs5mrHvUfQqAXVqAehz8Cilb3uAAHSbPoBw0wPjurALKSKoy'; -- bcrypt('Admin1234!')
  caps text[] := ARRAY['ccre', 'default-demo'];
  cap_key text;
  i int;
  uid uuid;
  uemail text;
BEGIN
  SELECT id INTO cap_admin_role_id FROM roles WHERE role_key = 'capability_admin' LIMIT 1;

  FOR i IN 1..10 LOOP
    uemail := 'user' || i || '@singularity.local';

    -- user (idempotent on email)
    SELECT id INTO uid FROM users WHERE email = uemail LIMIT 1;
    IF uid IS NULL THEN
      uid := gen_random_uuid();
      INSERT INTO users
        (id, email, display_name, status, auth_provider, is_super_admin, is_local_account, metadata, tags, created_at, updated_at)
      VALUES
        (uid, uemail, 'Demo User ' || i, 'active', 'local', false, true,
         '{"seed":"demo-users"}'::jsonb, '[]'::jsonb, now(), now());
    END IF;

    -- local credential (password = Admin1234!)
    INSERT INTO local_credentials (user_id, password_hash, mfa_enabled, created_at)
    VALUES (uid, pw_hash, false, now())
    ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

    -- owner-team membership (only if that team exists)
    IF EXISTS (SELECT 1 FROM teams WHERE id = team_id_owner) THEN
      INSERT INTO team_memberships (id, team_id, user_id, membership_type, created_at)
      VALUES (gen_random_uuid(), team_id_owner, uid, 'member', now())
      ON CONFLICT (team_id, user_id) DO NOTHING;
    END IF;

    -- capability memberships → a working active-context for each user
    IF cap_admin_role_id IS NOT NULL THEN
      FOREACH cap_key IN ARRAY caps LOOP
        IF EXISTS (SELECT 1 FROM capabilities WHERE capability_id = cap_key)
           AND NOT EXISTS (
             SELECT 1 FROM capability_memberships
             WHERE capability_id = cap_key AND user_id = uid AND role_id = cap_admin_role_id
           ) THEN
          INSERT INTO capability_memberships
            (id, capability_id, user_id, team_id, role_id, status, granted_by, valid_from, metadata, created_at)
          VALUES
            (gen_random_uuid(), cap_key, uid, NULL, cap_admin_role_id, 'active', uid, now(),
             '{"seed":"demo-users"}'::jsonb, now());
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  RAISE NOTICE 'seeded 10 demo users (user1..user10@singularity.local / Admin1234!)';
END$$;

COMMIT;
