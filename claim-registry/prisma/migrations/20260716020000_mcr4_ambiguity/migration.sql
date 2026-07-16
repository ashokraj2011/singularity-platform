-- M-CR4: ambiguity ledger + claim relations (sweeps open ledger rows; projections read them).
-- (claims already exists from the M-CR1 init migration.)

-- CreateEnum
CREATE TYPE "AmbiguityType" AS ENUM ('CONTRADICTION', 'MISSING_EVIDENCE', 'STARVATION');
CREATE TYPE "AmbiguityStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');
CREATE TYPE "RelationType" AS ENUM ('CONTRADICTS', 'DEPENDS_ON', 'REFINES', 'DUPLICATES');

-- CreateTable
CREATE TABLE "claim_relations" (
    "id" TEXT NOT NULL,
    "fromClaimId" TEXT NOT NULL,
    "toClaimId" TEXT NOT NULL,
    "type" "RelationType" NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "claim_relations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "claim_relations_fromClaimId_toClaimId_type_key" ON "claim_relations"("fromClaimId", "toClaimId", "type");
CREATE INDEX "claim_relations_type_idx" ON "claim_relations"("type");
CREATE INDEX "claim_relations_toClaimId_idx" ON "claim_relations"("toClaimId");

-- CreateTable
CREATE TABLE "ambiguities" (
    "id" TEXT NOT NULL,
    "type" "AmbiguityType" NOT NULL,
    "status" "AmbiguityStatus" NOT NULL DEFAULT 'OPEN',
    "claimId" TEXT NOT NULL,
    "relatedClaimId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "openedBy" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    CONSTRAINT "ambiguities_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ambiguities_status_type_idx" ON "ambiguities"("status", "type");
CREATE INDEX "ambiguities_claimId_status_idx" ON "ambiguities"("claimId", "status");
CREATE INDEX "ambiguities_dedupeKey_status_idx" ON "ambiguities"("dedupeKey", "status");

-- AddForeignKey
ALTER TABLE "claim_relations" ADD CONSTRAINT "claim_relations_fromClaimId_fkey" FOREIGN KEY ("fromClaimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "claim_relations" ADD CONSTRAINT "claim_relations_toClaimId_fkey" FOREIGN KEY ("toClaimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ambiguities" ADD CONSTRAINT "ambiguities_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
