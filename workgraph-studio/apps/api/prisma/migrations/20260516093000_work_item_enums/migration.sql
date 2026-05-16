DO $$ BEGIN
  CREATE TYPE "WorkItemStatus" AS ENUM (
    'QUEUED',
    'IN_PROGRESS',
    'AWAITING_PARENT_APPROVAL',
    'COMPLETED',
    'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WorkItemTargetStatus" AS ENUM (
    'QUEUED',
    'CLAIMED',
    'IN_PROGRESS',
    'SUBMITTED',
    'APPROVED',
    'REWORK_REQUESTED',
    'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WorkItemEventType" AS ENUM (
    'CREATED',
    'CLAIMED',
    'STARTED',
    'SUBMITTED',
    'APPROVAL_REQUESTED',
    'APPROVED',
    'REWORK_REQUESTED',
    'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "work_items" ALTER COLUMN "status" DROP DEFAULT;
UPDATE "work_items"
SET "status" = CASE lower("status")
  WHEN 'queued' THEN 'QUEUED'
  WHEN 'in_progress' THEN 'IN_PROGRESS'
  WHEN 'awaiting_parent_approval' THEN 'AWAITING_PARENT_APPROVAL'
  WHEN 'completed' THEN 'COMPLETED'
  WHEN 'cancelled' THEN 'CANCELLED'
  ELSE 'QUEUED'
END;
ALTER TABLE "work_items"
  ALTER COLUMN "status" TYPE "WorkItemStatus" USING "status"::"WorkItemStatus",
  ALTER COLUMN "status" SET DEFAULT 'QUEUED';

ALTER TABLE "work_item_targets" ALTER COLUMN "status" DROP DEFAULT;
UPDATE "work_item_targets"
SET "status" = CASE lower("status")
  WHEN 'queued' THEN 'QUEUED'
  WHEN 'claimed' THEN 'CLAIMED'
  WHEN 'in_progress' THEN 'IN_PROGRESS'
  WHEN 'submitted' THEN 'SUBMITTED'
  WHEN 'approved' THEN 'APPROVED'
  WHEN 'rework_requested' THEN 'REWORK_REQUESTED'
  WHEN 'cancelled' THEN 'CANCELLED'
  ELSE 'QUEUED'
END;
ALTER TABLE "work_item_targets"
  ALTER COLUMN "status" TYPE "WorkItemTargetStatus" USING "status"::"WorkItemTargetStatus",
  ALTER COLUMN "status" SET DEFAULT 'QUEUED';

UPDATE "work_item_events"
SET "eventType" = CASE
  WHEN lower("eventType") IN ('created', 'workitemcreated') THEN 'CREATED'
  WHEN lower("eventType") IN ('claimed', 'workitemtargetclaimed') THEN 'CLAIMED'
  WHEN lower("eventType") IN ('started', 'workitemtargetstarted') THEN 'STARTED'
  WHEN lower("eventType") IN ('submitted', 'workitemtargetsubmitted') THEN 'SUBMITTED'
  WHEN lower("eventType") IN ('approval_requested', 'workitemapprovalrequested') THEN 'APPROVAL_REQUESTED'
  WHEN lower("eventType") IN ('approved', 'workitemapproved') THEN 'APPROVED'
  WHEN lower("eventType") IN ('rework_requested', 'workitemreworkrequested') THEN 'REWORK_REQUESTED'
  WHEN lower("eventType") = 'cancelled' THEN 'CANCELLED'
  ELSE 'CREATED'
END;
ALTER TABLE "work_item_events"
  ALTER COLUMN "eventType" TYPE "WorkItemEventType" USING "eventType"::"WorkItemEventType";
