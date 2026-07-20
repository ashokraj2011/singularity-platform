/**
 * Per-source ingest rate override.
 *
 * A single global ceiling (2000 events / 60s per ip:source:tenant) cannot fit
 * both a service emitting a handful of governance decisions an hour and the
 * llm-gateway emitting a row per LLM call — and embeddings are the highest-
 * volume traffic on the platform. Batching does not dodge the limit either
 * (weight counts as events.length by design), so without a per-source override
 * the cost emitter gets throttled the moment it is switched on. That makes
 * this override a hard prerequisite of the emitter, not a nicety.
 *
 * The override is parsed from JSON, which means it is the one place an
 * operator typo could accidentally DISABLE rate limiting. Every value goes
 * through the same bounds as the global limit for exactly that reason.
 */
import { describe, expect, it } from "vitest";
import { parseRateMaxBySource } from "../src/routes-events";

const GLOBAL = 2_000;

describe("AUDIT_GOV_EVENT_RATE_MAX_BY_SOURCE", () => {
  it("raises the ceiling for the named source only", () => {
    const parsed = parseRateMaxBySource('{"llm-gateway":20000}', GLOBAL);
    expect(parsed["llm-gateway"]).toBe(20_000);
    expect(parsed["context-fabric"]).toBeUndefined();
  });

  it("accepts several sources and numeric-or-string values", () => {
    const parsed = parseRateMaxBySource('{"llm-gateway":20000,"mcp-server":"5000"}', GLOBAL);
    expect(parsed).toEqual({ "llm-gateway": 20_000, "mcp-server": 5_000 });
  });

  it("can lower a limit as well as raise it", () => {
    expect(parseRateMaxBySource('{"chatty-service":10}', GLOBAL)["chatty-service"]).toBe(10);
  });

  it("caps an oversized value at the same maximum as the global limit", () => {
    // The important half: a fat-fingered extra zero must not become "unlimited".
    expect(parseRateMaxBySource('{"llm-gateway":999999999}', GLOBAL)["llm-gateway"]).toBe(100_000);
  });

  it("falls back to the global limit for values that are not usable", () => {
    // Zero and negatives are the dangerous ones — a raw Number() would have
    // let "0" through and rate-limited the source into silence, or let a
    // negative through and disabled the check entirely.
    expect(parseRateMaxBySource('{"a":0}', GLOBAL)["a"]).toBe(GLOBAL);
    expect(parseRateMaxBySource('{"a":-5}', GLOBAL)["a"]).toBe(GLOBAL);
    expect(parseRateMaxBySource('{"a":"nonsense"}', GLOBAL)["a"]).toBe(GLOBAL);
    expect(parseRateMaxBySource('{"a":"Infinity"}', GLOBAL)["a"]).toBe(GLOBAL);
  });

  it("truncates fractional values", () => {
    expect(parseRateMaxBySource('{"a":12.9}', GLOBAL)["a"]).toBe(12);
  });

  it("ignores non-scalar values and blank keys rather than crashing", () => {
    const parsed = parseRateMaxBySource('{"a":{"nested":1},"b":[1],"c":null,"  ":5}', GLOBAL);
    expect(parsed).toEqual({});
  });

  it("returns an empty map for unset, blank, malformed, or non-object config", () => {
    // Malformed config must degrade to "everyone uses the global limit", never
    // to a boot failure and never to no limit at all.
    expect(parseRateMaxBySource(undefined, GLOBAL)).toEqual({});
    expect(parseRateMaxBySource("", GLOBAL)).toEqual({});
    expect(parseRateMaxBySource("   ", GLOBAL)).toEqual({});
    expect(parseRateMaxBySource("{not json", GLOBAL)).toEqual({});
    expect(parseRateMaxBySource("[1,2,3]", GLOBAL)).toEqual({});
    expect(parseRateMaxBySource('"a string"', GLOBAL)).toEqual({});
    expect(parseRateMaxBySource("null", GLOBAL)).toEqual({});
  });

  it("trims whitespace around source names so a padded key still matches", () => {
    expect(parseRateMaxBySource('{" llm-gateway ":9000}', GLOBAL)["llm-gateway"]).toBe(9_000);
  });
});

describe("rate limiter wiring", () => {
  it("resolves the limit per source and reports it on the 429", () => {
    const source = require("node:fs").readFileSync(
      require("node:path").join(process.cwd(), "src/routes-events.ts"),
      "utf8",
    ) as string;
    // The override is worthless if rateLimit() still compares against the
    // global constant, so pin the wiring: the per-source lookup is what the
    // comparison and the 429 body use.
    expect(source).toContain("const limit = rateLimitMaxFor(sourceOf(req));");
    expect(source).toContain("current.count + weight > limit");
    expect(source).not.toContain("current.count + weight > RATE_LIMIT_MAX");
    // Batch weight still counts every event; an override must not be reachable
    // by wrapping traffic in a batch instead.
    expect(source).toContain("const weight = Array.isArray(req.body?.events) ? req.body.events.length : 1;");
  });
});
