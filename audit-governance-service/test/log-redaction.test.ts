import { describe, expect, it } from "vitest";
import { redactLogText, redactLogValue } from "../src/log-redaction";

describe("log ingest redaction", () => {
  it("redacts bearer, provider, JWT, URL, and assignment credentials", () => {
    const input = [
      "Bearer abcdefghijklmnopqrstuvwxyz",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OTAifQ.dGVzdHNpZ25hdHVyZXZhbHVlMTIzNDU2",
      "postgresql://operator:super-secret@db.internal/app",
      "password=hunter2",
    ].join(" ");
    const output = redactLogText(input);
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(output).not.toContain("super-secret");
    expect(output).not.toContain("hunter2");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts nested secret fields but preserves readiness metadata", () => {
    expect(redactLogValue({
      provider: { api_key: "secret-value", tokenPresent: true, token_count: 42 },
      password: "hunter2",
    })).toEqual({
      provider: { api_key: "[REDACTED]", tokenPresent: true, token_count: 42 },
      password: "[REDACTED]",
    });
  });
});
