import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Audit Governance ingest env config contract", () => {
  it("bounds event ingest rate and batch knobs", () => {
    const source = read("src/routes-events.ts");

    expect(source).toContain('boundedEnvInteger("AUDIT_GOV_EVENT_RATE_WINDOW_MS"');
    expect(source).toContain("defaultValue: 60_000");
    expect(source).toContain("max: 3_600_000");
    expect(source).toContain('boundedEnvInteger("AUDIT_GOV_EVENT_RATE_MAX"');
    expect(source).toContain("defaultValue: 2_000");
    expect(source).toContain("max: 100_000");
    expect(source).toContain('boundedEnvInteger("AUDIT_GOV_EVENT_BATCH_MAX"');
    expect(source).toContain("defaultValue: 500");
    expect(source).toContain("max: 5_000");
    expect(source).toContain("events.length > EVENT_BATCH_MAX");
    expect(source).not.toContain("Number(process.env.AUDIT_GOV_EVENT_RATE_WINDOW_MS");
    expect(source).not.toContain("Number(process.env.AUDIT_GOV_EVENT_RATE_MAX");
    expect(source).not.toContain("events.length > 500");
  });

  it("bounds operational log ingest batch size", () => {
    const source = read("src/routes-logs.ts");

    expect(source).toContain('boundedEnvInteger("LOG_INGEST_MAX_BATCH"');
    expect(source).toContain("defaultValue: 500");
    expect(source).toContain("max: 5_000");
    expect(source).toContain("logs.length > LOG_INGEST_MAX_BATCH");
    expect(source).not.toContain("Number(process.env.LOG_INGEST_MAX_BATCH");
  });
});
