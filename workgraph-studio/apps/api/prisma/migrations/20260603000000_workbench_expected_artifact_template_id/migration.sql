-- M102 — link an expected artifact to a catalog ArtifactTemplate (nullable, back-compat).
ALTER TABLE "workbench_expected_artifacts" ADD COLUMN IF NOT EXISTS "templateId" TEXT;
