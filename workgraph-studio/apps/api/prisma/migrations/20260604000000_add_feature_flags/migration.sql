-- Adds the feature_flags table (FeatureFlag model).
--
-- This table existed historically on long-lived databases (created via an early
-- `prisma db push`) but was never captured in a migration. As a result a fresh
-- `prisma migrate reset` / `migrate deploy` produced a schema WITHOUT it, and the
-- seed's code-foundry feature-flag step failed with P2021 (table does not exist).
-- This migration brings the migration history in sync with the FeatureFlag model.
CREATE TABLE IF NOT EXISTS "feature_flags" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);
