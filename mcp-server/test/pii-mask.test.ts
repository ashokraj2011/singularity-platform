/**
 * M39.1 — Unit tests for PII detection + masking + un-masking.
 *
 * These prove the invariant the whole feature depends on:
 *   - Round-trip: maskPii() → unmaskPiiInArgs() recovers original values
 *   - Stable tokens: same value in same run → same token
 *   - No collision: phone digits that happen to overlap a credit-card pattern
 *     don't get the same token
 *   - Luhn validation: 16-digit IDs that aren't real card numbers don't get masked
 *   - Non-overlapping spans: SSN inside a longer ZIP+9 string resolves to the longer match
 */
import { describe, it, expect } from "vitest";
import { detectPii } from "../src/security/pii-detector";
import { maskPii, unmaskPiiInArgs, unmaskString } from "../src/security/mask";

describe("M39.1 PII detector — regex baseline", () => {
  it("detects SSN", () => {
    const m = detectPii("Customer SSN is 123-45-6789. Verify identity.");
    expect(m).toHaveLength(1);
    expect(m[0].kind).toBe("ssn");
    expect(m[0].value).toBe("123-45-6789");
  });

  it("detects email", () => {
    const m = detectPii("Send to alice.smith@example.com please");
    expect(m).toHaveLength(1);
    expect(m[0].kind).toBe("email");
    expect(m[0].value).toBe("alice.smith@example.com");
  });

  it("detects US phone with various formats", () => {
    const m = detectPii("Call 415-555-1212 or +1 (212) 555-9999.");
    expect(m).toHaveLength(2);
    expect(m.every((x) => x.kind === "phone")).toBe(true);
  });

  it("Luhn-validates credit cards (rejects 16-digit non-cards)", () => {
    // 4242 4242 4242 4242 is a valid test card; 1234 5678 9012 3456 is not
    const m = detectPii("test 4242 4242 4242 4242 vs garbage 1234 5678 9012 3456");
    const cards = m.filter((x) => x.kind === "credit_card");
    expect(cards).toHaveLength(1);
    expect(cards[0].value.replace(/\s/g, "")).toBe("4242424242424242");
  });

  it("ZIP+9 doesn't trip the SSN matcher", () => {
    const m = detectPii("Ship to ZIP 94103-2102 please");
    expect(m).toHaveLength(1);
    expect(m[0].kind).toBe("zip9");
  });

  it("returns empty for clean text", () => {
    expect(detectPii("hello world, no PII here")).toEqual([]);
  });
});

describe("M39.1 maskPii — token allocation", () => {
  it("replaces PII with stable tokens", () => {
    const { masked, tokenMap } = maskPii("Email alice@example.com about SSN 123-45-6789");
    expect(masked).toMatch(/Email \[EMAIL_1\] about SSN \[SSN_1\]/);
    expect(tokenMap["[EMAIL_1]"]).toBe("alice@example.com");
    expect(tokenMap["[SSN_1]"]).toBe("123-45-6789");
  });

  it("reuses tokens for the same value", () => {
    let map: Record<string, string> = {};
    const r1 = maskPii("alice@example.com is alice", map);
    map = r1.tokenMap;
    const r2 = maskPii("alice@example.com again", map);
    // Same email → same token across calls
    expect(r2.masked).toContain("[EMAIL_1]");
    expect(Object.keys(r2.tokenMap)).toHaveLength(1);
  });

  it("allocates sequential numbers per kind", () => {
    const { tokenMap } = maskPii("alice@a.com, bob@b.com, carol@c.com");
    expect(tokenMap["[EMAIL_1]"]).toBe("alice@a.com");
    expect(tokenMap["[EMAIL_2]"]).toBe("bob@b.com");
    expect(tokenMap["[EMAIL_3]"]).toBe("carol@c.com");
  });

  it("doesn't collide tokens across kinds", () => {
    const { tokenMap } = maskPii("alice@a.com / 415-555-1212");
    expect(tokenMap["[EMAIL_1]"]).toBe("alice@a.com");
    expect(tokenMap["[PHONE_1]"]).toBe("415-555-1212");
  });

  it("returns empty applied[] when no PII found", () => {
    const r = maskPii("hello world");
    expect(r.applied).toEqual([]);
    expect(r.masked).toBe("hello world");
  });
});

describe("M39.1 unmaskString + unmaskPiiInArgs — round-trip", () => {
  it("unmaskString swaps tokens back to real values", () => {
    const map = { "[EMAIL_1]": "alice@example.com", "[SSN_1]": "123-45-6789" };
    const text = "Send [EMAIL_1] their SSN [SSN_1]";
    expect(unmaskString(text, map)).toBe("Send alice@example.com their SSN 123-45-6789");
  });

  it("leaves unknown tokens untouched (model invented one)", () => {
    const map = { "[EMAIL_1]": "alice@example.com" };
    expect(unmaskString("Send to [EMAIL_2]", map)).toBe("Send to [EMAIL_2]");
  });

  it("unmaskPiiInArgs walks objects and arrays recursively", () => {
    const map = { "[EMAIL_1]": "alice@example.com" };
    const args = {
      to: "[EMAIL_1]",
      cc: ["[EMAIL_1]", "no-pii-here"],
      meta: { from: "[EMAIL_1]", body: "hello" },
    };
    const out = unmaskPiiInArgs(args, map);
    expect(out.to).toBe("alice@example.com");
    expect(out.cc).toEqual(["alice@example.com", "no-pii-here"]);
    expect(out.meta.from).toBe("alice@example.com");
    expect(out.meta.body).toBe("hello");
  });

  it("mask → unmask is an identity (round-trip)", () => {
    const original = "Email alice@example.com / SSN 123-45-6789 / phone 415-555-1212";
    const { masked, tokenMap } = maskPii(original);
    expect(masked).not.toContain("alice@example.com");
    expect(unmaskString(masked, tokenMap)).toBe(original);
  });

  it("multiple-occurrence value gets the same token across mask + unmask", () => {
    const original = "alice@example.com replied. Send back to alice@example.com.";
    const { masked, tokenMap } = maskPii(original);
    expect(masked.match(/\[EMAIL_1\]/g) ?? []).toHaveLength(2);
    expect(unmaskString(masked, tokenMap)).toBe(original);
  });
});
