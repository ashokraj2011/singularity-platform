-- M61 Slice B — Async bootstrap phase tracking.
--
-- Two additive columns on CapabilityBootstrapRun:
--   currentPhase  — short string ID of the worker currently executing
--                   (phase0_setup | phase1_discovery | phase2_ast_index |
--                    phase3_distillation | done). NULL on rows created
--                    before this migration.
--   phaseProgress — JSON map of phase name → { status, startedAt,
--                   completedAt, error?, stats? }. Defaults to {}.
--
-- Existing rows untouched. The columns are read by the new async
-- worker path (gated by BOOTSTRAP_ASYNC=true) and the bootstrap-run
-- status endpoint surfaces them so the wizard UI can show phase
-- progress without holding the HTTP request open.

ALTER TABLE "CapabilityBootstrapRun"
  ADD COLUMN "currentPhase" TEXT,
  ADD COLUMN "phaseProgress" JSONB NOT NULL DEFAULT '{}';
