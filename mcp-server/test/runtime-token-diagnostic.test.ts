import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  RUNTIME_TOKEN_MAX_BYTES,
  runtimeTokenDiagnostic,
} from "../src/laptop/runtime-token-diagnostic";

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signedToken(payload: unknown, header: unknown = { alg: "HS256", typ: "JWT" }): string {
  const head = b64(header);
  const body = b64(payload);
  const sig = createHmac("sha256", "not-verified-here").update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

describe("runtimeTokenDiagnostic", () => {
  it("extracts bounded runtime identity without exposing the token", () => {
    const diagnostic = runtimeTokenDiagnostic(signedToken({
      kind: "runtime",
      sub: "u".repeat(150),
      runtime_id: "r".repeat(150),
      device_id: "d".repeat(150),
      tenant_id: "t".repeat(150),
      shared: true,
      exp: Math.floor(Date.now() / 1000) + 60,
    }));

    expect(diagnostic.valid).toBe(true);
    if (diagnostic.valid) {
      expect(diagnostic.kind).toBe("runtime");
      expect(diagnostic.sub).toHaveLength(128);
      expect(diagnostic.runtime_id).toHaveLength(128);
      expect(diagnostic.device_id).toHaveLength(128);
      expect(diagnostic.tenant_id).toHaveLength(128);
      expect(diagnostic.shared).toBe(true);
      expect(diagnostic.expired).toBe(false);
      expect(diagnostic.expires_at).toContain("T");
    }
  });

  it("marks expired tokens without treating them as undecodable", () => {
    const diagnostic = runtimeTokenDiagnostic(signedToken({
      kind: "runtime",
      sub: "user-a",
      runtime_id: "runtime-a",
      exp: Math.floor(Date.now() / 1000) - 10,
    }));

    expect(diagnostic.valid).toBe(true);
    if (diagnostic.valid) expect(diagnostic.expired).toBe(true);
  });

  it("rejects malformed, oversized, non-object, unsupported alg, and missing-exp tokens", () => {
    expect(runtimeTokenDiagnostic("not-a-jwt").valid).toBe(false);

    const oversized = `${"x".repeat(RUNTIME_TOKEN_MAX_BYTES + 1)}.y.z`;
    expect(runtimeTokenDiagnostic(oversized)).toMatchObject({ valid: false, error: "token too long" });

    expect(runtimeTokenDiagnostic(signedToken({ exp: Date.now() / 1000 + 60 }, ["not-object"]))).toMatchObject({
      valid: false,
      error: "bad JWT header",
    });
    expect(runtimeTokenDiagnostic(signedToken(["not-object"]))).toMatchObject({
      valid: false,
      error: "bad JWT payload",
    });
    expect(runtimeTokenDiagnostic(signedToken({ exp: Date.now() / 1000 + 60 }, { alg: "none" }))).toMatchObject({
      valid: false,
      error: "unsupported alg: none",
    });
    expect(runtimeTokenDiagnostic(signedToken({ kind: "runtime" }))).toMatchObject({
      valid: false,
      error: "missing or invalid exp",
    });
  });
});
