-- AlterTable
ALTER TABLE "governance_waivers" ADD COLUMN     "tenantId" TEXT DEFAULT 'default';

-- AlterTable
ALTER TABLE "receipts" ADD COLUMN     "tenantId" TEXT DEFAULT 'default';

-- CreateIndex
CREATE INDEX "ix_governance_waivers_tenant" ON "governance_waivers"("tenantId");

-- CreateIndex
CREATE INDEX "ix_receipts_tenant" ON "receipts"("tenantId");

