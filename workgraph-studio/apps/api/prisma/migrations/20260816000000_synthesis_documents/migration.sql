-- CreateEnum
CREATE TYPE "SynthesisDocType" AS ENUM ('PRD', 'BRD', 'READOUT', 'DIGEST', 'NARRATIVE', 'GENERIC');

-- CreateEnum
CREATE TYPE "SynthesisDocumentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DocumentBlockType" AS ENUM ('NARRATIVE', 'CITATION', 'CLAIM', 'DECISION', 'REQUIREMENT', 'ACCEPTANCE', 'OBJECTIVE', 'METRIC', 'RISK', 'EXPERIMENT', 'DIAGRAM', 'WORKITEM', 'AGENT_INFERENCE');

-- CreateEnum
CREATE TYPE "DocumentBlockMode" AS ENUM ('LIVE', 'PINNED');

-- CreateTable
CREATE TABLE "synthesis_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "specificationProjectId" TEXT NOT NULL,
    "workItemId" TEXT,
    "workspaceId" TEXT,
    "docType" "SynthesisDocType" NOT NULL DEFAULT 'GENERIC',
    "title" TEXT NOT NULL,
    "status" "SynthesisDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "currentVersionId" TEXT,
    "specificationVersionId" TEXT,
    "contentHash" TEXT,
    "supersedesId" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "synthesis_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" "SynthesisDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "renderedMarkdown" TEXT,
    "contentHash" TEXT,
    "package" JSONB,
    "createdById" TEXT,
    "approvedById" TEXT,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_blocks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "documentVersionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "blockType" "DocumentBlockType" NOT NULL,
    "mode" "DocumentBlockMode" NOT NULL DEFAULT 'LIVE',
    "content" JSONB NOT NULL DEFAULT '{}',
    "sourceRef" JSONB,
    "pinnedSnapshot" JSONB,
    "authorType" "WorkspaceAuthorType" NOT NULL DEFAULT 'HUMAN',
    "authorId" TEXT,
    "agentRole" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_synthesis_documents_tenant" ON "synthesis_documents"("tenantId");

-- CreateIndex
CREATE INDEX "synthesis_documents_specificationProjectId_status_idx" ON "synthesis_documents"("specificationProjectId", "status");

-- CreateIndex
CREATE INDEX "synthesis_documents_workspaceId_idx" ON "synthesis_documents"("workspaceId");

-- CreateIndex
CREATE INDEX "ix_document_versions_tenant" ON "document_versions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_documentId_version_key" ON "document_versions"("documentId", "version");

-- CreateIndex
CREATE INDEX "ix_document_blocks_tenant" ON "document_blocks"("tenantId");

-- CreateIndex
CREATE INDEX "document_blocks_documentVersionId_ordinal_idx" ON "document_blocks"("documentVersionId", "ordinal");

-- AddForeignKey
ALTER TABLE "synthesis_documents" ADD CONSTRAINT "synthesis_documents_specificationProjectId_fkey" FOREIGN KEY ("specificationProjectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "synthesis_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_blocks" ADD CONSTRAINT "document_blocks_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "document_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Tenant isolation policies (Synthesis document tables) ─────────────────────
CREATE OR REPLACE FUNCTION public.workgraph_install_tenant_policy(table_name text, predicate text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=table_name AND policyname='tenant_isolation_policy') THEN
    EXECUTE format('CREATE POLICY tenant_isolation_policy ON public.%I FOR ALL USING (%s) WITH CHECK (%s)', table_name, predicate, predicate);
  END IF;
END; $$;
SELECT public.workgraph_install_tenant_policy('synthesis_documents', '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('document_versions',   '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('document_blocks',     '"tenantId" = public.workgraph_current_tenant_id()');
DROP FUNCTION public.workgraph_install_tenant_policy(text, text);
