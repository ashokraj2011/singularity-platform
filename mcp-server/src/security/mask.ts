/**
 * M39.1 — PII masking / un-masking helpers.
 *
 * Two pure functions:
 *   - maskPii(text, tokenMap) — replaces detected PII spans in `text` with
 *     stable tokens like "[PERSON_1]", "[EMAIL_2]". The same (kind, value)
 *     gets the same token across the run so the model can reason about
 *     identity (e.g. "[EMAIL_1] sent the same complaint as last time").
 *   - unmaskPiiInArgs(args, tokenMap) — walks an object recursively and
 *     swaps every "[KIND_N]" occurrence in string fields back to the
 *     original value. Used right before a tool dispatch so the downstream
 *     enterprise API receives the real PII it expects.
 *
 * Token map shape: `{ "[KIND_N]": "real value" }`. Carried in LoopState
 * per agent run and persisted across approval pauses in PendingApproval.
 * The map is run-scoped — different runs get independent token-number
 * sequences so [PERSON_1] in trace A never collides with trace B.
 *
 * Token format chosen for stability across LLM rewrites:
 *   - Brackets to discourage the model from concatenating into surrounding text
 *   - All-caps kind + 1-indexed counter
 *   - Round-trip safe (no metacharacters that would need escaping)
 */
import type { PiiKind } from "./pii-detector";
import { detectPii } from "./pii-detector";

export interface MaskResult {
  /** Text with PII spans replaced by tokens. */
  masked: string;
  /** Updated token map (existing entries preserved; new ones appended). */
  tokenMap: Record<string, string>;
  /** Diagnostic — what got masked this call, no values included. */
  applied: Array<{ kind: PiiKind; token: string; count: number }>;
}

function kindToken(kind: PiiKind): string {
  // Map PII kinds to upper-case token prefixes. Kept short + readable.
  if (kind === "ssn")         return "SSN";
  if (kind === "email")       return "EMAIL";
  if (kind === "phone")       return "PHONE";
  if (kind === "credit_card") return "CARD";
  if (kind === "zip9")        return "ZIP";
  if (kind === "ip")          return "IP";
  if (kind === "person")      return "PERSON";
  if (kind === "org")         return "ORG";
  if (kind === "location")    return "LOCATION";
  return "PII";
}

/**
 * Reverse lookup from real value → existing token, scoped to a kind so we
 * never collide tokens across kinds (e.g. a phone and a credit card that
 * happen to have overlapping digits).
 */
function findExistingToken(tokenMap: Record<string, string>, kind: PiiKind, value: string): string | null {
  const prefix = `[${kindToken(kind)}_`;
  for (const [token, v] of Object.entries(tokenMap)) {
    if (token.startsWith(prefix) && v === value) return token;
  }
  return null;
}

/**
 * Allocate the next sequential token for a given kind.
 *   { "[EMAIL_1]": "a@b.com", "[EMAIL_3]": ... }  →  next is [EMAIL_4]
 * We use the max-existing + 1 rather than count() so deletions don't reuse
 * numbers (preserves audit trail).
 */
function nextToken(tokenMap: Record<string, string>, kind: PiiKind): string {
  const prefix = `${kindToken(kind)}_`;
  let max = 0;
  for (const t of Object.keys(tokenMap)) {
    const m = t.match(/^\[([A-Z]+)_(\d+)\]$/);
    if (m && m[1] === kindToken(kind)) {
      const n = Number(m[2]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `[${prefix}${max + 1}]`;
}

/**
 * Replace detected PII spans in `text` with stable tokens. The same value
 * always maps to the same token within `tokenMap` (deterministic per run).
 */
export function maskPii(text: string, tokenMap: Record<string, string> = {}): MaskResult {
  if (!text) return { masked: text, tokenMap, applied: [] };
  const matches = detectPii(text);
  if (matches.length === 0) return { masked: text, tokenMap, applied: [] };

  const newMap: Record<string, string> = { ...tokenMap };
  // Two-pass to keep tokens document-ordered:
  //   Pass 1 (forward): allocate token IDs in the order PII appears, so
  //                     [EMAIL_1] is always the first email in the text.
  //   Pass 2 (reverse): splice replacements right-to-left so earlier
  //                     string indexes stay valid as we mutate.
  const tokens: string[] = [];
  for (const m of matches) {
    let token = findExistingToken(newMap, m.kind, m.value);
    if (!token) {
      token = nextToken(newMap, m.kind);
      newMap[token] = m.value;
    }
    tokens.push(token);
  }
  let out = text;
  const tally = new Map<PiiKind, { token: string; count: number }>();
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const token = tokens[i];
    out = out.slice(0, m.start) + token + out.slice(m.end);
    const entry = tally.get(m.kind);
    if (entry) entry.count += 1;
    else tally.set(m.kind, { token, count: 1 });
  }
  const applied = Array.from(tally.entries()).map(([kind, v]) => ({ kind, token: v.token, count: v.count }));
  return { masked: out, tokenMap: newMap, applied };
}

/**
 * Replace any "[KIND_N]" token in a string with its real value from the map.
 * Tokens not present in the map are left untouched (model might have invented
 * a token that doesn't exist — leaving it as a literal is safer than guessing).
 */
export function unmaskString(text: string, tokenMap: Record<string, string>): string {
  if (!text || Object.keys(tokenMap).length === 0) return text;
  // Use a single combined regex over known tokens. Sorted longest-first so
  // [EMAIL_10] wins over a substring match against [EMAIL_1] when iterating.
  const tokens = Object.keys(tokenMap).sort((a, b) => b.length - a.length);
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (escaped.length === 0) return text;
  const re = new RegExp(escaped, "g");
  return text.replace(re, (m) => tokenMap[m] ?? m);
}

/**
 * Walk an arbitrary JSON-like value and apply unmaskString() to every string
 * descendant. Returns a deep-copied result so the caller can safely log the
 * pre-unmask object too (we never mutate the input).
 */
export function unmaskPiiInArgs<T>(args: T, tokenMap: Record<string, string>): T {
  if (args === null || args === undefined) return args;
  if (typeof args === "string") {
    return unmaskString(args as unknown as string, tokenMap) as unknown as T;
  }
  if (Array.isArray(args)) {
    return args.map((v) => unmaskPiiInArgs(v, tokenMap)) as unknown as T;
  }
  if (typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      out[k] = unmaskPiiInArgs(v, tokenMap);
    }
    return out as unknown as T;
  }
  return args;
}
