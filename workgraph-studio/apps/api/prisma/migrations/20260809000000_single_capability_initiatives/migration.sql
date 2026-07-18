-- Synthesis initiatives belong to exactly one platform capability.
--
-- Older roadmap builds allowed a capability relation map (PRIMARY, IMPACTED,
-- SUPPORTING, CONSUMES, PROPOSED). The product model is now simpler: an
-- initiative is owned by one capability, and that capability's agent may assess
-- impact on other capabilities through claims/evidence rather than extra
-- persisted initiative links.

-- Backfill projects that predate the primaryCapabilityId columns. Prefer an
-- existing PRIMARY row; otherwise choose the oldest relation as the assigned
-- capability so legacy data is not silently orphaned.
WITH ranked_links AS (
  SELECT
    spc."projectId",
    spc."capabilityId",
    spc."capabilityName",
    row_number() OVER (
      PARTITION BY spc."projectId"
      ORDER BY
        CASE WHEN spc."role" = 'PRIMARY' THEN 0 ELSE 1 END,
        spc."createdAt" ASC,
        spc."id" ASC
    ) AS rn
  FROM "specification_project_capabilities" spc
)
UPDATE "specification_projects" sp
SET
  "primaryCapabilityId" = ranked_links."capabilityId",
  "primaryCapabilityName" = ranked_links."capabilityName"
FROM ranked_links
WHERE sp."id" = ranked_links."projectId"
  AND ranked_links.rn = 1
  AND sp."primaryCapabilityId" IS NULL;

-- If a legacy project has no capability relation at all, do not guess. The
-- operator must explicitly attach the initiative to one IAM capability before
-- this migration can complete.

UPDATE "specification_projects"
SET "primaryCapabilityName" = "primaryCapabilityId"
WHERE "primaryCapabilityId" IS NOT NULL
  AND NULLIF(TRIM(COALESCE("primaryCapabilityName", '')), '') IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "specification_projects"
    WHERE "primaryCapabilityId" IS NULL
       OR NULLIF(TRIM(COALESCE("primaryCapabilityName", '')), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Every Synthesis initiative must be attached to exactly one active platform capability. Sync/create IAM capabilities, then rerun this migration.';
  END IF;
END $$;

-- Keep only the assigned primary capability link for each initiative.
UPDATE "specification_project_capabilities" spc
SET "role" = 'PRIMARY'
FROM "specification_projects" sp
WHERE spc."projectId" = sp."id"
  AND sp."primaryCapabilityId" IS NOT NULL
  AND spc."capabilityId" = sp."primaryCapabilityId";

DELETE FROM "specification_project_capabilities" spc
USING "specification_projects" sp
WHERE spc."projectId" = sp."id"
  AND (
    sp."primaryCapabilityId" IS NULL
    OR spc."capabilityId" <> sp."primaryCapabilityId"
    OR spc."role" <> 'PRIMARY'
  );

-- Backfill the canonical link for projects that have the primary fields but no
-- relation row. gen_random_uuid() is available from pgcrypto, already required
-- by the platform bootstrap.
INSERT INTO "specification_project_capabilities" (
  "id",
  "projectId",
  "capabilityId",
  "capabilityName",
  "role",
  "tenantId",
  "createdAt"
)
SELECT
  gen_random_uuid()::text,
  sp."id",
  sp."primaryCapabilityId",
  sp."primaryCapabilityName",
  'PRIMARY',
  sp."tenantId",
  now()
FROM "specification_projects" sp
WHERE sp."primaryCapabilityId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "specification_project_capabilities" spc
    WHERE spc."projectId" = sp."id"
  );

-- Drop stale impact assessments that no longer match the assigned capability.
DELETE FROM "capability_impact_assessments" cia
USING "specification_projects" sp
WHERE cia."projectId" = sp."id"
  AND (
    sp."primaryCapabilityId" IS NULL
    OR cia."capabilityId" <> sp."primaryCapabilityId"
  );

-- One project can have at most one persisted capability link, and that link
-- must be the primary link.
ALTER TABLE "specification_project_capabilities"
  ALTER COLUMN "role" SET DEFAULT 'PRIMARY';

ALTER TABLE "specification_projects"
  ALTER COLUMN "primaryCapabilityId" SET NOT NULL,
  ALTER COLUMN "primaryCapabilityName" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_specification_projects_tenant_primary_capability"
  ON "specification_projects" ("tenantId", "primaryCapabilityId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_specification_project_capabilities_primary_only'
  ) THEN
    ALTER TABLE "specification_project_capabilities"
      ADD CONSTRAINT "chk_specification_project_capabilities_primary_only"
      CHECK ("role" = 'PRIMARY');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ux_specification_project_capabilities_one_per_project"
  ON "specification_project_capabilities" ("projectId");

-- Enforce the full invariant at commit time, not only at write-call time:
-- every initiative must have exactly one PRIMARY capability link and that link
-- must match specification_projects.primaryCapabilityId. The trigger is
-- deferrable so normal service updates can change the project row and replace
-- the link row inside the same transaction.
CREATE OR REPLACE FUNCTION public.workgraph_assert_single_capability_initiative(p_project_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  project_record RECORD;
  matching_links integer;
  total_links integer;
BEGIN
  SELECT "id", "tenantId", "primaryCapabilityId"
    INTO project_record
  FROM "specification_projects"
  WHERE "id" = p_project_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer
    INTO total_links
  FROM "specification_project_capabilities"
  WHERE "projectId" = p_project_id;

  SELECT count(*)::integer
    INTO matching_links
  FROM "specification_project_capabilities"
  WHERE "projectId" = p_project_id
    AND "role" = 'PRIMARY'
    AND "capabilityId" = project_record."primaryCapabilityId"
    AND COALESCE("tenantId", 'default') = COALESCE(project_record."tenantId", 'default');

  IF total_links <> 1 OR matching_links <> 1 THEN
    RAISE EXCEPTION 'Synthesis initiative % must be attached to exactly one matching primary capability', p_project_id
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.workgraph_check_single_capability_initiative()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'specification_projects' THEN
    PERFORM public.workgraph_assert_single_capability_initiative(NEW."id");
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM public.workgraph_assert_single_capability_initiative(OLD."projectId");
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."projectId" IS DISTINCT FROM NEW."projectId" THEN
    PERFORM public.workgraph_assert_single_capability_initiative(OLD."projectId");
  END IF;

  PERFORM public.workgraph_assert_single_capability_initiative(NEW."projectId");
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_specification_projects_single_capability'
  ) THEN
    CREATE CONSTRAINT TRIGGER "trg_specification_projects_single_capability"
      AFTER INSERT OR UPDATE OF "primaryCapabilityId", "tenantId"
      ON "specification_projects"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION public.workgraph_check_single_capability_initiative();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_specification_project_capabilities_single_capability'
  ) THEN
    CREATE CONSTRAINT TRIGGER "trg_specification_project_capabilities_single_capability"
      AFTER INSERT OR UPDATE OR DELETE
      ON "specification_project_capabilities"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION public.workgraph_check_single_capability_initiative();
  END IF;
END $$;

-- The older composite identity implied a project could collect multiple
-- capabilities. Once projectId is unique, the composite index is redundant and
-- misleading to Prisma/client call sites.
DROP INDEX IF EXISTS "specification_project_capabilities_projectId_capabilityId_key";
