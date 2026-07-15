-- M93: Epistemic layer — Rooms, Claims (Beta posteriors), Estimates. Governs the ambiguity regime;
-- the belief math lives in code (modules/rooms/belief.ts). Plain DDL — prisma db push covers
-- bare-metal, this file covers Docker migrate deploy (same pattern as m86–m92).

DO $$ BEGIN
    CREATE TYPE "RoomState" AS ENUM ('FRAMING','DIVERGENCE','REVEAL','ESTIMATION','PROBING','REVIEW','GATE','CONVERGED','ABANDONED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE "ClaimType" AS ENUM ('MARKET','USER','OPERATIONAL','TECHNICAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE "ClaimStatus" AS ENUM ('OPEN','ACCEPTED','PROMOTED','RETIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TYPE "EstimatorKind" AS ENUM ('HUMAN','AGENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "rooms" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "state" "RoomState" NOT NULL DEFAULT 'FRAMING',
    "createdById" TEXT,
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "rooms_projectId_idx" ON "rooms"("projectId");
CREATE INDEX IF NOT EXISTS "rooms_state_idx" ON "rooms"("state");
CREATE INDEX IF NOT EXISTS "ix_rooms_tenant" ON "rooms"("tenantId");

CREATE TABLE IF NOT EXISTS "claims" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "roomId" TEXT,
    "statement" TEXT NOT NULL,
    "riskiestAssumption" TEXT,
    "claimType" "ClaimType" NOT NULL DEFAULT 'TECHNICAL',
    "contextScope" TEXT NOT NULL DEFAULT 'default',
    "entityKind" TEXT,
    "entityId" TEXT,
    "alpha" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "beta" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "status" "ClaimStatus" NOT NULL DEFAULT 'OPEN',
    "stewardId" TEXT NOT NULL,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "claims_projectId_idx" ON "claims"("projectId");
CREATE INDEX IF NOT EXISTS "claims_roomId_idx" ON "claims"("roomId");
CREATE INDEX IF NOT EXISTS "claims_contextScope_idx" ON "claims"("contextScope");
CREATE INDEX IF NOT EXISTS "claims_status_idx" ON "claims"("status");
CREATE INDEX IF NOT EXISTS "ix_claims_tenant" ON "claims"("tenantId");

CREATE TABLE IF NOT EXISTS "claim_estimates" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "estimatorId" TEXT NOT NULL,
    "estimatorKind" "EstimatorKind" NOT NULL DEFAULT 'HUMAN',
    "probability" DOUBLE PRECISION NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "rationale" TEXT,
    "tenantId" TEXT DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "claim_estimates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "claim_estimates_claimId_estimatorId_key" ON "claim_estimates"("claimId", "estimatorId");
CREATE INDEX IF NOT EXISTS "claim_estimates_claimId_idx" ON "claim_estimates"("claimId");
CREATE INDEX IF NOT EXISTS "ix_claim_estimates_tenant" ON "claim_estimates"("tenantId");

DO $$ BEGIN
    ALTER TABLE "rooms" ADD CONSTRAINT "rooms_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "claims" ADD CONSTRAINT "claims_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "claims" ADD CONSTRAINT "claims_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "claim_estimates" ADD CONSTRAINT "claim_estimates_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
