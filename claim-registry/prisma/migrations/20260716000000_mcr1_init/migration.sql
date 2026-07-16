-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "ClaimKind" AS ENUM ('HYPOTHESIS', 'ASSUMPTION', 'OBSERVATION', 'CONSTRAINT', 'DECISION', 'REQUIREMENT');

-- CreateEnum
CREATE TYPE "MaturityState" AS ENUM ('FRAGMENT', 'HYPOTHESIS', 'VALIDATED', 'REQUIREMENT', 'SPEC_BOUND', 'FALSIFIED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('ACTIVE', 'MERGED', 'RETIRED', 'FALSIFIED');

-- CreateEnum
CREATE TYPE "EvidenceTier" AS ENUM ('T0', 'T1', 'T2', 'T3');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('DATA_PULL', 'PROD_TELEMETRY', 'EXPERIMENT', 'SPIKE', 'USABILITY_SESSION', 'INTERVIEW', 'EXPERT_OPINION', 'DOCUMENT', 'MARKET_SIGNAL');

-- CreateEnum
CREATE TYPE "EvidenceDirection" AS ENUM ('SUPPORTS', 'CONTRADICTS');

-- CreateTable
CREATE TABLE "claims" (
    "id" TEXT NOT NULL,
    "capabilityId" TEXT,
    "kind" "ClaimKind" NOT NULL,
    "maturity" "MaturityState" NOT NULL DEFAULT 'FRAGMENT',
    "status" "ClaimStatus" NOT NULL DEFAULT 'ACTIVE',
    "statement" TEXT NOT NULL,
    "canonicalKey" TEXT NOT NULL,
    "embedding" vector(1536),
    "embeddingDegraded" BOOLEAN NOT NULL DEFAULT false,
    "subjectRefs" JSONB NOT NULL DEFAULT '[]',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priorLogOdds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "posteriorLogOdds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "posteriorProb" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "effectiveEvidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "halfLifeDays" INTEGER NOT NULL DEFAULT 180,
    "thresholdHeldSince" TIMESTAMP(3),
    "lastComputedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_versions" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "statement" TEXT NOT NULL,
    "changeNote" TEXT,
    "editedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_objects" (
    "id" TEXT NOT NULL,
    "tier" "EvidenceTier" NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "contentHash" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "payloadRef" TEXT,
    "sourceMeta" JSONB NOT NULL DEFAULT '{}',
    "observedAt" TIMESTAMP(3) NOT NULL,
    "signature" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_links" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "direction" "EvidenceDirection" NOT NULL,
    "logLikelihoodRatio" DOUBLE PRECISION NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "decayExempt" BOOLEAN NOT NULL DEFAULT false,
    "attachedBy" TEXT NOT NULL,
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maturity_transitions" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "fromState" "MaturityState" NOT NULL,
    "toState" "MaturityState" NOT NULL,
    "thresholdProb" DOUBLE PRECISION NOT NULL,
    "actualProb" DOUBLE PRECISION NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "approvedBy" TEXT,
    "receiptTraceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maturity_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceService" TEXT NOT NULL DEFAULT 'claim-registry',
    "subjectKind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_outbox" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "traceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_subscriptions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eventTypes" TEXT[],
    "targetUrl" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_deliveries" (
    "id" TEXT NOT NULL,
    "outboxId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "claims_canonicalKey_key" ON "claims"("canonicalKey");

-- CreateIndex
CREATE INDEX "claims_capabilityId_maturity_status_idx" ON "claims"("capabilityId", "maturity", "status");

-- CreateIndex
CREATE INDEX "claims_kind_status_idx" ON "claims"("kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "claim_versions_claimId_version_key" ON "claim_versions"("claimId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_objects_contentHash_key" ON "evidence_objects"("contentHash");

-- CreateIndex
CREATE INDEX "evidence_links_claimId_attachedAt_idx" ON "evidence_links"("claimId", "attachedAt");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_links_claimId_evidenceId_key" ON "evidence_links"("claimId", "evidenceId");

-- CreateIndex
CREATE INDEX "maturity_transitions_claimId_occurredAt_idx" ON "maturity_transitions"("claimId", "occurredAt");

-- CreateIndex
CREATE INDEX "receipts_traceId_idx" ON "receipts"("traceId");

-- CreateIndex
CREATE INDEX "event_outbox_status_createdAt_idx" ON "event_outbox"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "event_subscriptions_name_key" ON "event_subscriptions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "event_deliveries_outboxId_subscriptionId_key" ON "event_deliveries"("outboxId", "subscriptionId");

-- AddForeignKey
ALTER TABLE "claim_versions" ADD CONSTRAINT "claim_versions_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "evidence_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maturity_transitions" ADD CONSTRAINT "maturity_transitions_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "event_outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "event_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

