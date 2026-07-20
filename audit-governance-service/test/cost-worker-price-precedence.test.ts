/**
 * Behaviour: which of the two price sources produces llm_calls.cost_usd.
 *
 * The sibling contract test asserts on the SOURCE TEXT of cost-worker.ts, which
 * catches a reordering but cannot prove the reorder actually changed what gets
 * written. This one runs the real denormaliseLlmCall against a mocked ./db and
 * inspects the parameters it binds, so the precedence is verified as behaviour.
 *
 * No Postgres needed: pg's Pool does not connect until a query is issued, and
 * every query goes through ./db, which is mocked out entirely.
 *
 * The rule under test — the gateway catalog price wins, rate_card is the
 * historical fallback — matters because the two sources are keyed differently.
 * The catalog prices per ALIAS; rate_card is keyed (provider, model) and cannot
 * express two aliases on one model priced differently. Five aliases in the
 * shipped catalog resolve to claude-sonnet-4-6 today, so the moment one of them
 * is priced differently the rate_card lookup would reprice all five to whichever
 * single row matched, silently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const queryOne = vi.fn();

vi.mock("../src/db", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
}));

const { denormaliseLlmCall } = await import("../src/cost-worker");

/** A rate card that is DELIBERATELY not the catalog price, so whichever source
 *  won is unambiguous from the number alone. */
const RATE_CARD_ROW = {
  id: "rate-card-uuid-1",
  input_per_1k_usd: "0.003000",
  output_per_1k_usd: "0.015000",
};
/** 1000 in + 1000 out against RATE_CARD_ROW. */
const RATE_CARD_COST = 0.018;
/** Nothing near RATE_CARD_COST, so a mix-up cannot coincidentally pass. */
const CATALOG_COST = 0.000777;

const BASE_PAYLOAD = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  input_tokens: 1000,
  output_tokens: 1000,
  gateway_call_id: "6f1a9c4e-3b2d-4f8a-9c1e-7d5b2a8f0c31",
};

/** Column name → bound value for the llm_calls INSERT, read positionally off
 *  the statement itself so the mapping cannot drift from the real SQL. */
function insertedRow(): Record<string, unknown> {
  const call = query.mock.calls.find(
    (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO audit_governance.llm_calls"),
  );
  if (!call) throw new Error("no llm_calls INSERT was issued");
  const sql = call[0] as string;
  const params = call[1] as unknown[];
  const columns = sql
    .slice(sql.indexOf("(") + 1, sql.indexOf("VALUES"))
    .replace(/\)\s*$/, "")
    .split(",")
    .map((c) => c.replace(/[()\s]/g, ""))
    .filter(Boolean);
  return Object.fromEntries(columns.map((c, i) => [c, params[i]]));
}

async function run(payload: Record<string, unknown>) {
  await denormaliseLlmCall("event-1", "trace-1", "cap-1", "tenant-1", payload);
  return insertedRow();
}

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  // The INSERT returns a row id — i.e. not a deduped retry.
  query.mockResolvedValue([{ id: "llm-call-1" }]);
  // Every rate_card lookup matches, so a fallback that fires when it should not
  // is loud rather than invisible.
  queryOne.mockResolvedValue(RATE_CARD_ROW);
});

describe("cost-worker price precedence", () => {
  it("uses the payload's catalog price even when a rate card also matches", () => {
    // The whole point: a matching rate card no longer overrides the price the
    // gateway actually charged.
    return run({ ...BASE_PAYLOAD, cost_usd: CATALOG_COST, price_source: "gateway_catalog" })
      .then((row) => {
        expect(row.cost_usd).toBe(CATALOG_COST);
        expect(row.price_source).toBe("gateway_catalog");
        // NULL, not the id of a card that did not produce this number. A
        // populated rate_card_id here would make the provenance column lie.
        expect(row.rate_card_id).toBeNull();
      });
  });

  it("does not even look up a rate card when the payload carries a price", async () => {
    await run({ ...BASE_PAYLOAD, cost_usd: CATALOG_COST, price_source: "gateway_catalog" });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("falls back to the rate card when the payload carries no price", async () => {
    // The laptop shim and every pre-M75 emitter land here, as does every row
    // already written.
    const row = await run({ ...BASE_PAYLOAD });
    expect(row.cost_usd).toBeCloseTo(RATE_CARD_COST, 10);
    expect(row.price_source).toBe("rate_card");
    expect(row.rate_card_id).toBe(RATE_CARD_ROW.id);
  });

  it("leaves cost NULL when neither source can price the call", async () => {
    queryOne.mockResolvedValue(null);
    const row = await run({ ...BASE_PAYLOAD });
    expect(row.cost_usd).toBeNull();
    expect(row.price_source).toBeNull();
    expect(row.rate_card_id).toBeNull();
    // The row still lands — token rollups do not need a price.
    expect(row.total_tokens).toBe(2000);
  });

  it("records an undeclared payload price as emitter_catalog, not gateway_catalog", async () => {
    // A payload carrying a cost but no price_source did not tell us where the
    // number came from. Stamping it "gateway_catalog" would invent provenance.
    const row = await run({ ...BASE_PAYLOAD, cost_usd: CATALOG_COST });
    expect(row.price_source).toBe("emitter_catalog");
    expect(row.cost_usd).toBe(CATALOG_COST);
  });

  it("bumps budgets with the catalog price, not the rate card price", async () => {
    // Budgets are the consumer that would silently drift if the enforced spend
    // and the charged spend came from different price sources.
    await run({ ...BASE_PAYLOAD, cost_usd: CATALOG_COST, price_source: "gateway_catalog" });
    const budgetCalls = query.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("budget"),
    );
    expect(budgetCalls.length).toBeGreaterThan(0);
    for (const call of budgetCalls) {
      expect(call[1]).toContain(CATALOG_COST);
      expect(call[1]).not.toContain(RATE_CARD_COST);
    }
  });

  it("does not mix price sources when costing a savings row", async () => {
    // token_savings_runs subtracts estimated_optimized_cost (costUsd) from
    // estimated_raw_cost (derived from the per-1k rates). Feeding it rate_card
    // rates alongside a catalog-priced costUsd would subtract two different
    // price sources and report a saving no single price ever produced — and
    // when the catalog is dearer than the card it would clamp to zero, hiding a
    // real saving. On a catalog-priced row the rates are unknown, so raw cost
    // is 0 and no COST saving is claimed; the TOKEN saving still lands.
    const row = await run({
      ...BASE_PAYLOAD,
      cost_usd: CATALOG_COST,
      price_source: "gateway_catalog",
      cache_read_tokens: 5000,
    });
    expect(row).toBeTruthy();
    const savings = query.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("token_savings_runs"),
    );
    expect(savings, "no token_savings_runs INSERT was issued").toBeTruthy();
    const params = savings![1] as unknown[];
    // estimated_raw_cost, estimated_optimized_cost, estimated_cost_saved are
    // positions 12/13/14 (1-indexed) in that INSERT.
    expect(params[11]).toBe(0);
    expect(params[12]).toBe(CATALOG_COST);
    expect(params[13]).toBe(0);
    // The token side is unaffected: 5000 cache-read + 1000 input = 6000 raw.
    expect(params[6]).toBe(6000);
    expect(params[9]).toBe(5000);
  });

  it("still costs a savings row from the rate card when it priced the call", async () => {
    // The fallback path keeps its existing, internally-consistent maths: both
    // sides of the subtraction come from the same rate card.
    await run({ ...BASE_PAYLOAD, cache_read_tokens: 5000 });
    const savings = query.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("token_savings_runs"),
    );
    const params = savings![1] as unknown[];
    // 6000 in + 1000 out at the card's rates.
    expect(params[11] as number).toBeCloseTo(0.033, 10);
    expect(params[12] as number).toBeCloseTo(RATE_CARD_COST, 10);
    expect(params[13] as number).toBeCloseTo(0.015, 10);
  });

  it("skips budgets and savings when the INSERT was deduped as a retry", async () => {
    // ON CONFLICT DO NOTHING returns no rows. Everything downstream of the row
    // must be skipped too, or a retried emission double-counts the spend the
    // unique index exists to prevent.
    query.mockResolvedValue([]);
    await denormaliseLlmCall("event-1", "trace-1", "cap-1", "tenant-1", {
      ...BASE_PAYLOAD,
      cost_usd: CATALOG_COST,
      price_source: "gateway_catalog",
      cache_read_tokens: 5000,
    });
    const followUps = query.mock.calls.filter(
      (c) => typeof c[0] === "string" && !c[0].includes("INSERT INTO audit_governance.llm_calls"),
    );
    expect(followUps).toHaveLength(0);
  });
});
