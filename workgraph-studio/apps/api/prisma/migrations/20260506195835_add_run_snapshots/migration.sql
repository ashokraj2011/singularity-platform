-- ─────────────────────────────────────────────────────────────────────────────
-- Browser-runtime snapshot table.
--
-- The browser owns the runtime state machine. The server is durable storage
-- only: a single row per run, holding the entire RunState as JSONB plus a
-- monotonic `version` for optimistic concurrency.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "run_snapshots" (
  "id"          TEXT        NOT NULL,
  "runId"       TEXT        NOT NULL,
  "workflowId"  TEXT        NOT NULL,
  "name"        TEXT        NOT NULL,
  "status"      TEXT        NOT NULL,
  "payload"     JSONB       NOT NULL,
  "version"     INTEGER     NOT NULL DEFAULT 1,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "run_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "run_snapshots_runId_key"        ON "run_snapshots"("runId");
CREATE INDEX        "run_snapshots_workflowId_idx"   ON "run_snapshots"("workflowId");
CREATE INDEX        "run_snapshots_createdById_idx"  ON "run_snapshots"("createdById");
CREATE INDEX        "run_snapshots_status_idx"       ON "run_snapshots"("status");

ALTER TABLE "run_snapshots"
  ADD CONSTRAINT "run_snapshots_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "workflow_templates"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
