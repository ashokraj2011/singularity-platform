-- M84.s1 — First-class WorkbenchStage schema.
--
-- Promotes the loopDefinition JSON blob (today stored on
-- workflow_nodes.config) to first-class rows so the workflow designer
-- can render a subgraph view and the inspector can edit individual
-- stages without rewriting a whole JSON document.
--
-- This migration only CREATES tables — it doesn't backfill, doesn't
-- touch workflow_nodes.config, and doesn't change the runtime
-- executor's read path. The backfill script (prisma/seed-m84.ts)
-- runs separately and copies existing JSON into these tables. The
-- runtime cutover lands in M84.s3.
--
-- All FKs cascade on definition delete: blowing away a workbench
-- definition cleans up its stages, artifacts, edges, etc. in one
-- statement.

-- ── 1. WorkbenchDefinition (1:1 with WORKBENCH_TASK WorkflowNode) ─────────
CREATE TABLE "workbench_definitions" (
    "id" TEXT NOT NULL,
    "workflowNodeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "goal" TEXT,
    "sourceType" TEXT,
    "sourceUri" TEXT,
    "sourceRef" TEXT,
    "capabilityId" TEXT,
    "architectAgentTemplateId" TEXT,
    "developerAgentTemplateId" TEXT,
    "qaAgentTemplateId" TEXT,
    "maxLoopsPerStage" INTEGER NOT NULL DEFAULT 3,
    "maxTotalSendBacks" INTEGER NOT NULL DEFAULT 6,
    "gateMode" TEXT NOT NULL DEFAULT 'manual',
    "finalPackKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbench_definitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workbench_definitions_workflowNodeId_key"
    ON "workbench_definitions"("workflowNodeId");
CREATE INDEX "workbench_definitions_workflowNodeId_idx"
    ON "workbench_definitions"("workflowNodeId");

-- ── 2. WorkbenchStage (N per definition, ordered by ordinal) ───────────────
CREATE TABLE "workbench_stages" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "agentRole" TEXT NOT NULL,
    "agentTemplateId" TEXT,
    "promptProfileKey" TEXT,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "positionX" DOUBLE PRECISION,
    "positionY" DOUBLE PRECISION,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "terminal" BOOLEAN NOT NULL DEFAULT false,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT true,
    "repoAccess" BOOLEAN NOT NULL DEFAULT false,
    "toolPolicy" TEXT NOT NULL DEFAULT 'NONE',
    "contextPolicy" TEXT NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbench_stages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workbench_stages_definitionId_stageKey_key"
    ON "workbench_stages"("definitionId", "stageKey");
CREATE INDEX "workbench_stages_definitionId_ordinal_idx"
    ON "workbench_stages"("definitionId", "ordinal");
ALTER TABLE "workbench_stages"
    ADD CONSTRAINT "workbench_stages_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "workbench_definitions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. WorkbenchExpectedArtifact (N per stage) ─────────────────────────────
CREATE TABLE "workbench_expected_artifacts" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "format" TEXT NOT NULL DEFAULT 'MARKDOWN',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "editable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbench_expected_artifacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workbench_expected_artifacts_stageId_kind_key"
    ON "workbench_expected_artifacts"("stageId", "kind");
CREATE INDEX "workbench_expected_artifacts_stageId_ordinal_idx"
    ON "workbench_expected_artifacts"("stageId", "ordinal");
ALTER TABLE "workbench_expected_artifacts"
    ADD CONSTRAINT "workbench_expected_artifacts_stageId_fkey"
    FOREIGN KEY ("stageId") REFERENCES "workbench_stages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 4. WorkbenchStageEdge (FORWARD + SEND_BACK between stages) ─────────────
CREATE TABLE "workbench_stage_edges" (
    "id" TEXT NOT NULL,
    "fromStageId" TEXT NOT NULL,
    "toStageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbench_stage_edges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workbench_stage_edges_fromStageId_toStageId_kind_key"
    ON "workbench_stage_edges"("fromStageId", "toStageId", "kind");
CREATE INDEX "workbench_stage_edges_fromStageId_idx"
    ON "workbench_stage_edges"("fromStageId");
CREATE INDEX "workbench_stage_edges_toStageId_idx"
    ON "workbench_stage_edges"("toStageId");
ALTER TABLE "workbench_stage_edges"
    ADD CONSTRAINT "workbench_stage_edges_fromStageId_fkey"
    FOREIGN KEY ("fromStageId") REFERENCES "workbench_stages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workbench_stage_edges"
    ADD CONSTRAINT "workbench_stage_edges_toStageId_fkey"
    FOREIGN KEY ("toStageId") REFERENCES "workbench_stages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 5. WorkbenchArtifactConsumes (which stage takes which producer's artifact) ─
CREATE TABLE "workbench_artifact_consumes" (
    "id" TEXT NOT NULL,
    "consumerStageId" TEXT NOT NULL,
    "producerArtifactId" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "inferred" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbench_artifact_consumes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workbench_artifact_consumes_consumerStageId_producerArtifactId_key"
    ON "workbench_artifact_consumes"("consumerStageId", "producerArtifactId");
CREATE INDEX "workbench_artifact_consumes_consumerStageId_idx"
    ON "workbench_artifact_consumes"("consumerStageId");
ALTER TABLE "workbench_artifact_consumes"
    ADD CONSTRAINT "workbench_artifact_consumes_consumerStageId_fkey"
    FOREIGN KEY ("consumerStageId") REFERENCES "workbench_stages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workbench_artifact_consumes"
    ADD CONSTRAINT "workbench_artifact_consumes_producerArtifactId_fkey"
    FOREIGN KEY ("producerArtifactId") REFERENCES "workbench_expected_artifacts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 6. WorkbenchStageQuestion (N per stage) ────────────────────────────────
CREATE TABLE "workbench_stage_questions" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "freeform" BOOLEAN NOT NULL DEFAULT true,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "options" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbench_stage_questions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "workbench_stage_questions_stageId_questionId_key"
    ON "workbench_stage_questions"("stageId", "questionId");
CREATE INDEX "workbench_stage_questions_stageId_ordinal_idx"
    ON "workbench_stage_questions"("stageId", "ordinal");
ALTER TABLE "workbench_stage_questions"
    ADD CONSTRAINT "workbench_stage_questions_stageId_fkey"
    FOREIGN KEY ("stageId") REFERENCES "workbench_stages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
