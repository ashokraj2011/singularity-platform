-- ─────────────────────────────────────────────────────────────────────────────
-- Variable scope hierarchy + write-mode.
--
-- Adds three columns to `team_variables`:
--
--   visibility        — ORG_GLOBAL | CAPABILITY | WORKFLOW
--                       Cascading read-visibility for the variable.  Default
--                       ORG_GLOBAL keeps existing rows visible to every
--                       workflow (back-compat).
--   visibilityScopeId — capability id or workflow id, or NULL for ORG_GLOBAL.
--   editableBy        — USER | SYSTEM
--                       SYSTEM-tagged variables can be written only by ADMIN
--                       users or by automated system processes.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "team_variables"
  ADD COLUMN "visibility"        TEXT NOT NULL DEFAULT 'ORG_GLOBAL',
  ADD COLUMN "visibilityScopeId" TEXT,
  ADD COLUMN "editableBy"        TEXT NOT NULL DEFAULT 'USER';

CREATE INDEX "team_variables_visibility_visibilityScopeId_idx"
  ON "team_variables"("visibility", "visibilityScopeId");
