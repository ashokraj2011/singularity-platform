/**
 * Canonical-JSON sha256 (M11.c pattern) + statement normalization for the hard
 * dedup guard. Deterministic, key-sorted, whitespace-free — so the same logical
 * value always hashes identically.
 */
import { createHash } from 'crypto';

export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hashPayload(v: unknown): string {
  return sha256Hex(canonicalize(v));
}

/** Normalized statement → canonicalKey. Exact-hash dedup works without embeddings. */
export function statementCanonicalKey(statement: string): string {
  const norm = statement.trim().toLowerCase().replace(/\s+/g, ' ');
  return sha256Hex(norm);
}
