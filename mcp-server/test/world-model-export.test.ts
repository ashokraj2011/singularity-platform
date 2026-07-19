/**
 * Layered world model — the `.agent/world-model/` workspace export.
 *
 * Real filesystem, real temp workspace, stubbed HTTP. The properties that matter
 * are all failure-shaped:
 *   - it never throws, because it runs inside grounding and must not fail a
 *     ground that produced a perfectly good workspace
 *   - it excludes itself via .git/info/exclude, NEVER .gitignore, which is the
 *     repository's own tracked file
 *   - it replaces rather than merges, so a deleted view cannot linger as a stale
 *     file that still reads as current
 *   - only READY views are written; PENDING/FAILED rows have no usable prose
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { exportWorldModelToWorkspace, excludeAgentDirFromGit } from "../src/workspace/world-model-export";

let workspace: string;
const realFetch = globalThis.fetch;

function makeWorkspace(withGit = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-export-"));
  if (withGit) fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function view(over: Record<string, unknown> = {}) {
  return {
    kind: "development",
    domainKey: "",
    title: "Development View",
    contentMd: "Start in src/index.ts.",
    status: "READY",
    ...over,
  };
}

/** Stub the two GETs the exporter makes, by URL suffix. */
function stubRuntime(opts: { worldModel?: unknown; views?: unknown[]; repoFingerprint?: string | null; fail?: boolean }) {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    if (opts.fail) throw new Error("connection refused");
    const u = String(url);
    const payload = u.includes("/world-model/views")
      ? { data: { views: opts.views ?? [], repoFingerprint: opts.repoFingerprint ?? "fp-1" } }
      : { data: opts.worldModel ?? null };
    if (!u.includes("/world-model/views") && !opts.worldModel) {
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
}

const run = (extra: Record<string, string> = {}) =>
  exportWorldModelToWorkspace({
    agentRuntimeUrl: "http://runtime",
    capabilityId: "cap-1",
    workspaceRoot: workspace,
    ...extra,
  });

const read = (rel: string) => fs.readFileSync(path.join(workspace, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(workspace, rel));

beforeEach(() => {
  workspace = makeWorkspace();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("world-model export", () => {
  it("writes core, views and a manifest", async () => {
    stubRuntime({
      worldModel: { capabilityId: "cap-1", primaryLanguage: "ts" },
      views: [
        view({ kind: "core_summary", title: "Capability Core", contentMd: "core text" }),
        view(),
        view({ kind: "testing", title: "Testing View", contentMd: "test text" }),
      ],
    });

    const result = await run();

    expect(result.exported).toBe(true);
    expect(result.views).toBe(3);
    expect(exists(".agent/world-model/core/model.json")).toBe(true);
    expect(exists(".agent/world-model/core/summary.md")).toBe(true);
    expect(exists(".agent/world-model/views/development.md")).toBe(true);
    expect(exists(".agent/world-model/views/testing.md")).toBe(true);

    const manifest = JSON.parse(read(".agent/world-model/manifest.json"));
    expect(manifest.capabilityId).toBe("cap-1");
    expect(manifest.hasWorldModel).toBe(true);
    expect(manifest.repoFingerprint).toBe("fp-1");
    expect(manifest.views.map((v: { kind: string }) => v.kind)).toEqual(["core_summary", "development", "testing"]);
    // Manifest paths must actually resolve, or the manifest is a lie.
    for (const v of manifest.views) expect(exists(v.path)).toBe(true);
  });

  it("renders provenance and the content in each view file", async () => {
    stubRuntime({ views: [view({ sourceCommit: "abc123", generatedAt: "2026-07-19T00:00:00.000Z" })] });
    await run();
    const md = read(".agent/world-model/views/development.md");
    expect(md).toMatch(/^---\nkind: development\n/);
    expect(md).toMatch(/sourceCommit: abc123/);
    expect(md).toMatch(/# Development View/);
    expect(md).toMatch(/Start in src\/index\.ts\./);
  });

  it("marks a stale view in the file itself, rather than omitting it", async () => {
    stubRuntime({ views: [view({ stale: true })] });
    await run();
    const md = read(".agent/world-model/views/development.md");
    expect(md).toMatch(/stale: true/);
    expect(md).toMatch(/may be out of date/);
    expect(md).toMatch(/Start in src\/index\.ts\./);
  });

  it("slugifies free-text domain and task keys into safe filenames", async () => {
    stubRuntime({
      views: [
        view({ kind: "domain", domainKey: "Billing & Invoices", title: "Billing" }),
        view({ kind: "task_guide", domainKey: "add a migration!", title: "Add a migration" }),
      ],
    });
    await run();
    expect(exists(".agent/world-model/domains/billing-invoices.md")).toBe(true);
    expect(exists(".agent/world-model/task-guides/add-a-migration.md")).toBe(true);
  });

  it("writes one evidence ledger stamped with each entry's origin view", async () => {
    stubRuntime({
      views: [
        view({ evidence: [{ claim: "uses express", status: "observed" }] }),
        view({ kind: "domain", domainKey: "billing", evidence: [{ claim: "invoices are immutable", status: "inferred" }] }),
      ],
    });
    await run();
    const lines = read(".agent/world-model/evidence/evidence.jsonl").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ viewKind: "development", domainKey: "", claim: "uses express" });
    expect(lines[1]).toMatchObject({ viewKind: "domain", domainKey: "billing", claim: "invoices are immutable" });
  });

  it("skips views that are not READY or have no prose", async () => {
    stubRuntime({
      views: [
        view(),
        view({ kind: "testing", status: "PENDING", contentMd: "" }),
        view({ kind: "release", status: "FAILED", contentMd: "" }),
        view({ kind: "security", status: "READY", contentMd: "   " }),
      ],
    });
    const result = await run();
    expect(result.views).toBe(1);
    expect(exists(".agent/world-model/views/testing.md")).toBe(false);
    expect(exists(".agent/world-model/views/release.md")).toBe(false);
    expect(exists(".agent/world-model/views/security.md")).toBe(false);
  });

  it("replaces the previous export instead of merging into it", async () => {
    stubRuntime({ views: [view(), view({ kind: "testing", title: "Testing View" })] });
    await run();
    expect(exists(".agent/world-model/views/testing.md")).toBe(true);

    // The testing view is deleted upstream; a merge would leave the old file
    // sitting there reading as current.
    stubRuntime({ views: [view()] });
    await run();
    expect(exists(".agent/world-model/views/development.md")).toBe(true);
    expect(exists(".agent/world-model/views/testing.md")).toBe(false);
  });

  it("is idempotent across repeated runs", async () => {
    stubRuntime({ worldModel: { capabilityId: "cap-1" }, views: [view()] });
    const first = await run();
    const firstMd = read(".agent/world-model/views/development.md");
    const second = await run();
    expect(second.files).toBe(first.files);
    expect(read(".agent/world-model/views/development.md")).toBe(firstMd);
    const exclude = read(".git/info/exclude");
    expect(exclude.match(/\.agent\//g)).toHaveLength(1);
  });

  describe("git exclusion", () => {
    it("uses .git/info/exclude and never touches .gitignore", async () => {
      fs.writeFileSync(path.join(workspace, ".gitignore"), "node_modules\n");
      stubRuntime({ views: [view()] });
      await run();

      expect(read(".git/info/exclude")).toMatch(/^\.agent\/$/m);
      // .gitignore is the repository's own tracked file — writing to it would put
      // a spurious diff in front of every agent and could get committed.
      expect(read(".gitignore")).toBe("node_modules\n");
    });

    it("appends without clobbering existing exclude rules", () => {
      const excludePath = path.join(workspace, ".git", "info", "exclude");
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
      fs.writeFileSync(excludePath, "*.log");
      expect(excludeAgentDirFromGit(workspace)).toBe(true);
      const content = fs.readFileSync(excludePath, "utf8");
      expect(content).toMatch(/^\*\.log$/m);
      expect(content).toMatch(/^\.agent\/$/m);
    });

    it("does not double-add when the rule is already present", () => {
      const excludePath = path.join(workspace, ".git", "info", "exclude");
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
      fs.writeFileSync(excludePath, ".agent/\n");
      excludeAgentDirFromGit(workspace);
      expect(fs.readFileSync(excludePath, "utf8")).toBe(".agent/\n");
    });

    it("reports false for a workspace with no git directory, without throwing", () => {
      const bare = makeWorkspace(false);
      try {
        expect(excludeAgentDirFromGit(bare)).toBe(false);
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });
  });

  describe("degradation", () => {
    it("exports views even when the capability has no world model", async () => {
      // A parent capability: views built from description, artifacts, children.
      stubRuntime({ views: [view({ kind: "business", title: "Business View" })] });
      const result = await run();
      expect(result.exported).toBe(true);
      expect(exists(".agent/world-model/views/business.md")).toBe(true);
      expect(exists(".agent/world-model/core/model.json")).toBe(false);
      expect(JSON.parse(read(".agent/world-model/manifest.json")).hasWorldModel).toBe(false);
    });

    it("reports a reason instead of writing when there is nothing to export", async () => {
      stubRuntime({ views: [] });
      const result = await run();
      expect(result.exported).toBe(false);
      expect(result.reason).toMatch(/no world model or views/);
      expect(exists(".agent")).toBe(false);
    });

    it("never throws when agent-runtime is unreachable", async () => {
      stubRuntime({ fail: true });
      await expect(run()).resolves.toMatchObject({ exported: false });
    });

    it("never throws on a missing workspace root", async () => {
      stubRuntime({ views: [view()] });
      const result = await exportWorldModelToWorkspace({
        agentRuntimeUrl: "http://runtime",
        capabilityId: "cap-1",
        workspaceRoot: path.join(workspace, "does-not-exist"),
      });
      expect(result.exported).toBe(false);
      expect(result.reason).toMatch(/does not exist/);
    });

    it("no-ops without an agent-runtime url or capability id", async () => {
      stubRuntime({ views: [view()] });
      for (const args of [
        { agentRuntimeUrl: "", capabilityId: "cap-1", workspaceRoot: workspace },
        { agentRuntimeUrl: "http://runtime", capabilityId: "", workspaceRoot: workspace },
      ]) {
        const result = await exportWorldModelToWorkspace(args);
        expect(result.exported).toBe(false);
      }
      expect(exists(".agent")).toBe(false);
    });
  });
});
