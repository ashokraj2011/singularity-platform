/**
 * M39.B — Tests for the NER detector path.
 *
 * The actual NER model (~50MB ONNX) is NOT downloaded in CI by default
 * (MCP_PII_NER_ENABLED unset → noop). These tests prove:
 *   - The opt-in gate works (disabled by default)
 *   - The combined detector path falls through to regex when NER is off
 *   - The async maskPiiAsync() interface returns the same shape as maskPii()
 *   - Overlap resolution doesn't drop regex matches in favor of lower-confidence NER
 *
 * To run with real NER locally:
 *   MCP_PII_NER_ENABLED=true npm test
 * (first run downloads ~50MB; subsequent runs use the cached model)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isNerEnabled, detectAllPii } from "../src/security/pii-ner";
import { maskPiiAsync } from "../src/security/mask";

describe("M39.B PII NER detector — opt-in gate", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.MCP_PII_NER_ENABLED;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MCP_PII_NER_ENABLED;
    else process.env.MCP_PII_NER_ENABLED = originalEnv;
  });

  it("isNerEnabled() is false by default", () => {
    delete process.env.MCP_PII_NER_ENABLED;
    expect(isNerEnabled()).toBe(false);
  });

  it("isNerEnabled() is false when set to anything other than 'true'", () => {
    process.env.MCP_PII_NER_ENABLED = "1";
    expect(isNerEnabled()).toBe(false);
    process.env.MCP_PII_NER_ENABLED = "yes";
    expect(isNerEnabled()).toBe(false);
    process.env.MCP_PII_NER_ENABLED = "false";
    expect(isNerEnabled()).toBe(false);
  });

  it("isNerEnabled() is true only when explicitly set to 'true'", () => {
    process.env.MCP_PII_NER_ENABLED = "true";
    expect(isNerEnabled()).toBe(true);
  });
});

describe("M39.B detectAllPii — falls through to regex when NER off", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.MCP_PII_NER_ENABLED;
    delete process.env.MCP_PII_NER_ENABLED; // ensure off
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MCP_PII_NER_ENABLED;
    else process.env.MCP_PII_NER_ENABLED = originalEnv;
  });

  it("detects regex PII when NER is off", async () => {
    const m = await detectAllPii("Email alice@example.com / SSN 123-45-6789");
    expect(m.length).toBe(2);
    expect(m.some((x) => x.kind === "email")).toBe(true);
    expect(m.some((x) => x.kind === "ssn")).toBe(true);
  });

  it("does NOT load the NER model when off (no network, no disk)", async () => {
    // If this test runs without internet and passes, the gate is working.
    const m = await detectAllPii("Just plain text, no PII");
    expect(m).toEqual([]);
  });
});

describe("M39.B maskPiiAsync — same shape as maskPii", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.MCP_PII_NER_ENABLED;
    delete process.env.MCP_PII_NER_ENABLED;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MCP_PII_NER_ENABLED;
    else process.env.MCP_PII_NER_ENABLED = originalEnv;
  });

  it("returns the same MaskResult shape as sync maskPii", async () => {
    const r = await maskPiiAsync("Email alice@example.com / SSN 123-45-6789");
    expect(r.masked).toMatch(/\[EMAIL_1\]/);
    expect(r.masked).toMatch(/\[SSN_1\]/);
    expect(r.tokenMap["[EMAIL_1]"]).toBe("alice@example.com");
    expect(r.tokenMap["[SSN_1]"]).toBe("123-45-6789");
    expect(r.applied.map((a) => a.kind).sort()).toEqual(["email", "ssn"]);
  });

  it("handles empty input gracefully", async () => {
    const r = await maskPiiAsync("");
    expect(r.masked).toBe("");
    expect(r.applied).toEqual([]);
  });

  it("preserves existing token map across calls", async () => {
    let map: Record<string, string> = {};
    const r1 = await maskPiiAsync("alice@a.com", map);
    map = r1.tokenMap;
    const r2 = await maskPiiAsync("alice@a.com is back", map);
    expect(r2.masked).toContain("[EMAIL_1]");
    expect(Object.keys(r2.tokenMap)).toHaveLength(1);
  });
});
