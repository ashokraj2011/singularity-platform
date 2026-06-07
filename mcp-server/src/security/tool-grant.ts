/**
 * ToolInvocationGrant verification — the MCP-side half of the governed-cutover
 * hardening (defence-in-depth).
 *
 * /mcp/tool-run is intentionally policy-dumb: it executes whatever the
 * bearer-authenticated caller asks for. The bearer proves "some caller in IAM
 * may talk to MCP" — NOT that this specific (tool, args, stage/phase) was
 * authorized by Context Fabric's governed loop. A leaked / over-scoped bearer
 * could therefore POST /mcp/tool-run directly and dispatch any tool, including
 * mutating ones (apply_patch / write_file) or the arbitrary-command run_command.
 *
 * Context Fabric mints a short-lived, HMAC-signed grant at dispatch time (see
 * context_api_service/app/governed/grant.py) that binds the call to the
 * upstream decision. This module verifies that grant. MCP stays policy-dumb: it
 * does NOT re-derive the policy. It only checks that what it is about to run
 * matches something CF cryptographically signed, that the grant is fresh, and
 * that it hasn't been replayed.
 *
 * Verified, in order:
 *   1. shape + wire version + alg
 *   2. HMAC signature (constant-time) — authenticates ALL bound fields,
 *      including the signed-but-not-independently-checkable stageKey / phase /
 *      policyId / policyVersion / policyHash (these are trusted by signature
 *      and surfaced for audit; MCP has no independent source to re-derive them
 *      against, by design).
 *   3. issuedAt / expiresAt (with clock-skew tolerance)
 *   4. toolName  === the requested tool
 *   5. argsHash  === hash of the requested args (the request-bound checks)
 *   6. traceId   === run_context.traceId (when both present — consistency)
 *   7. nonce not seen before (replay protection)
 *
 * Cross-language contract: canonicalJson + the signing-string layout MUST stay
 * byte-for-byte identical to grant.py. The shared golden vectors are pinned in
 * mcp-server/test/tool-grant.test.ts and context-fabric tests/governed/test_grant.py.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config";
import { categoryForTool } from "../tools/tool-registry-loader";

export const GRANT_VERSION = 1;
export const GRANT_ALG = "HMAC-SHA256";

/** Wire shape of a grant. Unknown extra keys are stripped (non-strict). */
export const GrantSchema = z.object({
  v: z.number(),
  traceId: z.string(),
  stageKey: z.string(),
  phase: z.string(),
  toolName: z.string(),
  argsHash: z.string(),
  policyId: z.string(),
  policyVersion: z.union([z.number(), z.string()]),
  policyHash: z.string(),
  issuedAt: z.number(),
  expiresAt: z.number(),
  nonce: z.string().min(1),
  alg: z.string(),
  sig: z.string().min(1),
});
export type ToolGrant = z.infer<typeof GrantSchema>;

export interface GrantVerifyContext {
  toolName: string;
  /** Raw args as received, BEFORE alias-normalization — see tool-run.ts. */
  args: Record<string, unknown>;
  /** Parsed run_context (for the traceId consistency cross-check). */
  runContext?: Record<string, unknown>;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  nowMs?: number;
}

export type GrantVerifyResult =
  | { ok: true; grant: ToolGrant }
  | { ok: false; code: GrantRejectCode; message: string };

export type GrantRejectCode =
  | "TOOL_GRANT_REQUIRED"
  | "TOOL_GRANT_MALFORMED"
  | "TOOL_GRANT_VERSION_UNSUPPORTED"
  | "TOOL_GRANT_ALG_UNSUPPORTED"
  | "TOOL_GRANT_BAD_SIGNATURE"
  | "TOOL_GRANT_EXPIRED"
  | "TOOL_GRANT_NOT_YET_VALID"
  | "TOOL_GRANT_TOOL_MISMATCH"
  | "TOOL_GRANT_ARGS_MISMATCH"
  | "TOOL_GRANT_TRACE_MISMATCH"
  | "TOOL_GRANT_REPLAY"
  | "TOOL_GRANT_NOT_CONFIGURED";

// ── Canonicalisation (must match grant.py.canonical_json) ────────────────────

/**
 * Deterministic JSON: object keys sorted lexicographically (recursively), no
 * whitespace, raw (non-escaped) UTF-8 — exactly Python's
 * json.dumps(obj, sort_keys=True, separators=(",",":"), ensure_ascii=False).
 *
 * Caveat shared with the Python side: float-valued whole numbers (1.0) would
 * serialise differently across the two languages. Tool args are LLM-produced
 * JSON (strings, ints, bools, nested objects/arrays) where this never arises;
 * documented here so nobody adds a float field to a tool's args expecting the
 * hash to match.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
        .join(",") +
      "}"
    );
  }
  // string | number | boolean
  return JSON.stringify(value);
}

export function hashArgs(args: Record<string, unknown> | null | undefined): string {
  const material = canonicalJson(args ?? {});
  return "sha256:" + createHash("sha256").update(material, "utf8").digest("hex");
}

/** Fixed-order signing string — mirrors grant.py._signing_string exactly. */
export function signingString(g: {
  traceId: string;
  stageKey: string;
  phase: string;
  toolName: string;
  argsHash: string;
  policyId: string;
  policyVersion: number | string;
  policyHash: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}): string {
  return [
    `v${GRANT_VERSION}`,
    g.traceId,
    g.stageKey,
    g.phase,
    g.toolName,
    g.argsHash,
    g.policyId,
    String(g.policyVersion),
    g.policyHash,
    String(g.issuedAt),
    String(g.expiresAt),
    g.nonce,
  ].join("\n");
}

export function signGrant(
  g: Parameters<typeof signingString>[0],
  secret: string,
): string {
  return createHmac("sha256", secret).update(signingString(g), "utf8").digest("hex");
}

function constantTimeHexEqual(a: string, b: string): boolean {
  // Compare the decoded bytes so we don't leak length via early-exit; if the
  // hex lengths differ the signature can't match anyway.
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ── Replay protection: in-process nonce store ────────────────────────────────
//
// A grant is single-use: its 128-bit nonce is recorded when the grant is
// honored, and any later request carrying the same nonce is rejected as a
// replay. Entries self-expire at the grant's expiresAt (a replay of an expired
// grant is already rejected by the expiry check, so we never need to keep a
// nonce past its grant's lifetime). A periodic sweep bounds memory.
//
// Scope note: this Map is per-process. The compose stack runs a single
// mcp-server instance, so that's sufficient here. A multi-replica deployment
// would need a shared store (e.g. Redis SETNX on the nonce with the grant TTL);
// called out so it isn't mistaken for horizontal-scale-safe as written.
const _nonceStore = new Map<string, number>(); // nonce -> expiresAtMs
let _nextSweepAtMs = 0;
const SWEEP_INTERVAL_MS = 60_000;

function sweepNonces(nowMs: number): void {
  if (nowMs < _nextSweepAtMs) return;
  for (const [nonce, expMs] of _nonceStore) {
    if (expMs <= nowMs) _nonceStore.delete(nonce);
  }
  _nextSweepAtMs = nowMs + SWEEP_INTERVAL_MS;
}

/** True if this nonce was already consumed by an honored grant. */
export function nonceSeen(nonce: string): boolean {
  return _nonceStore.has(nonce);
}

/** Record a nonce as consumed until `expiresAtMs`. */
export function recordNonce(nonce: string, expiresAtMs: number, nowMs: number): void {
  sweepNonces(nowMs);
  _nonceStore.set(nonce, expiresAtMs);
}

/** Test seam — wipe the replay store between cases. */
export function __resetNonceStore(): void {
  _nonceStore.clear();
  _nextSweepAtMs = 0;
}

// ── Category gating ──────────────────────────────────────────────────────────

let _requiredCategoriesCache: { raw: string; set: Set<string> } | null = null;

/** Tool-registry categories that require a grant under grace/enforce mode. */
export function requiredGrantCategories(): Set<string> {
  const raw = config.MCP_TOOL_GRANT_REQUIRED_CATEGORIES;
  if (!_requiredCategoriesCache || _requiredCategoriesCache.raw !== raw) {
    const set = new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    _requiredCategoriesCache = { raw, set };
  }
  return _requiredCategoriesCache.set;
}

/**
 * Does this tool require a grant? True iff its registry category is in the
 * configured required set (default: mutate, finalize, run). Read-only
 * categories (read/analyzer/verify_meta) are never gated, so the rollout can't
 * break safe tools. A tool absent from the manifest reports category "unknown"
 * and is NOT gated by default — real mutating tools are all in the manifest.
 */
export function toolRequiresGrant(toolName: string): boolean {
  return requiredGrantCategories().has(categoryForTool(toolName));
}

export type GrantMode = "off" | "grace" | "enforce";
export function grantMode(): GrantMode {
  return config.MCP_TOOL_GRANT_MODE as GrantMode;
}

// ── Top-level verification ───────────────────────────────────────────────────

/**
 * Verify a (possibly-undefined) grant for one tool dispatch.
 *
 * Call this ONLY for tools that require a grant (toolRequiresGrant === true) and
 * when grantMode() !== "off". Behaviour:
 *   • grant undefined  → TOOL_GRANT_REQUIRED  (caller treats as allow+log in
 *                        grace mode; reject in enforce mode)
 *   • grant present    → fully verified; any failure returns ok:false with the
 *                        specific reject code. A present-but-invalid grant is
 *                        rejected in BOTH grace and enforce (the caller decides
 *                        only what to do with a MISSING grant).
 *
 * On success the nonce is recorded (single-use) and { ok:true } is returned.
 */
export function verifyToolGrant(
  rawGrant: unknown,
  ctx: GrantVerifyContext,
): GrantVerifyResult {
  const secret = config.TOOL_GRANT_SIGNING_SECRET;
  if (!secret) {
    // Should be unreachable: config refuses to boot in grace/enforce without a
    // secret. Defensive — never fail open silently.
    return {
      ok: false,
      code: "TOOL_GRANT_NOT_CONFIGURED",
      message: "TOOL_GRANT_SIGNING_SECRET is not configured on mcp-server",
    };
  }

  if (rawGrant === undefined || rawGrant === null) {
    return {
      ok: false,
      code: "TOOL_GRANT_REQUIRED",
      message: `tool '${ctx.toolName}' is mutating/high-risk and requires a signed ToolInvocationGrant`,
    };
  }

  const parsed = GrantSchema.safeParse(rawGrant);
  if (!parsed.success) {
    return {
      ok: false,
      code: "TOOL_GRANT_MALFORMED",
      message: "tool_grant is malformed: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "),
    };
  }
  const grant = parsed.data;

  if (grant.v !== GRANT_VERSION) {
    return {
      ok: false,
      code: "TOOL_GRANT_VERSION_UNSUPPORTED",
      message: `unsupported grant version ${grant.v} (expected ${GRANT_VERSION})`,
    };
  }
  if (grant.alg !== GRANT_ALG) {
    return {
      ok: false,
      code: "TOOL_GRANT_ALG_UNSUPPORTED",
      message: `unsupported grant alg '${grant.alg}' (expected ${GRANT_ALG})`,
    };
  }

  // Signature first — authenticates every other field before we trust any of
  // them (incl. expiresAt and nonce).
  const expectedSig = signGrant(grant, secret);
  if (!constantTimeHexEqual(expectedSig, grant.sig)) {
    return { ok: false, code: "TOOL_GRANT_BAD_SIGNATURE", message: "grant signature mismatch" };
  }

  const nowMs = ctx.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const skew = config.MCP_TOOL_GRANT_CLOCK_SKEW_SEC;
  if (nowSec > grant.expiresAt + skew) {
    return {
      ok: false,
      code: "TOOL_GRANT_EXPIRED",
      message: `grant expired at ${grant.expiresAt} (now ${nowSec}, skew ${skew}s)`,
    };
  }
  if (grant.issuedAt - skew > nowSec) {
    return {
      ok: false,
      code: "TOOL_GRANT_NOT_YET_VALID",
      message: `grant issuedAt ${grant.issuedAt} is in the future (now ${nowSec}, skew ${skew}s)`,
    };
  }

  // Request-bound checks: the grant must be for THIS tool with THESE args.
  if (grant.toolName !== ctx.toolName) {
    return {
      ok: false,
      code: "TOOL_GRANT_TOOL_MISMATCH",
      message: `grant is for tool '${grant.toolName}', request is for '${ctx.toolName}'`,
    };
  }
  const argsHash = hashArgs(ctx.args);
  if (grant.argsHash !== argsHash) {
    return {
      ok: false,
      code: "TOOL_GRANT_ARGS_MISMATCH",
      message: "grant args-hash does not match the request args",
    };
  }

  // traceId consistency — only when both sides carry one. The grant's traceId
  // is signed (authentic); rejecting a mismatch stops a valid grant from being
  // presented against a request claiming a different trace.
  const ctxTrace =
    (ctx.runContext?.traceId as string | undefined) ??
    (ctx.runContext?.trace_id as string | undefined);
  if (grant.traceId && ctxTrace && grant.traceId !== ctxTrace) {
    return {
      ok: false,
      code: "TOOL_GRANT_TRACE_MISMATCH",
      message: `grant traceId '${grant.traceId}' != run_context traceId '${ctxTrace}'`,
    };
  }

  // Replay: reject if this exact grant was already honored. Checked last so a
  // nonce is only ever consumed by an otherwise-valid grant.
  if (nonceSeen(grant.nonce)) {
    return { ok: false, code: "TOOL_GRANT_REPLAY", message: "grant nonce has already been used" };
  }
  recordNonce(grant.nonce, grant.expiresAt * 1000, nowMs);

  return { ok: true, grant };
}
