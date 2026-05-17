/**
 * M39.B — ONNX NER detector for names, organizations, and locations.
 *
 * Loads a quantized DistilBERT NER model (Xenova/bert-base-NER) via
 * @xenova/transformers (ONNX runtime), runs locally in mcp-server. Detects
 * tokens the regex baseline can't:
 *   - person (B-PER / I-PER → PiiKind "person")
 *   - org    (B-ORG / I-ORG → PiiKind "org")
 *   - location (B-LOC / I-LOC → PiiKind "location")
 *
 * Behavior:
 *   - Model loaded lazily on first call; cached for the process lifetime
 *   - First call cost: ~1-5s model download (~50MB), ~50ms warm latency
 *   - Caller controls activation via MCP_PII_NER_ENABLED env (default false)
 *   - If loading fails (no internet, disk full, etc.), returns []
 *     gracefully so masking still works on the regex baseline
 *
 * The output shape matches the regex detector's PiiMatch interface so the
 * caller (maskPii) can merge results from both detectors and resolve overlaps
 * uniformly.
 *
 * NOT loaded unless MCP_PII_NER_ENABLED=true. This keeps cold-start fast for
 * deployments that only need the regex baseline.
 */
import type { PiiKind, PiiMatch } from "./pii-detector";

const MODEL_ID = process.env.MCP_PII_NER_MODEL ?? "Xenova/bert-base-NER";
const NER_CONFIDENCE_FLOOR = Number(process.env.MCP_PII_NER_CONFIDENCE_FLOOR ?? 0.7);

// Loaded once on first detect call. transformers.js Pipeline type is opaque
// from external TS; we type as unknown and downcast at call time.
let nerPipeline: unknown | null = null;
let nerLoadAttempted = false;
let nerLoadFailed = false;

/**
 * Map the HuggingFace NER tag to our PiiKind enum. The bert-base-NER label
 * scheme uses BIO encoding (B-X / I-X). We only care about the entity type.
 */
function mapNerLabel(label: string): PiiKind | null {
  if (label.endsWith("PER")) return "person";
  if (label.endsWith("ORG")) return "org";
  if (label.endsWith("LOC")) return "location";
  // MISC and others are skipped — too noisy for redaction
  return null;
}

interface NerEntity {
  entity_group?: string;
  entity?: string;
  word?: string;
  score?: number;
  start?: number;
  end?: number;
}

export function isNerEnabled(): boolean {
  return process.env.MCP_PII_NER_ENABLED === "true";
}

async function loadNerPipeline(): Promise<unknown | null> {
  if (nerPipeline !== null) return nerPipeline;
  if (nerLoadAttempted && nerLoadFailed) return null;
  nerLoadAttempted = true;
  try {
    // Dynamic import so the dependency is optional at boot — services that
    // don't enable NER never pay the load cost. `@xenova/transformers` is
    // ESM; lazy await handles the CJS/ESM interop cleanly.
    const transformers = await import("@xenova/transformers");
    const pipeline = (transformers as unknown as { pipeline: (task: string, model: string, opts?: unknown) => Promise<unknown> }).pipeline;
    // aggregation_strategy="simple" merges B-X + I-X into a single entity span,
    // so we get full names like "John Smith" rather than two tokens.
    nerPipeline = await pipeline("token-classification", MODEL_ID, {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      aggregation_strategy: "simple",
      quantized: true,
    });
    return nerPipeline;
  } catch (err) {
    nerLoadFailed = true;
    // eslint-disable-next-line no-console
    console.warn(`[pii-ner] failed to load NER model ${MODEL_ID}: ${(err as Error).message}; falling back to regex-only`);
    return null;
  }
}

/**
 * Run the NER pipeline on `text`, return matches in the same shape as the
 * regex detector. Returns [] when NER is disabled or model load fails.
 *
 * Caller is expected to merge these matches with regex matches and pass the
 * combined list through the same overlap-resolution as pii-detector does.
 */
export async function detectNerPii(text: string): Promise<PiiMatch[]> {
  if (!isNerEnabled()) return [];
  if (!text || text.length === 0) return [];
  const pipe = await loadNerPipeline();
  if (!pipe) return [];
  try {
    // pipe is callable: (text) => Promise<NerEntity[]>
    const results = await (pipe as (s: string) => Promise<NerEntity[]>)(text);
    const out: PiiMatch[] = [];
    for (const ent of results) {
      const label = ent.entity_group ?? ent.entity ?? "";
      const kind = mapNerLabel(label);
      if (!kind) continue;
      const confidence = Number(ent.score ?? 0);
      if (confidence < NER_CONFIDENCE_FLOOR) continue;
      const value = (ent.word ?? "").trim();
      if (!value) continue;
      // start/end may be undefined for some pipelines/strategies. Fall back to
      // index-of search when missing (best-effort; first match wins).
      let start = typeof ent.start === "number" ? ent.start : -1;
      let end = typeof ent.end === "number" ? ent.end : -1;
      if (start < 0 || end < 0) {
        start = text.indexOf(value);
        if (start < 0) continue;
        end = start + value.length;
      }
      out.push({ kind, value, start, end, confidence });
    }
    return out;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[pii-ner] NER inference failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Combined detector: regex + (optionally) NER. Returns non-overlapping
 * matches in document order.
 *
 * This is the function callers should use when NER may be enabled. When NER
 * is disabled (default), it's equivalent to pii-detector's detectPii.
 */
export async function detectAllPii(text: string): Promise<PiiMatch[]> {
  // Static import — vitest + the prod build both resolve this cleanly.
  // pii-detector has no NER deps so this stays cheap.
  const { detectPii } = await import("./pii-detector");
  const regex = detectPii(text);
  if (!isNerEnabled()) return regex;
  const ner = await detectNerPii(text);
  const combined = [...regex, ...ner];
  // Re-apply overlap resolution across the merged list. Same algorithm as in
  // pii-detector.ts so an SSN matched by regex doesn't get superseded by a
  // NER "person" that overlaps it (regex matches are confidence 1.0; NER is
  // gated by NER_CONFIDENCE_FLOOR so regex would still win on ties).
  return resolveOverlaps(combined);
}

function resolveOverlaps(matches: PiiMatch[]): PiiMatch[] {
  if (matches.length === 0) return matches;
  const sorted = [...matches].sort((a, b) => (a.start - b.start) || (b.end - a.end) || (b.confidence - a.confidence));
  const out: PiiMatch[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start < last.end) continue;
    out.push(m);
  }
  return out;
}
