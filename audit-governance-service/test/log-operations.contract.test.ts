import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const operations = readFileSync(resolve(root, "src/log-operations.ts"), "utf8");
const routes = readFileSync(resolve(root, "src/routes-logs.ts"), "utf8");
const index = readFileSync(resolve(root, "src/index.ts"), "utf8");
const redaction = readFileSync(resolve(root, "src/log-redaction.ts"), "utf8");

describe("log operations hardening contract", () => {
  it("starts workers only after the observability schema exists and stops them on shutdown", () => {
    expect(index).toMatch(/ensureObservabilityLogTables\(\)[\s\S]*?\.then\(\(\) => startLogOperations\(\)\)/);
    expect(index).toMatch(/SIGTERM[\s\S]*?stopLogOperations\(\)/);
  });

  it("keeps export credentials in named environment variables", () => {
    expect(operations).toMatch(/credentialEnv: EnvNameSchema/);
    expect(operations).toMatch(/process\.env\[target\.credentialEnv\]/);
    expect(operations).not.toMatch(/apiKey\s*:/);
  });

  it("redacts nested producer payloads again at the ingest boundary", () => {
    expect(redaction).toMatch(/function redactLogValue/);
    expect(redaction).toMatch(/isSecretField\(key\) \? "\[REDACTED\]"/);
    expect(routes).toMatch(/redactLogText\(firstString\(parsed\.message/);
  });

  it("exposes retention, alert, durable export queue, and retry operations", () => {
    expect(routes).toMatch(/\/logs\/retention\/sweep/);
    expect(routes).toMatch(/\/logs\/alert-rules/);
    expect(routes).toMatch(/\/logs\/alerts\/evaluate/);
    expect(routes).toMatch(/get\("\/logs\/exports"/);
    expect(routes).toMatch(/\/logs\/exports\/:id\/retry/);
  });
});
