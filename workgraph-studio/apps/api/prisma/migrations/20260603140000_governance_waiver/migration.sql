-- Capability Governance Model (G4) — waivers for BLOCKING/REQUIRED controls.

CREATE TABLE "governance_waivers" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT,
    "workflowInstanceId" TEXT,
    "workflowNodeId" TEXT,
    "controlKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedBy" TEXT,
    "approvedBy" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "governance_waivers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "gov_waiver_wi_idx"      ON "governance_waivers" ("workItemId");
CREATE INDEX "gov_waiver_control_idx" ON "governance_waivers" ("controlKey");
