import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLogObjectKey,
  getLogStorage,
  resetLogStorageForTests,
  sanitizeLogSegment,
} from "../src/log-storage";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  resetLogStorageForTests();
});

describe("log storage helpers", () => {
  it("sanitizes service names for object paths", () => {
    expect(sanitizeLogSegment("Context API / Plan Stage")).toBe("context-api-plan-stage");
    expect(sanitizeLogSegment("../../bad")).toBe("bad");
    expect(sanitizeLogSegment("")).toBe("unknown");
  });

  it("builds deterministic day/service object keys", () => {
    expect(buildLogObjectKey({
      ts: "2026-05-24T10:11:12.000Z",
      service: "mcp-server",
    })).toBe("2026/05/24/mcp-server/logs.ndjson");
  });
});

describe("filesystem log storage", () => {
  it("appends ndjson and returns byte offsets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "singularity-logs-"));
    process.env.LOG_STORAGE_BACKEND = "filesystem";
    process.env.LOG_STORAGE_PATH = root;
    resetLogStorageForTests();

    const storage = getLogStorage();
    const pointers = await storage.writeBatch([
      {
        id: "1",
        ts: "2026-05-24T10:11:12.000Z",
        service: "context-api",
        level: "info",
        message: "one",
      },
      {
        id: "2",
        ts: "2026-05-24T10:11:13.000Z",
        service: "context-api",
        level: "error",
        message: "two",
      },
    ]);

    expect(pointers).toHaveLength(2);
    expect(pointers[0].uri).toContain("context-api/logs.ndjson");
    expect(pointers[0].offset).toBe(0);
    expect(pointers[1].offset).toBeGreaterThan(pointers[0].offset);

    const filePath = pointers[0].uri.replace("file://", "");
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.message)).toEqual(["one", "two"]);
  });

  it("prunes only complete day partitions older than the cutoff", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "singularity-logs-prune-"));
    process.env.LOG_STORAGE_BACKEND = "filesystem";
    process.env.LOG_STORAGE_PATH = root;
    resetLogStorageForTests();

    const storage = getLogStorage();
    await storage.writeBatch([
      { ts: "2025-12-31T23:59:00.000Z", service: "old-service", level: "info", message: "old" },
      { ts: "2026-01-02T00:01:00.000Z", service: "new-service", level: "info", message: "new" },
    ]);

    const result = await storage.pruneBefore(new Date("2026-01-02T00:00:00.000Z"));
    expect(result).toEqual({ managed: true, deletedPartitions: 1 });
    await expect(fs.stat(path.join(root, "2025/12/31"))).rejects.toThrow();
    await expect(fs.stat(path.join(root, "2026/01/02/new-service/logs.ndjson"))).resolves.toBeDefined();
  });
});
