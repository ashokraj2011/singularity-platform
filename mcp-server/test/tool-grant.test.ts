/**
 * ToolInvocationGrant verification tests.
 *
 * Two layers:
 *   1. Unit tests of src/security/tool-grant.ts — golden cross-language vectors
 *      (must match context-fabric tests/governed/test_grant.py), signature /
 *      expiry / nonce-replay / args-hash / tool / trace checks, and category
 *      gating.
 *   2. HTTP integration through POST /mcp/tool-run in each enforcement mode
 *      (off / grace / enforce), proving the route handler gates mutating tools
 *      and leaves read-only tools untouched.
 *
 * IMPORTANT: grant env is set at module top-level (after the static vitest/node
 * imports, before any dynamic import of src/config). All src modules are loaded
 * via `await import()` so config.ts parses process.env with the grant flags
 * present. Switching modes between describe blocks uses vi.resetModules() +
 * re-import so each block gets its own frozen config + fresh nonce store.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const SECRET = "test-tool-grant-signing-secret-min-32-chars!!";
const BEARER =
  process.env.MCP_BEARER_TOKEN ?? "test-bearer-token-12345-min-16-chars";

// Default grant env for the first config load (the unit-test describe blocks).
process.env.MCP_BEARER_TOKEN = BEARER;
process.env.LLM_GATEWAY_URL = process.env.LLM_GATEWAY_URL ?? "mock";
process.env.MCP_SANDBOX_ROOT = process.env.MCP_SANDBOX_ROOT ?? process.cwd();
process.env.TOOL_GRANT_SIGNING_SECRET = SECRET;
process.env.MCP_TOOL_GRANT_MODE = "enforce";
process.env.MCP_TOOL_GRANT_REQUIRED_CATEGORIES = "mutate,finalize,run";
delete process.env.MCP_TOOL_GRANT_CLOCK_SKEW_SEC;

type GrantModule = typeof import("../src/security/tool-grant");

let G: GrantModule;

const nowSec = () => Math.floor(Date.now() / 1000);
let _nonceCounter = 0;

/** Build a fully-signed grant; override any field via opts. */
function mintGrant(
  G: GrantModule,
  opts: {
    toolName?: string;
    args?: Record<string, unknown>;
    argsHash?: string;
    traceId?: string;
    stageKey?: string;
    phase?: string;
    policyId?: string;
    policyVersion?: number | string;
    policyHash?: string;
    issuedAt?: number;
    expiresAt?: number;
    nonce?: string;
    v?: number;
    alg?: string;
  } = {},
): Record<string, unknown> {
  const issuedAt = opts.issuedAt ?? nowSec();
  const base = {
    v: opts.v ?? 1,
    traceId: opts.traceId ?? "T-1",
    stageKey: opts.stageKey ?? "DEVELOP",
    phase: opts.phase ?? "ACT",
    toolName: opts.toolName ?? "write_file",
    argsHash: opts.argsHash ?? G.hashArgs(opts.args ?? {}),
    policyId: opts.policyId ?? "pol-1",
    policyVersion: opts.policyVersion ?? 3,
    policyHash: opts.policyHash ?? "sha256:abc",
    issuedAt,
    expiresAt: opts.expiresAt ?? issuedAt + 120,
    nonce: opts.nonce ?? `nonce-${_nonceCounter++}`,
  };
  const alg = opts.alg ?? "HMAC-SHA256";
  // Sign over the canonical (alg-independent) field set; alg is carried beside
  // the sig and validated separately.
  const sig = G.signGrant(base, SECRET);
  return { ...base, alg, sig };
}

beforeAll(async () => {
  G = await import("../src/security/tool-grant");
});

// ── Golden cross-language vectors (mirror test_grant.py) ─────────────────────

describe("canonicalisation + signing golden vectors", () => {
  it("canonicalJson sorts keys recursively, compact", () => {
    const args = { b: 1, a: "x", nested: { z: true, y: [3, 2] } };
    expect(G.canonicalJson(args)).toBe('{"a":"x","b":1,"nested":{"y":[3,2],"z":true}}');
  });

  it("hashArgs matches the Python golden hash", () => {
    const args = { b: 1, a: "x", nested: { z: true, y: [3, 2] } };
    expect(G.hashArgs(args)).toBe(
      "sha256:ca51e8f4b74028267d5bb1eb1a5ed36d561dc1a844185ef4fd71e7a9284bb301",
    );
    // {} and null/undefined hash identically.
    expect(G.hashArgs({})).toBe(
      "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
    expect(G.hashArgs(null)).toBe(G.hashArgs({}));
    expect(G.hashArgs(undefined)).toBe(G.hashArgs({}));
  });

  it("signGrant matches the Python golden signature", () => {
    const g = {
      traceId: "trace-1",
      stageKey: "DEVELOP",
      phase: "ACT",
      toolName: "apply_patch",
      argsHash: G.hashArgs({}),
      policyId: "pol-1",
      policyVersion: 3,
      policyHash: "sha256:abc",
      issuedAt: 1000,
      expiresAt: 1120,
      nonce: "n1",
    };
    expect(G.signGrant(g, SECRET)).toBe(
      "cb69093ae79e1a47b110c0311e0800fbe3d1b7bc949c6608075afc42edd65f75",
    );
  });
});

// ── Category gating ──────────────────────────────────────────────────────────

describe("toolRequiresGrant", () => {
  it("requires a grant for mutate / finalize / run categories", () => {
    expect(G.toolRequiresGrant("write_file")).toBe(true); // mutate
    expect(G.toolRequiresGrant("apply_patch")).toBe(true); // mutate
    expect(G.toolRequiresGrant("finish_work_branch")).toBe(true); // finalize
    expect(G.toolRequiresGrant("review_diff")).toBe(true); // finalize
    expect(G.toolRequiresGrant("run_command")).toBe(true); // run
    expect(G.toolRequiresGrant("run_test")).toBe(true); // run
  });

  it("never gates read-only categories", () => {
    expect(G.toolRequiresGrant("read_file")).toBe(false); // read
    expect(G.toolRequiresGrant("repo_map")).toBe(false); // read
    expect(G.toolRequiresGrant("recommended_verification")).toBe(false); // verify_meta
    expect(G.toolRequiresGrant("git_push_preflight")).toBe(false); // analyzer
  });

  it("does not gate tools absent from the manifest (unknown category)", () => {
    expect(G.toolRequiresGrant("some_tool_not_in_manifest")).toBe(false);
  });
});

// ── verifyToolGrant unit checks ──────────────────────────────────────────────

describe("verifyToolGrant", () => {
  beforeEach(() => {
    G.__resetNonceStore();
  });

  const ctx = (over: Partial<Parameters<GrantModule["verifyToolGrant"]>[1]> = {}) => ({
    toolName: "write_file",
    args: { path: "a.py", content: "x" },
    runContext: { traceId: "T-1" },
    nowMs: nowSec() * 1000,
    ...over,
  });

  it("accepts a valid grant", () => {
    const grant = mintGrant(G, { toolName: "write_file", args: { path: "a.py", content: "x" } });
    const r = G.verifyToolGrant(grant, ctx());
    expect(r.ok).toBe(true);
  });

  it("rejects a missing grant as TOOL_GRANT_REQUIRED", () => {
    const r = G.verifyToolGrant(undefined, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_GRANT_REQUIRED");
  });

  it("rejects a malformed grant", () => {
    const r = G.verifyToolGrant({ not: "a grant" }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_GRANT_MALFORMED");
  });

  it("rejects an unsupported version", () => {
    const grant = mintGrant(G, { v: 2, args: { path: "a.py", content: "x" } });
    const r = G.verifyToolGrant(grant, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_GRANT_VERSION_UNSUPPORTED");
  });

  it("rejects a tampered signature", () => {
    const grant = mintGrant(G, { args: { path: "a.py", content: "x" } });
    grant.sig = "deadbeef".repeat(8); // 64 hex chars, wrong value
    const r = G.verifyToolGrant(grant, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_GRANT_BAD_SIGNATURE");
  });

  it("rejects a grant whose body was altered after signing (sig no longer matches)", () => {
    const grant = mintGrant(G, { args: { path: "a.py", content: "x" } });
    grant.policyId = "pol-EVIL"; // changed a signed field, sig stale
    const r = G.verifyToolGrant(grant, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_GRANT_BAD_SIGNATURE");
  });

  it("rejects an expired grant", () => {
    const t = nowSec();
    const grant = mintGrant(G, {
      args: { path: "a.py", content: "x" },
      issuedAt: t - 300,
      expiresAt: t - 200,
    });
    const r = G.verifyToolGrant(grant, ctx({ nowMs: t * 1000 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_GRANT_EXPIRED");
  });

  it("tolerates expiry within the clock-skew window", async () => {
    // skew default 30s; grant expired 10s ago → still accepted.
    const t = nowSec();
    const grant = mintGrant(G, {
      args: { path: "a.py", content: "x" },
      issuedAt: t - 130,
      expiresAt: t - 10,
    });
    const r = G.verifyToolGrant(grant, ctx({ nowMs: t * 1000 }));
    expect(r.ok).toBe(true);
  });

  it("rejects a future-dated grant beyond skew", () => {
    const t = nowSec();
    const grant = mintGrant(G, {
      args: { path: "a.py", content: "x" },
      issuedAt: t + 600,
      expiresAt: t + 720,
    });
    const r = G.verifyToolGrant(grant, ctx({ nowMs: t * 1000 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_GRANT_NOT_YET_VALID");
  });

  it("rejects a tool-name mismatch", () => {
    const grant = mintGrant(G, { toolName: "apply_patch", args: { path: "a.py", content: "x" } });
    const r = G.verifyToolGrant(grant, ctx()); // ctx asks for write_file
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_GRANT_TOOL_MISMATCH");
  });

  it("rejects an args-hash mismatch (args swapped after the grant was minted)", () => {
    const grant = mintGrant(G, { toolName: "write_file", args: { path: "a.py", content: "x" } });
    // Attacker keeps the grant but dispatches different args.
    const r = G.verifyToolGrant(grant, ctx({ args: { path: "/etc/passwd", content: "pwned" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_GRANT_ARGS_MISMATCH");
  });

  it("rejects a traceId mismatch when both sides carry one", () => {
    const grant = mintGrant(G, { traceId: "T-legit", args: { path: "a.py", content: "x" } });
    const r = G.verifyToolGrant(grant, ctx({ runContext: { traceId: "T-other" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_GRANT_TRACE_MISMATCH");
  });

  it("skips the trace check when run_context has no traceId", () => {
    const grant = mintGrant(G, { traceId: "T-legit", args: { path: "a.py", content: "x" } });
    const r = G.verifyToolGrant(grant, ctx({ runContext: {} }));
    expect(r.ok).toBe(true);
  });

  it("rejects a replayed nonce on the second use", () => {
    const grant = mintGrant(G, { nonce: "fixed-nonce", args: { path: "a.py", content: "x" } });
    const first = G.verifyToolGrant(grant, ctx());
    expect(first.ok).toBe(true);
    const second = G.verifyToolGrant(grant, ctx());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("TOOL_GRANT_REPLAY");
  });

  it("does not consume the nonce when an earlier check fails", () => {
    // An args-mismatch should NOT burn the nonce — a later legitimate use of
    // the same grant (correct args) must still succeed.
    const grant = mintGrant(G, {
      nonce: "reusable-after-reject",
      toolName: "write_file",
      args: { path: "a.py", content: "x" },
    });
    const bad = G.verifyToolGrant(grant, ctx({ args: { path: "z.py" } }));
    expect(bad.ok).toBe(false);
    const good = G.verifyToolGrant(grant, ctx());
    expect(good.ok).toBe(true);
  });
});

// ── HTTP integration through POST /mcp/tool-run ──────────────────────────────

interface AppHandle {
  server: http.Server;
  baseUrl: string;
  G: GrantModule;
}

async function startApp(mode: "off" | "grace" | "enforce"): Promise<AppHandle> {
  vi.resetModules();
  process.env.MCP_TOOL_GRANT_MODE = mode;
  process.env.TOOL_GRANT_SIGNING_SECRET = SECRET;
  process.env.MCP_TOOL_GRANT_REQUIRED_CATEGORIES = "mutate,finalize,run";
  process.env.MCP_BEARER_TOKEN = BEARER;
  process.env.LLM_GATEWAY_URL = "mock";
  process.env.MCP_SANDBOX_ROOT = process.cwd();

  const gMod = (await import("../src/security/tool-grant")) as GrantModule;
  const reg = await import("../src/tools/registry");
  // Override the real mutating/read tools with harmless fakes so dispatch
  // doesn't touch disk. categoryForTool still reports their manifest category
  // (mutate / read), which is what the gate keys on.
  reg.registerLocalTool({
    name: "write_file",
    description: "test fake write_file",
    inputSchema: { type: "object" },
    async execute(args: Record<string, unknown>) {
      return { success: true, output: { wrote: args } };
    },
  });
  reg.registerLocalTool({
    name: "read_file",
    description: "test fake read_file",
    inputSchema: { type: "object" },
    async execute(args: Record<string, unknown>) {
      return { success: true, output: { read: args } };
    },
  });

  const { app } = await import("../src/app");
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, G: gMod };
}

function post(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/mcp/tool-run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` },
    body: JSON.stringify(body),
  });
}

describe("POST /mcp/tool-run — enforce mode", () => {
  let h: AppHandle;
  beforeAll(async () => {
    h = await startApp("enforce");
  });
  afterAll(async () => {
    await new Promise<void>((res, rej) => h.server.close((e) => (e ? rej(e) : res())));
  });

  it("executes a mutating tool with a valid grant", async () => {
    const args = { path: "a.py", content: "hello" };
    const grant = mintGrant(h.G, { toolName: "write_file", args, traceId: "T-1" });
    const res = await post(h.baseUrl, {
      tool_name: "write_file",
      args,
      work_item_id: "wi-1",
      run_context: { traceId: "T-1" },
      tool_grant: grant,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.toolSuccess).toBe(true);
    expect(body.data.result).toEqual({ wrote: args });
  });

  it("refuses a mutating tool with NO grant (403 TOOL_GRANT_REQUIRED)", async () => {
    const res = await post(h.baseUrl, {
      tool_name: "write_file",
      args: { path: "a.py", content: "x" },
      work_item_id: "wi-1",
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("TOOL_GRANT_REQUIRED");
  });

  it("refuses when the dispatched args differ from the grant (403 ARGS_MISMATCH)", async () => {
    const grant = mintGrant(h.G, {
      toolName: "write_file",
      args: { path: "a.py", content: "x" },
      traceId: "T-1",
    });
    const res = await post(h.baseUrl, {
      tool_name: "write_file",
      args: { path: "/etc/passwd", content: "pwned" }, // tampered
      run_context: { traceId: "T-1" },
      tool_grant: grant,
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("TOOL_GRANT_ARGS_MISMATCH");
  });

  it("refuses a replayed grant on the second dispatch (403 REPLAY)", async () => {
    const args = { path: "b.py", content: "y" };
    const grant = mintGrant(h.G, { toolName: "write_file", args, traceId: "T-1", nonce: "http-replay" });
    const body = { tool_name: "write_file", args, run_context: { traceId: "T-1" }, tool_grant: grant };
    const first = await post(h.baseUrl, body);
    expect(first.status).toBe(200);
    const second = await post(h.baseUrl, body);
    expect(second.status).toBe(403);
    expect((await second.json()).error.code).toBe("TOOL_GRANT_REPLAY");
  });

  it("does NOT gate a read-only tool (no grant needed)", async () => {
    const res = await post(h.baseUrl, {
      tool_name: "read_file",
      args: { path: "a.py" },
      work_item_id: "wi-1",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.toolSuccess).toBe(true);
  });
});

describe("POST /mcp/tool-run — grace mode", () => {
  let h: AppHandle;
  beforeAll(async () => {
    h = await startApp("grace");
  });
  afterAll(async () => {
    await new Promise<void>((res, rej) => h.server.close((e) => (e ? rej(e) : res())));
  });

  it("allows a mutating tool with NO grant (rollout window)", async () => {
    const res = await post(h.baseUrl, {
      tool_name: "write_file",
      args: { path: "a.py", content: "x" },
      work_item_id: "wi-1",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.toolSuccess).toBe(true);
  });

  it("still rejects a PRESENT-but-invalid grant", async () => {
    const grant = mintGrant(h.G, { toolName: "write_file", args: { path: "a.py", content: "x" } });
    grant.sig = "0".repeat(64); // tampered
    const res = await post(h.baseUrl, {
      tool_name: "write_file",
      args: { path: "a.py", content: "x" },
      tool_grant: grant,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("TOOL_GRANT_BAD_SIGNATURE");
  });
});

describe("POST /mcp/tool-run — off mode (backward compatible)", () => {
  let h: AppHandle;
  beforeAll(async () => {
    h = await startApp("off");
  });
  afterAll(async () => {
    await new Promise<void>((res, rej) => h.server.close((e) => (e ? rej(e) : res())));
  });

  it("dispatches a mutating tool with no grant and ignores grants entirely", async () => {
    const res = await post(h.baseUrl, {
      tool_name: "write_file",
      args: { path: "a.py", content: "x" },
      work_item_id: "wi-1",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.toolSuccess).toBe(true);
  });
});
