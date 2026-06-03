-- Capability Governance Model (G2)

-- Governing-role marker synced from IAM (routing guard reads this).
ALTER TABLE "capabilities_cache" ADD COLUMN "isGoverning" BOOLEAN NOT NULL DEFAULT false;

-- Resolved governance overlay snapshots (work item / run / stage).
CREATE TABLE "governance_overlay_snapshots" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT,
    "workflowInstanceId" TEXT,
    "workflowNodeId" TEXT,
    "governedCapabilityId" TEXT NOT NULL,
    "overlayHash" TEXT NOT NULL,
    "resolvedOverlayJson" JSONB NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "governance_overlay_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gov_overlay_snap_wi_node_hash_key"
    ON "governance_overlay_snapshots" ("workItemId", "workflowNodeId", "overlayHash");
CREATE INDEX "gov_overlay_snap_wi_idx"  ON "governance_overlay_snapshots" ("workItemId");
CREATE INDEX "gov_overlay_snap_run_idx" ON "governance_overlay_snapshots" ("workflowInstanceId");
