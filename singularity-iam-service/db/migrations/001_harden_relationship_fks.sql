-- ─────────────────────────────────────────────────────────────────────────────
-- Harden the user ↔ team ↔ role ↔ capability referential integrity.
--
-- ⚠️  WRITTEN, NOT APPLIED.  Review, then run under supervision against the IAM
--     database:   psql "$IAM_DATABASE_URL" -f 001_harden_relationship_fks.sql
--
-- WHY: several relationship tables reference users/teams/roles/capabilities with
-- NO `ON DELETE` rule, so deleting a user/team/role/BU/capability leaves orphaned
-- rows that point at something that no longer exists. The strong relations
-- (team_memberships, platform_role_assignments, role_permissions) already CASCADE
-- correctly and are intentionally left untouched.
--
-- WHAT this does, per table:
--   • capability_memberships → CASCADE on user/team/role (a membership is
--     meaningless once its subject or role is gone).
--   • capability_relationships / capability_sharing_grants / governance_attachments
--     → CASCADE on the capability_id string FKs (edges die with the capability).
--   • teams.bu_id, capabilities.owner_bu_id/owner_team_id → SET NULL (keep the row,
--     just drop the dangling ownership pointer).
--
-- Idempotent: each FK is dropped-if-exists then re-added, so this is safe to re-run.
-- Constraint names follow Postgres/SQLAlchemy defaults ({table}_{column}_fkey); if
-- your DB used different names, adjust the DROPs (the ADDs are what matter).
--
-- BEFORE running, inspect existing orphans with the SELECTs at the bottom — a
-- CASCADE constraint can only be added once the data is already consistent.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── capability_memberships: capability / user / team / role → CASCADE ────────
ALTER TABLE iam.capability_memberships DROP CONSTRAINT IF EXISTS capability_memberships_capability_id_fkey;
ALTER TABLE iam.capability_memberships ADD  CONSTRAINT capability_memberships_capability_id_fkey
  FOREIGN KEY (capability_id) REFERENCES iam.capabilities(capability_id) ON DELETE CASCADE;

ALTER TABLE iam.capability_memberships DROP CONSTRAINT IF EXISTS capability_memberships_user_id_fkey;
ALTER TABLE iam.capability_memberships ADD  CONSTRAINT capability_memberships_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES iam.users(id) ON DELETE CASCADE;

ALTER TABLE iam.capability_memberships DROP CONSTRAINT IF EXISTS capability_memberships_team_id_fkey;
ALTER TABLE iam.capability_memberships ADD  CONSTRAINT capability_memberships_team_id_fkey
  FOREIGN KEY (team_id) REFERENCES iam.teams(id) ON DELETE CASCADE;

ALTER TABLE iam.capability_memberships DROP CONSTRAINT IF EXISTS capability_memberships_role_id_fkey;
ALTER TABLE iam.capability_memberships ADD  CONSTRAINT capability_memberships_role_id_fkey
  FOREIGN KEY (role_id) REFERENCES iam.roles(id) ON DELETE CASCADE;

-- ── capability_relationships: both endpoints → CASCADE ───────────────────────
ALTER TABLE iam.capability_relationships DROP CONSTRAINT IF EXISTS capability_relationships_source_capability_id_fkey;
ALTER TABLE iam.capability_relationships ADD  CONSTRAINT capability_relationships_source_capability_id_fkey
  FOREIGN KEY (source_capability_id) REFERENCES iam.capabilities(capability_id) ON DELETE CASCADE;

ALTER TABLE iam.capability_relationships DROP CONSTRAINT IF EXISTS capability_relationships_target_capability_id_fkey;
ALTER TABLE iam.capability_relationships ADD  CONSTRAINT capability_relationships_target_capability_id_fkey
  FOREIGN KEY (target_capability_id) REFERENCES iam.capabilities(capability_id) ON DELETE CASCADE;

-- ── capability_sharing_grants: provider / consumer → CASCADE ─────────────────
ALTER TABLE iam.capability_sharing_grants DROP CONSTRAINT IF EXISTS capability_sharing_grants_provider_capability_id_fkey;
ALTER TABLE iam.capability_sharing_grants ADD  CONSTRAINT capability_sharing_grants_provider_capability_id_fkey
  FOREIGN KEY (provider_capability_id) REFERENCES iam.capabilities(capability_id) ON DELETE CASCADE;

ALTER TABLE iam.capability_sharing_grants DROP CONSTRAINT IF EXISTS capability_sharing_grants_consumer_capability_id_fkey;
ALTER TABLE iam.capability_sharing_grants ADD  CONSTRAINT capability_sharing_grants_consumer_capability_id_fkey
  FOREIGN KEY (consumer_capability_id) REFERENCES iam.capabilities(capability_id) ON DELETE CASCADE;

-- ── governance_attachments: governed + governing capability → CASCADE ────────
ALTER TABLE iam.governance_attachments DROP CONSTRAINT IF EXISTS governance_attachments_capability_id_fkey;
ALTER TABLE iam.governance_attachments ADD  CONSTRAINT governance_attachments_capability_id_fkey
  FOREIGN KEY (capability_id) REFERENCES iam.capabilities(capability_id) ON DELETE CASCADE;

ALTER TABLE iam.governance_attachments DROP CONSTRAINT IF EXISTS governance_attachments_governing_capability_id_fkey;
ALTER TABLE iam.governance_attachments ADD  CONSTRAINT governance_attachments_governing_capability_id_fkey
  FOREIGN KEY (governing_capability_id) REFERENCES iam.capabilities(capability_id) ON DELETE CASCADE;

-- ── ownership pointers: keep the row, null the pointer → SET NULL ────────────
ALTER TABLE iam.teams DROP CONSTRAINT IF EXISTS teams_bu_id_fkey;
ALTER TABLE iam.teams ADD  CONSTRAINT teams_bu_id_fkey
  FOREIGN KEY (bu_id) REFERENCES iam.business_units(id) ON DELETE SET NULL;

ALTER TABLE iam.capabilities DROP CONSTRAINT IF EXISTS capabilities_owner_bu_id_fkey;
ALTER TABLE iam.capabilities ADD  CONSTRAINT capabilities_owner_bu_id_fkey
  FOREIGN KEY (owner_bu_id) REFERENCES iam.business_units(id) ON DELETE SET NULL;

ALTER TABLE iam.capabilities DROP CONSTRAINT IF EXISTS capabilities_owner_team_id_fkey;
ALTER TABLE iam.capabilities ADD  CONSTRAINT capabilities_owner_team_id_fkey
  FOREIGN KEY (owner_team_id) REFERENCES iam.teams(id) ON DELETE SET NULL;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRE-FLIGHT ORPHAN CHECK — run these SELECTs FIRST (before the BEGIN above).
-- If any return > 0, the ADD CONSTRAINT will fail until you resolve/delete them.
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT count(*) AS orphan_memberships_user FROM iam.capability_memberships cm
--   LEFT JOIN iam.users u ON u.id = cm.user_id WHERE cm.user_id IS NOT NULL AND u.id IS NULL;
-- SELECT count(*) AS orphan_memberships_team FROM iam.capability_memberships cm
--   LEFT JOIN iam.teams t ON t.id = cm.team_id WHERE cm.team_id IS NOT NULL AND t.id IS NULL;
-- SELECT count(*) AS orphan_rel_source FROM iam.capability_relationships r
--   LEFT JOIN iam.capabilities c ON c.capability_id = r.source_capability_id WHERE c.capability_id IS NULL;
-- SELECT count(*) AS orphan_grants_provider FROM iam.capability_sharing_grants g
--   LEFT JOIN iam.capabilities c ON c.capability_id = g.provider_capability_id WHERE c.capability_id IS NULL;
