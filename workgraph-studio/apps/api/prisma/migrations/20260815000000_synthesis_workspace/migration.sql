-- CreateEnum
CREATE TYPE "SynthesisWorkspaceStatus" AS ENUM ('OPEN', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WorkspaceThreadKind" AS ENUM ('WORKING_SESSION', 'ASK_SIDECAR');

-- CreateEnum
CREATE TYPE "WorkspaceThreadStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "WorkspaceMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "WorkspaceAuthorType" AS ENUM ('HUMAN', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ContextEntityType" AS ENUM ('SOURCE', 'CLAIM', 'DECISION', 'REQUIREMENT', 'SPECIFICATION', 'METRIC', 'WORKITEM', 'OUTCOME', 'PERSON');

-- CreateEnum
CREATE TYPE "ContextReferenceMode" AS ENUM ('FOLLOW_LATEST', 'PINNED');

-- CreateTable
CREATE TABLE "synthesis_workspaces" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "specificationProjectId" TEXT NOT NULL,
    "workItemId" TEXT,
    "title" TEXT NOT NULL,
    "purpose" TEXT,
    "status" "SynthesisWorkspaceStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" TEXT NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "synthesis_workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_threads" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "workspaceId" TEXT NOT NULL,
    "kind" "WorkspaceThreadKind" NOT NULL DEFAULT 'WORKING_SESSION',
    "agentRole" TEXT,
    "title" TEXT,
    "contextScope" JSONB NOT NULL DEFAULT '{}',
    "headSeq" BIGINT NOT NULL DEFAULT 0,
    "status" "WorkspaceThreadStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "role" "WorkspaceMessageRole" NOT NULL,
    "authorType" "WorkspaceAuthorType" NOT NULL,
    "authorId" TEXT,
    "agentRole" TEXT,
    "content" JSONB NOT NULL DEFAULT '{}',
    "contextManifestId" TEXT,
    "proposalId" TEXT,
    "correlation" JSONB NOT NULL DEFAULT '{}',
    "tokens" JSONB NOT NULL DEFAULT '{}',
    "receipts" JSONB NOT NULL DEFAULT '[]',
    "coalesceKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_references" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT,
    "specificationProjectId" TEXT,
    "workItemId" TEXT,
    "entityType" "ContextEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "versionId" TEXT,
    "contentHash" TEXT,
    "span" JSONB,
    "referenceMode" "ContextReferenceMode" NOT NULL DEFAULT 'FOLLOW_LATEST',
    "classification" TEXT,
    "authzDecision" JSONB NOT NULL DEFAULT '{}',
    "label" TEXT,
    "addedById" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_manifests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT 'default',
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "tokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "costEstimate" DOUBLE PRECISION,
    "pinnedCount" INTEGER NOT NULL DEFAULT 0,
    "followingCount" INTEGER NOT NULL DEFAULT 0,
    "classificationSummary" JSONB NOT NULL DEFAULT '{}',
    "manifestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_synthesis_workspaces_tenant" ON "synthesis_workspaces"("tenantId");

-- CreateIndex
CREATE INDEX "synthesis_workspaces_specificationProjectId_status_idx" ON "synthesis_workspaces"("specificationProjectId", "status");

-- CreateIndex
CREATE INDEX "synthesis_workspaces_workItemId_idx" ON "synthesis_workspaces"("workItemId");

-- CreateIndex
CREATE INDEX "ix_workspace_threads_tenant" ON "workspace_threads"("tenantId");

-- CreateIndex
CREATE INDEX "workspace_threads_workspaceId_status_idx" ON "workspace_threads"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "ix_workspace_messages_tenant" ON "workspace_messages"("tenantId");

-- CreateIndex
CREATE INDEX "workspace_messages_workspaceId_createdAt_idx" ON "workspace_messages"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_messages_threadId_seq_key" ON "workspace_messages"("threadId", "seq");

-- CreateIndex
CREATE INDEX "ix_context_references_tenant" ON "context_references"("tenantId");

-- CreateIndex
CREATE INDEX "context_references_workspaceId_entityType_idx" ON "context_references"("workspaceId", "entityType");

-- CreateIndex
CREATE INDEX "ix_context_manifests_tenant" ON "context_manifests"("tenantId");

-- CreateIndex
CREATE INDEX "context_manifests_workspaceId_threadId_idx" ON "context_manifests"("workspaceId", "threadId");

-- AddForeignKey
ALTER TABLE "synthesis_workspaces" ADD CONSTRAINT "synthesis_workspaces_specificationProjectId_fkey" FOREIGN KEY ("specificationProjectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synthesis_workspaces" ADD CONSTRAINT "synthesis_workspaces_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_threads" ADD CONSTRAINT "workspace_threads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "synthesis_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_messages" ADD CONSTRAINT "workspace_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "workspace_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_references" ADD CONSTRAINT "context_references_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "synthesis_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_manifests" ADD CONSTRAINT "context_manifests_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "synthesis_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Tenant isolation policies (Synthesis workspace tables) ────────────────────
-- Installed here (mirrors M101 for the board tables) so the new tables are
-- policy-ready; the tenant RLS cutover ENABLE/FORCEs them alongside the spine.
-- workgraph_current_tenant_id() is created by the 20260619123000 scaffold and persists.
CREATE OR REPLACE FUNCTION public.workgraph_install_tenant_policy(table_name text, predicate text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = table_name AND policyname = 'tenant_isolation_policy'
  ) THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON public.%I FOR ALL USING (%s) WITH CHECK (%s)',
      table_name, predicate, predicate
    );
  END IF;
END;
$$;

SELECT public.workgraph_install_tenant_policy('synthesis_workspaces', '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('workspace_threads',    '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('workspace_messages',   '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('context_references',   '"tenantId" = public.workgraph_current_tenant_id()');
SELECT public.workgraph_install_tenant_policy('context_manifests',    '"tenantId" = public.workgraph_current_tenant_id()');

DROP FUNCTION public.workgraph_install_tenant_policy(text, text);
