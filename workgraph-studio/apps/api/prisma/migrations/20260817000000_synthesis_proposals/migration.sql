-- CreateEnum
CREATE TYPE "ProposalItemStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EDITED', 'APPLIED', 'STALE');

-- AlterTable
ALTER TABLE "studio_proposals" ADD COLUMN     "baseContentHash" TEXT,
ADD COLUMN     "contract" JSONB,
ADD COLUMN     "contractVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "workItemId" TEXT,
ADD COLUMN     "workspaceId" TEXT;

-- CreateTable
CREATE TABLE "proposal_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "proposalId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "targetEntityType" TEXT,
    "targetEntityId" TEXT,
    "targetVersionId" TEXT,
    "baseContentHash" TEXT,
    "diff" JSONB NOT NULL DEFAULT '{}',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "evidenceTier" TEXT,
    "uncertainty" DOUBLE PRECISION,
    "reversibility" TEXT,
    "cost" JSONB,
    "policyChecks" JSONB,
    "requiredApproval" TEXT,
    "status" "ProposalItemStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "editedDiff" JSONB,
    "appliedReceipt" JSONB,
    "rebaseOfItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposal_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_proposal_items_tenant" ON "proposal_items"("tenantId");

-- CreateIndex
CREATE INDEX "proposal_items_proposalId_ordinal_idx" ON "proposal_items"("proposalId", "ordinal");

-- CreateIndex
CREATE INDEX "studio_proposals_workspaceId_status_idx" ON "studio_proposals"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "studio_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Tenant isolation policy (new proposal_items table) ────────────────────────
CREATE OR REPLACE FUNCTION public.workgraph_install_tenant_policy(table_name text, predicate text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=table_name AND policyname='tenant_isolation_policy') THEN
    EXECUTE format('CREATE POLICY tenant_isolation_policy ON public.%I FOR ALL USING (%s) WITH CHECK (%s)', table_name, predicate, predicate);
  END IF;
END; $$;
SELECT public.workgraph_install_tenant_policy('proposal_items', '"tenantId" = public.workgraph_current_tenant_id()');
DROP FUNCTION public.workgraph_install_tenant_policy(text, text);
