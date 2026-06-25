-- Finding #8 — provenance for IAM↔local role reconciliation.
-- Existing rows default to 'LOCAL' so no currently-granted role is ever auto-removed;
-- only bindings the IAM mirror creates going forward are tagged 'IAM' and revoked on
-- demotion. See src/middleware/auth.ts (reconcileAdminRole).

-- AlterTable
ALTER TABLE "user_roles" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'LOCAL';
