-- ─────────────────────────────────────────────────────────────────────────────
-- Documents become polymorphic: UPLOAD | LINK.
--
-- UPLOAD rows continue to use storageKey + mimeType + sizeBytes + bucket
-- (existing data).  LINK rows fill in `url` + `provider` instead and leave the
-- storage fields null.  The `kind` column tells consumers which set is live.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "documents"
  ADD COLUMN "kind"     TEXT NOT NULL DEFAULT 'UPLOAD',
  ADD COLUMN "url"      TEXT,
  ADD COLUMN "provider" TEXT;

-- Make the storage-tier columns nullable so LINK rows can omit them.
ALTER TABLE "documents" ALTER COLUMN "mimeType"   DROP NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "sizeBytes"  DROP NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "storageKey" DROP NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "bucket"     DROP DEFAULT;
ALTER TABLE "documents" ALTER COLUMN "bucket"     DROP NOT NULL;

CREATE INDEX "documents_kind_idx" ON "documents"("kind");
