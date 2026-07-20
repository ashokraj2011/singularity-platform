/**
 * Contract: the llm_calls INSERT in cost-worker.ts.
 *
 * Behavioural verification was done against a throwaway Postgres 16 — init.sql
 * plus every migration in sort order, applied TWICE (what bin/docker-core.sh
 * and bin/bare-metal.sh do at boot), then the exact statement below. Confirmed
 * there:
 *
 *   - the 29-column INSERT runs
 *   - ON CONFLICT on the m75 PARTIAL unique index infers correctly, which is
 *     not obvious: it requires the WHERE clause to match the index predicate
 *   - a retried emission returns zero rows, so the budget bump is skipped
 *   - several legacy rows carrying NULL gateway_call_id still coexist
 *   - the per-actor cost rollup, the query this table now exists to answer,
 *     returns
 *
 * CI has no Postgres, so these assertions pin the properties that verification
 * established — in particular the two that would fail SILENTLY in production:
 * a column missing from the INSERT (the m75 column stays NULL forever and the
 * table still cannot say who spent what) and a dropped ON CONFLICT clause (a
 * retried emission throws a unique violation out of an inline denormaliser,
 * 500ing POST /events for an event that was already recorded).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src/cost-worker.ts"), "utf8");

// The template literal holding the statement, backtick excluded.
const insert = source.match(/INSERT INTO audit_governance\.llm_calls[\s\S]*?RETURNING id(?=`)/)?.[0] ?? "";

describe("cost-worker llm_calls INSERT", () => {
  it("writes every M75 column, not just the original cost shape", () => {
    // Each of these is a column the m75 migration added. Missing one here means
    // the migration shipped a column that nothing ever fills.
    for (const col of [
      "actor_id", "model_alias", "task_tag", "stage", "purpose", "endpoint",
      "routing_source", "degraded_from", "degrade_reason", "fallback_from",
      "price_source", "gateway_call_id",
      "prompt_sha256", "response_sha256", "prompt_chars", "response_chars",
    ]) {
      expect(insert, `${col} is not written by the INSERT`).toContain(col);
    }
  });

  it("binds exactly as many placeholders as it names columns", () => {
    const columns = insert
      .slice(insert.indexOf("("), insert.indexOf("VALUES"))
      .split(",")
      .map((c) => c.replace(/[()\s]/g, ""))
      .filter(Boolean);
    const placeholders = new Set(insert.match(/\$\d+/g) ?? []);
    expect(placeholders.size).toBe(columns.length);
    // Contiguous from $1 — an off-by-one here is a runtime bind error on every
    // single cost row, i.e. the table stays empty exactly as it is today.
    for (let i = 1; i <= columns.length; i++) {
      expect(placeholders.has(`$${i}`), `missing $${i}`).toBe(true);
    }
  });

  it("dedupes a retried emission instead of raising or double-counting", () => {
    // Partial-index inference needs the predicate to match m75's index exactly.
    expect(insert).toMatch(/ON CONFLICT \(gateway_call_id\) WHERE gateway_call_id IS NOT NULL/);
    expect(insert).toMatch(/DO NOTHING/);
    // RETURNING id is what makes the conflict detectable in JS — without it a
    // duplicate would still bump budgets, double-counting the very spend the
    // unique index exists to protect.
    expect(insert).toMatch(/RETURNING id$/);
    expect(source).toContain("if (inserted.length === 0) return;");
  });

  it("prefers the payload's catalog price and falls back to the rate card", () => {
    // Order matters, and it is the REVERSE of what shipped in M75. The gateway
    // catalog prices per alias; rate_card is keyed (provider, model) and cannot
    // express two aliases on one model priced differently. The catalog price is
    // the one the gateway actually charged, so it wins; rate_card only prices
    // payloads that carry no price of their own.
    //
    // Behavioural coverage of the same rule is in cost-worker-price-precedence
    // .test.ts, which runs the real function against a mocked db. This
    // assertion is the cheap structural backstop: it fails if someone reorders
    // the branches back without touching behaviour-visible code.
    const catalogBranch = source.indexOf("costUsd = p.cost_usd;");
    const rateBranch = source.indexOf('priceSource = "rate_card"');
    expect(catalogBranch).toBeGreaterThan(-1);
    expect(rateBranch).toBeGreaterThan(catalogBranch);
    expect(source).toContain('p.price_source ?? "emitter_catalog"');
  });

  it("does not query the rate card when the payload already carries a price", () => {
    // The lookup must sit INSIDE the fallback branch, not before it. A rate
    // card SELECT on every call would be a wasted round trip per LLM egress on
    // the hottest path audit-gov has, and it would tempt a future edit into
    // reusing that row for a price it did not produce.
    const catalogBranch = source.indexOf("costUsd = p.cost_usd;");
    const lookup = source.indexOf("FROM audit_governance.rate_card");
    expect(lookup).toBeGreaterThan(catalogBranch);
  });

  it("never writes prompt or response text", () => {
    // llm_calls is aggregated. Text here would make every rollup drag megabytes
    // and tie retention policy to the noisiest column.
    expect(insert).not.toMatch(/prompt_text/);
    expect(insert).not.toMatch(/response_text/);
    expect(insert).not.toMatch(/\bcontent\b/);
  });
});
