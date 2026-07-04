import { describe, expect, it } from "vitest";
import { boundedInteger } from "../src/env";

describe("boundedInteger", () => {
  const options = { defaultValue: 50, min: 1, max: 1_000 };

  it("uses the default for unset, blank, malformed, non-finite, and below-min values", () => {
    expect(boundedInteger(undefined, options)).toBe(50);
    expect(boundedInteger("", options)).toBe(50);
    expect(boundedInteger("not-a-number", options)).toBe(50);
    expect(boundedInteger("Infinity", options)).toBe(50);
    expect(boundedInteger("0", options)).toBe(50);
  });

  it("truncates fractional values and caps oversized values", () => {
    expect(boundedInteger("12.9", options)).toBe(12);
    expect(boundedInteger(75.4, options)).toBe(75);
    expect(boundedInteger("5000", options)).toBe(1_000);
  });

  it("rejects invalid helper bounds", () => {
    expect(() => boundedInteger("5", { defaultValue: 10, min: 20, max: 30 })).toThrow(
      "invalid bounded integer options",
    );
  });
});
