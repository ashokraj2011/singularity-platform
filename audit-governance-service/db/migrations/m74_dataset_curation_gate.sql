-- M74 Phase 2C — operator curation gate for eval datasets.
--
-- Datasets built directly from sweep traces (dataset-builder.ts) have
-- expected_output that's just the actual trace output. Treating that as
-- a gold standard turns evals into behavioral-consistency checks, not
-- correctness checks. If the prior trace was wrong, future runs that
-- produce the same wrong output pass; future runs that produce correct
-- output fail.
--
-- Fix: every example carries a `reviewed_at` timestamp. NULL = "not yet
-- curated by an operator; treat expected_output as a candidate, not
-- truth." EvalGate refuses to gate on un-reviewed by default; pass
-- `allow_unreviewed: true` in evaluator_config to opt back into raw-
-- dataset gating (intended for non-critical evaluators).
--
-- Also adds `reviewed_by` for audit and `review_notes` for the operator
-- to record why they edited or kept the expected_output. Idempotent
-- with IF NOT EXISTS so re-running this migration is safe.

ALTER TABLE audit_governance.engine_dataset_examples
  ADD COLUMN IF NOT EXISTS reviewed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by   TEXT,
  ADD COLUMN IF NOT EXISTS review_notes  TEXT;

-- Reading-pattern index: "show me the un-reviewed examples in this
-- dataset" is the operator's primary query.
CREATE INDEX IF NOT EXISTS idx_engine_examples_unreviewed
  ON audit_governance.engine_dataset_examples (dataset_id)
  WHERE reviewed_at IS NULL;
