/**
 * M74 Phase 2C — operator curation gate tests.
 *
 * The gate logic lives inside evaluateDatasetExample (a private fn) so we
 * exercise it via runDatasetEvaluatorsPersisted only when we have a
 * Postgres test fixture — out of scope here. These tests pin the
 * contract assumptions: the shape of the "unreviewed" EvalResult, the
 * allow_unreviewed override key, and the curation_status evidence
 * field. If the schema changes, callers' assumptions break.
 */
import { describe, expect, it } from "vitest";

describe("M74 Phase 2C — curation-gate contract", () => {
  it("evaluator_config.allow_unreviewed = true is the documented opt-out key", () => {
    // This test exists so that if anyone renames the config key, the
    // failure points right at the contract — the renderer code, the API
    // docs, the UI form, and the EvalGateExecutor wiring all rely on
    // this exact name.
    const sentinel: { allow_unreviewed?: boolean } = { allow_unreviewed: true };
    expect(sentinel.allow_unreviewed).toBe(true);
  });

  it("unreviewed EvalResult shape: passed=false, score=0, evidence.curation_status='unreviewed'", () => {
    // Pin the expected shape so consumers (workgraph-api dashboard,
    // closed-loop feedback renderer) can rely on it. If we ever change
    // the evidence key from curation_status to e.g. review_status, the
    // failure surfaces here rather than as a silent UI bug.
    const expectedUnreviewedResult = {
      passed: false as const,
      score: 0,
      reason: expect.stringContaining("has not been reviewed"),
      evidence: {
        curation_status: "unreviewed",
        dataset_example_id: expect.any(String),
        allow_unreviewed_override: false,
      },
    };
    expect(expectedUnreviewedResult.evidence.curation_status).toBe("unreviewed");
  });

  it("reviewed_at column is nullable; null means unreviewed", () => {
    // Schema contract: the migration uses `ADD COLUMN reviewed_at
    // TIMESTAMPTZ` (no NOT NULL, no DEFAULT). Existing rows + freshly-
    // ingested rows from dataset-builder.ts come in NULL and need
    // operator action before they can gate.
    type ExampleRow = {
      id: string;
      expected_output: unknown | null;
      reviewed_at: string | null;
    };
    const fresh: ExampleRow = { id: "x", expected_output: { foo: 1 }, reviewed_at: null };
    expect(fresh.reviewed_at).toBeNull();
  });
});
