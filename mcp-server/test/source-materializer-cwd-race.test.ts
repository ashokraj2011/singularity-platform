/**
 * Regression: git-init "unable to get current working directory" (cwd race).
 *
 * PR #58 fixed ONE git-init failure (`--template=` skips the hook-copy step
 * that crashed with ".git/hooks/*.sample File exists" on the macOS bind-mount).
 * A DIFFERENT failure of the same command surfaced later: when materialization
 * clears the shared sandbox root and re-inits, git's getcwd() can abort with
 *   fatal: unable to get current working directory: No such file or directory
 * if the root is yanked out from under it (concurrent materialization into the
 * same root, or a stale-inode hiccup).
 *
 * Fix under test:
 *   1. initRepoAtRoot() runs `git init` against an EXPLICIT target dir from the
 *      stable parent cwd (never from the volatile root itself), and
 *   2. ensureWorkspaceSource() serializes per sandbox root via an in-process
 *      mutex so two flows can't clear/re-init the same root concurrently.
 *
 * Hermetic: a tmp local-dir source (no .git) routes through
 * copyLocalDirectoryIntoWorkspace -> initRepoAtRoot. No network, no clone.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

let ensureWorkspaceSource: typeof import("../src/workspace/source-materializer").ensureWorkspaceSource;
let baseSandboxRoot: typeof import("../src/workspace/sandbox").baseSandboxRoot;

const SANDBOX = path.join(os.tmpdir(), "materializer-cwd-race-sandbox");
const SOURCE = path.join(os.tmpdir(), "materializer-cwd-race-source");
const req = { sourceType: "local", sourceUri: SOURCE };

beforeAll(async () => {
  process.env.MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "test-bearer-token-12345-min-16-chars";
  process.env.LLM_GATEWAY_URL = process.env.LLM_GATEWAY_URL ?? "mock";
  process.env.MCP_SANDBOX_ROOT = SANDBOX;
  process.env.MCP_AUTO_CHECKOUT_SOURCE = "true";

  // Fresh local source dir WITHOUT .git -> copyLocalDirectoryIntoWorkspace path.
  await fs.promises.rm(SOURCE, { recursive: true, force: true });
  await fs.promises.mkdir(SOURCE, { recursive: true });
  await fs.promises.writeFile(path.join(SOURCE, "hello.txt"), "hi\n");
  await fs.promises.rm(SANDBOX, { recursive: true, force: true });

  // Import AFTER env is set so config picks up the test sandbox root.
  ensureWorkspaceSource = (await import("../src/workspace/source-materializer")).ensureWorkspaceSource;
  baseSandboxRoot = (await import("../src/workspace/sandbox")).baseSandboxRoot;
});

afterAll(async () => {
  await fs.promises.rm(SOURCE, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
});

describe("source-materializer git init (cwd-race fix)", () => {
  it("materializes a local dir and inits git without a getcwd error", async () => {
    const status = await ensureWorkspaceSource(req);
    expect(status?.checkedOut).toBe(true);
    const root = baseSandboxRoot();
    expect(fs.existsSync(path.join(root, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(root, "hello.txt"))).toBe(true);
  });

  it("is idempotent on re-materialization (re-init over an existing root)", async () => {
    const status = await ensureWorkspaceSource(req);
    expect(status?.checkedOut).toBe(true);
    expect(fs.existsSync(path.join(baseSandboxRoot(), ".git"))).toBe(true);
  });

  it("serializes concurrent materializations of the same root (no getcwd race)", async () => {
    // Pre-fix, three concurrent clear+init cycles on the same root could yank
    // git's cwd mid-init. The per-root mutex serializes them; all must succeed.
    const results = await Promise.all([
      ensureWorkspaceSource(req),
      ensureWorkspaceSource(req),
      ensureWorkspaceSource(req),
    ]);
    for (const r of results) expect(r?.checkedOut).toBe(true);
    expect(fs.existsSync(path.join(baseSandboxRoot(), ".git"))).toBe(true);
    expect(fs.existsSync(path.join(baseSandboxRoot(), "hello.txt"))).toBe(true);
  });
});
