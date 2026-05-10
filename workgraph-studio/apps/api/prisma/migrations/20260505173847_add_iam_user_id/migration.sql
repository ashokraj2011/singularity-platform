-- Make local password optional (only required when AUTH_PROVIDER=local)
ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- Add Singularity IAM user-id mirror
ALTER TABLE "users" ADD COLUMN "iamUserId" TEXT;

-- Unique only when set
CREATE UNIQUE INDEX "users_iamUserId_key" ON "users"("iamUserId");
