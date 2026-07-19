-- CreateTable
CREATE TABLE "CapabilityWorldModelViewDoc" (
    "id" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "domainKey" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "contentMd" TEXT NOT NULL,
    "structured" JSONB,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "sourceCommit" TEXT,
    "repoFingerprint" TEXT,
    "tokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "buildError" TEXT,
    "generatedBy" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapabilityWorldModelViewDoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CapabilityWorldModelViewDoc_capabilityId_status_idx" ON "CapabilityWorldModelViewDoc"("capabilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CapabilityWorldModelViewDoc_capabilityId_kind_domainKey_key" ON "CapabilityWorldModelViewDoc"("capabilityId", "kind", "domainKey");

-- AddForeignKey
ALTER TABLE "CapabilityWorldModelViewDoc" ADD CONSTRAINT "CapabilityWorldModelViewDoc_capabilityId_fkey" FOREIGN KEY ("capabilityId") REFERENCES "Capability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

