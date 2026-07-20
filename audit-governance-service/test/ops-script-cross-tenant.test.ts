/**
 * Contract: bin/check-audit-governance-lifecycle.py refuses to run without the
 * cross-tenant credential.
 *
 * The script reads audit events across tenants. Once the query surface is
 * enforcing, a run without AUDIT_GOV_CROSS_TENANT_TOKEN would either 400 or --
 * worse -- silently narrow to whatever single tenant it could resolve and still
 * print "passed". A smoke check that reports success without having verified
 * anything is more dangerous than one that fails, so the refusal is the
 * behaviour under test.
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(__dirname, "..", "..", "bin", "check-audit-governance-lifecycle.py");

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("audit-governance lifecycle ops script", () => {
  const source = readFileSync(SCRIPT, "utf8");

  it("reads the cross-tenant credential, not just the service token", () => {
    // Distinct credentials on purpose: holding the service token must not imply
    // permission to read every tenant.
    expect(source).toContain("AUDIT_GOV_CROSS_TENANT_TOKEN");
    expect(source).toContain('"x-tenant-scope": "all"');
    expect(source).toContain('"x-cross-tenant-token": token');
  });

  it("scopes the proxy read to a named tenant rather than relying on a default", () => {
    // The proxy resolves the tenant from the verified caller; the script names
    // it explicitly so a multi-tenant operator account is not guessed at.
    expect(source).toContain('extra_headers={"x-tenant-id": tenant_id}');
    expect(source).toContain('event["tenant_id"] = tenant_id');
  });

  it.runIf(hasPython())("exits non-zero without the cross-tenant token, before any network call", () => {
    // Unreachable URLs: if the guard were missing, the run would fail on a
    // connection error instead, and the assertions below would not match.
    const result = spawnSync(
      "python3",
      [SCRIPT, "--audit-url", "http://127.0.0.1:9", "--platform-url", "http://127.0.0.1:9"],
      {
        // A directory with no .env for the script to pick the token up from.
        cwd: tmpdir(),
        env: { ...process.env, AUDIT_GOV_CROSS_TENANT_TOKEN: "" },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(1);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).toContain("AUDIT_GOV_CROSS_TENANT_TOKEN is not set");
    // It must not have got as far as talking to anything.
    expect(output).not.toContain("reached audit-governance service");
    expect(output).not.toContain("Connection refused");
  });
});
