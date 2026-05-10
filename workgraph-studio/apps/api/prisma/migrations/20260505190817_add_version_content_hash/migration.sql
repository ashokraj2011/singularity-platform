-- Track the content hash of each template version so a run can reuse an
-- identical snapshot instead of creating a new one every time.
ALTER TABLE "workflow_template_versions" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "workflow_template_versions" ADD COLUMN "source"      TEXT;
CREATE INDEX "workflow_template_versions_template_hash_idx"
  ON "workflow_template_versions"("templateId", "contentHash");
