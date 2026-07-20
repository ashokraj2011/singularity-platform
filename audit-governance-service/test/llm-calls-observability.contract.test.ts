/**
 * Contract: the m75 llm_calls migration.
 *
 * Behavioural verification was done against a throwaway Postgres 16 (init.sql +
 * every migration in sort order, applied TWICE, matching what bin/docker-core.sh
 * and bin/bare-metal.sh do at boot). CI has no Postgres, so these assertions pin
 * the properties that verification established, plus the two that would break
 * production silently if someone edited the file:
 *
 *   - re-runnability, because every file here is re-applied on every boot under
 *     ON_ERROR_STOP=1; a non-repeatable statement is a startup failure
 *   - the partial unique index, because a plain UNIQUE would reject the second
 *     legacy/laptop row (they carry NULL) and a non-unique index would let a
 *     retried emission double-count spend
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(
  path.join(process.cwd(), "db/migrations/m75_llm_call_observability.sql"),
  "utf8",
);

describe("m75 llm_calls observability migration", () => {
  it("scopes itself to the audit_governance schema", () => {
    // m71 omits this and its guard silently no-ops forever as a result — the
    // index it claims to create has never existed in any deployment.
    expect(migration).toMatch(/SET search_path = audit_governance, public;/);
  });

  it("is re-runnable: every ALTER and CREATE is guarded", () => {
    const alters = migration.match(/ALTER TABLE[^;]+;/g) ?? [];
    expect(alters.length).toBeGreaterThan(0);
    for (const stmt of alters) {
      expect(stmt, stmt).toMatch(/ADD COLUMN IF NOT EXISTS/);
    }
    const indexes = migration.match(/CREATE (?:UNIQUE )?INDEX[^;]+;/g) ?? [];
    expect(indexes.length).toBeGreaterThan(0);
    for (const stmt of indexes) {
      expect(stmt, stmt).toMatch(/IF NOT EXISTS/);
    }
  });

  it("adds the identity column that made per-user cost unanswerable", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS actor_id\s+TEXT/);
  });

  it("records routing provenance, not just the model that ran", () => {
    for (const col of ["model_alias", "task_tag", "stage", "purpose", "routing_source"]) {
      expect(migration, col).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\s`));
    }
  });

  it("records degradation loudly", () => {
    // Budget-aware downgrade is the hardest failure mode here to debug. If it
    // isn't on the row, a quality regression is indistinguishable from model
    // flakiness weeks later.
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS degraded_from/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS degrade_reason/);
  });

  it("distinguishes degradation from availability failover", () => {
    // Different causes, different remedies: one is budget policy, the other is
    // a provider being down. Collapsing them into one column loses that.
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS fallback_from/);
  });

  it("records which price source produced cost_usd", () => {
    // The gateway catalog is per-alias; rate_card is keyed (provider, model) and
    // cannot express two aliases on one model priced differently. They can
    // disagree, so the row must say which one it used.
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS price_source/);
  });

  it("stores content fingerprints, never content", () => {
    expect(migration).toMatch(/prompt_sha256/);
    expect(migration).toMatch(/response_sha256/);
    // llm_calls is aggregated; prompt bodies here would make every rollup drag
    // megabytes and tie retention policy to the noisiest column.
    expect(migration).not.toMatch(/ADD COLUMN IF NOT EXISTS prompt_text/);
    expect(migration).not.toMatch(/ADD COLUMN IF NOT EXISTS response_text/);
  });

  it("makes a duplicated emission a constraint violation, not double-counted spend", () => {
    const idx = migration.match(/CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_calls_gateway_call[^;]+;/s)?.[0];
    expect(idx).toBeTruthy();
    expect(idx).toMatch(/ON llm_calls\(gateway_call_id\)/);
    // Partial is load-bearing in BOTH directions: without the WHERE clause the
    // second NULL-bearing legacy row would be rejected outright.
    expect(idx).toMatch(/WHERE gateway_call_id IS NOT NULL/);
  });

  it("indexes the two questions the table now exists to answer", () => {
    expect(migration).toMatch(/idx_llm_calls_actor_time[\s\S]*?actor_id, created_at DESC/);
    expect(migration).toMatch(/idx_llm_calls_tenant_time[\s\S]*?tenant_id, created_at DESC/);
  });
});
