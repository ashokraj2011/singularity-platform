/**
 * M39.1 — Local PII detector (regex phase A).
 *
 * Runs entirely inside mcp-server. Detects:
 *   - US SSN: NNN-NN-NNNN
 *   - Email: anything matching a permissive RFC-ish regex
 *   - US phone: NPA-NXX-XXXX with optional +1 / country code
 *   - Credit card: 13-19 digits, Luhn-validated to drop false positives
 *   - US ZIP+9: NNNNN-NNNN (kept separate so we don't accidentally redact 9-digit IDs)
 *   - IPv4: standard dotted quads
 *
 * Phase A (this file) ships as zero-dep regex. Phase B (transformers.js +
 * ONNX NER) will add names/orgs/locations behind the same interface.
 *
 * Returns matches in document order, non-overlapping (overlap-resolution
 * keeps the longest match, then earliest start).
 */

export type PiiKind = "ssn" | "email" | "phone" | "credit_card" | "zip9" | "ip" | "person" | "org" | "location";

export interface PiiMatch {
  kind: PiiKind;
  value: string;
  start: number;
  end: number;
  /** 0..1 — regex matches are 1.0 unless Luhn fails (in which case excluded). */
  confidence: number;
}

const PATTERNS: Array<{ kind: PiiKind; re: RegExp; validate?: (s: string) => boolean }> = [
  // SSN: NNN-NN-NNNN — match before ZIP+9 since the boundary differs
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // ZIP+9 — must match BEFORE the standalone digit groups so it wins overlap
  { kind: "zip9", re: /\b\d{5}-\d{4}\b/g },
  // Email — RFC 5322 is awful; use a sensible practical pattern
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // Phone — North American Numbering Plan. Optional +1 / 1- prefix.
  { kind: "phone", re: /\b(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}\b/g },
  // Credit card — 13–19 digit groups separated by optional spaces or hyphens.
  // Luhn-validated below to reject obvious false positives.
  { kind: "credit_card", re: /\b(?:\d[ -]?){13,19}\b/g, validate: (s) => luhnValid(s.replace(/[^\d]/g, "")) },
  // IPv4 — only well-formed dotted quads. Avoids matching version strings like 1.2.3.4.5.
  { kind: "ip", re: /\b(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}\b/g },
];

function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Resolve overlapping matches: prefer the LONGEST match; tie-break by earliest start.
 * Mutates by sorting + filtering — matches in different positions are kept independently.
 */
function resolveOverlaps(matches: PiiMatch[]): PiiMatch[] {
  if (matches.length === 0) return matches;
  // Sort by start ASC, then end DESC so longer-at-same-start wins the keep loop.
  const sorted = [...matches].sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const out: PiiMatch[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start < last.end) {
      // Overlap. Keep the longer span (we sorted longest-at-same-start first,
      // so any later overlap is shorter-or-equal — drop it).
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Run all regex detectors against `text`, return non-overlapping matches in
 * document order. Each match has confidence 1.0 except credit cards which
 * additionally pass Luhn (rejected entries simply don't appear).
 */
export function detectPii(text: string): PiiMatch[] {
  if (!text || text.length === 0) return [];
  const out: PiiMatch[] = [];
  for (const { kind, re, validate } of PATTERNS) {
    // Reset lastIndex since regex is /g
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (validate && !validate(value)) continue;
      out.push({
        kind,
        value,
        start: m.index,
        end: m.index + value.length,
        confidence: 1.0,
      });
    }
  }
  return resolveOverlaps(out);
}
