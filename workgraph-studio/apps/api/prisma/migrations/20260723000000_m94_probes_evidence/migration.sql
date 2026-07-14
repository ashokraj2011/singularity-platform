-- M94: Probes & Evidence — Phase 2 of the epistemic layer. A Probe is the cheapest experiment that could
-- falsify a claim's riskiest assumption; resolving one emits tier-capped, idempotent Evidence that moves
-- the Beta posterior. Abandonment ("not worth building") becomes a first-class claim status.

ALTER TYPE "ClaimStatus" ADD VALUE IF NOT EXISTS 'ABANDONED';

DO $$ BEGIN CREATE TYPE "EvidenceTier" AS ENUM ('PRODUCTION', 'EXPERIMENT', 'SIMULATION', 'AGENT', 'OPINION'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ProbeStatus" AS ENUM ('OPEN', 'RESOLVED', 'ABANDONED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "claim_probes" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "roomId" TEXT,
    "riskiestAssumption" TEXT NOT NULL,
    "falsification" TEXT NOT NULL,
    "tier" "EvidenceTier" NOT NULL DEFAULT 'SIMULATION',
    "ownerId" TEXT NOT NULL,
    "deadline" TIMESTAMP(3),
    "status" "ProbeStatus" NOT NULL DEFAULT 'OPEN',
    "eig" DOUBLE PRECISION,
    "outcome" TEXT,
    "createdById" TEXT,
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "claim_probes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "claim_probes_claimId_idx" ON "claim_probes"("claimId");
CREATE INDEX IF NOT EXISTS "claim_probes_roomId_idx" ON "claim_probes"("roomId");
CREATE INDEX IF NOT EXISTS "claim_probes_status_idx" ON "claim_probes"("status");
CREATE INDEX IF NOT EXISTS "ix_claim_probes_tenant" ON "claim_probes"("tenantId");

CREATE TABLE IF NOT EXISTS "claim_evidence" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "probeId" TEXT,
    "tier" "EvidenceTier" NOT NULL,
    "supports" BOOLEAN NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "evidenceKey" TEXT NOT NULL,
    "sourceUri" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "claim_evidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "claim_evidence_evidenceKey_key" ON "claim_evidence"("evidenceKey");
CREATE INDEX IF NOT EXISTS "claim_evidence_claimId_idx" ON "claim_evidence"("claimId");
CREATE INDEX IF NOT EXISTS "ix_claim_evidence_tenant" ON "claim_evidence"("tenantId");

DO $$ BEGIN ALTER TABLE "claim_probes" ADD CONSTRAINT "claim_probes_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "claim_probes" ADD CONSTRAINT "claim_probes_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_probeId_fkey" FOREIGN KEY ("probeId") REFERENCES "claim_probes"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
