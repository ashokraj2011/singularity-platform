-- G8 — per-stage governance intent on workbench_stages. Reconciled into
-- scope=STAGE IAM governance attachments (target_kind=STAGE_KEY,
-- target_key=stageKey) on explicit definition save. All nullable so existing
-- rows are untouched and ungoverned by default.
ALTER TABLE "workbench_stages" ADD COLUMN "governancePolicyId"      TEXT;
ALTER TABLE "workbench_stages" ADD COLUMN "governanceEnforcement"   TEXT;
ALTER TABLE "workbench_stages" ADD COLUMN "governancePriority"      INTEGER;
ALTER TABLE "workbench_stages" ADD COLUMN "governanceContributions" JSONB;
