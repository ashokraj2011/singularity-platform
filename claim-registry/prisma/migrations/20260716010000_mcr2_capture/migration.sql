-- M-CR2: knowledge-event capture + lowering candidates (curation queue).
-- (ClaimKind already exists from the M-CR1 init migration.)

-- CreateEnum
CREATE TYPE "CaptureSource" AS ENUM ('TRANSCRIPT', 'SLACK', 'CONFLUENCE', 'BOARD_EXPORT', 'WORKBENCH', 'MANUAL');
CREATE TYPE "LoweringStatus" AS ENUM ('PENDING', 'LOWERED', 'NO_CLAIMS', 'FAILED');
CREATE TYPE "CandidateStatus" AS ENUM ('PENDING_REVIEW', 'ACCEPTED', 'REJECTED', 'MERGED_TO_EXISTING');

-- CreateTable
CREATE TABLE "knowledge_events" (
    "id" TEXT NOT NULL,
    "source" "CaptureSource" NOT NULL,
    "externalRef" TEXT,
    "contentHash" TEXT NOT NULL,
    "payloadRef" TEXT NOT NULL,
    "capabilityId" TEXT,
    "capturedBy" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "loweringStatus" "LoweringStatus" NOT NULL DEFAULT 'PENDING',
    CONSTRAINT "knowledge_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "knowledge_events_contentHash_key" ON "knowledge_events"("contentHash");

-- CreateTable
CREATE TABLE "lowering_candidates" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "proposedStatement" TEXT NOT NULL,
    "proposedKind" "ClaimKind" NOT NULL,
    "modelConfidence" DOUBLE PRECISION NOT NULL,
    "matchedClaimId" TEXT,
    "status" "CandidateStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedBy" TEXT,
    "resultingClaimId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lowering_candidates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lowering_candidates_status_createdAt_idx" ON "lowering_candidates"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "lowering_candidates" ADD CONSTRAINT "lowering_candidates_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "knowledge_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
