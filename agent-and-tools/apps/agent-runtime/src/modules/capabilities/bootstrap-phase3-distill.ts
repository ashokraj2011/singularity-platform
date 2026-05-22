/**
 * M61 Wire B P3 — README distillation + architecture slice worker.
 *
 * Runs after Phase 1 (discovery) completes. Two outputs land on the
 * CapabilityWorldModel row:
 *
 *   readmeSummary    — distilled README/CLAUDE/AGENTS overview, capped
 *                      at ~2KB. Non-LLM heuristic: pick the first H1
 *                      title, the first paragraph after it, and any
 *                      "Quick start" / "Installation" / "Getting started"
 *                      / "Usage" section body. That covers the 90% case
 *                      without needing the LLM gateway online.
 *
 *   architectureSlice.rootPackages — grouped from CapabilityCodeSymbol
 *                      rows: group by the top-level directory of each
 *                      filePath, pick up to 6 public-looking symbols
 *                      per group. Mirrors the M43 repo_map output
 *                      shape that mcp-server emits at workflow time,
 *                      cached here so workflow start doesn't have to
 *                      rewalk the index.
 *
 * Why heuristic, not LLM:
 *   - The gateway call would push a hard dependency on a third
 *     service being healthy during bootstrap. Bad ROI at this stage
 *     of the world-model — the heuristic is already a strict upgrade
 *     over the prior state of "the agent rediscovers the README
 *     every workflow".
 *   - Future: replace the heuristic with a llm-gateway call (alias
 *     ${WORLD_MODEL_DISTILL_MODEL_ALIAS}) once we have a budget for
 *     it. Worker shape stays the same — only this file changes.
 */
import { prisma } from "../../config/prisma";
import { upsertWorldModel, type ArchitectureSlice } from "./world-model.service";
import { PHASE_KEYS, markPhaseStarted, markPhaseCompleted, markPhaseFailed, markPhaseSkipped } from "./bootstrap-phases";

const README_SUMMARY_CAP = 2_048;
const SECTION_BODY_CAP = 600;
const MAX_ROOT_PACKAGES = 12;
const MAX_SYMBOLS_PER_PACKAGE = 6;

const SECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /^#{1,3}\s*(Quick\s*start|Quickstart)\b/im,
  /^#{1,3}\s*(Installation|Install)\b/im,
  /^#{1,3}\s*(Getting\s*started)\b/im,
  /^#{1,3}\s*(Usage)\b/im,
];

/**
 * Pull the body of the section starting at the matched heading,
 * stopping at the next heading or `cap` chars in.
 */
function extractSectionBody(markdown: string, match: RegExpMatchArray, cap: number): string {
  const start = match.index ?? 0;
  // Skip past the heading line.
  const afterHeading = markdown.indexOf("\n", start);
  if (afterHeading < 0) return "";
  // Find the next heading line (same or higher level).
  const remainder = markdown.slice(afterHeading + 1);
  const nextHeading = remainder.search(/^#{1,6}\s/m);
  const body = nextHeading < 0 ? remainder : remainder.slice(0, nextHeading);
  const trimmed = body.trim();
  return trimmed.length > cap ? `${trimmed.slice(0, cap).trimEnd()}…` : trimmed;
}

/**
 * Pull the first paragraph after the first H1. Used as the README's
 * "tagline" — what the project is, in one chunk.
 */
function extractIntroParagraph(markdown: string): { title: string; intro: string } {
  const h1 = markdown.match(/^#\s+(.+)$/m);
  const title = h1?.[1]?.trim() ?? "";
  if (!h1 || h1.index === undefined) {
    // No H1 → take the first non-heading paragraph.
    const para = markdown.match(/^(?!#)\s*([^\n#].+?)(?:\n\n|\n#|$)/s);
    return { title, intro: (para?.[1] ?? "").trim() };
  }
  const after = markdown.slice(h1.index + h1[0].length).trimStart();
  // First paragraph = lines until a blank line, ignoring leading
  // badge clusters (a paragraph that's all `[![…]…]` markdown badges
  // doesn't tell the agent anything useful).
  const blocks = after.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // Skip pure-badge paragraphs (every non-whitespace line starts
    // with `[![` or is just shields.io links).
    const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every((l) => l.startsWith("[![") || /shields\.io|badge/.test(l))) {
      continue;
    }
    return { title, intro: trimmed.length > SECTION_BODY_CAP ? `${trimmed.slice(0, SECTION_BODY_CAP).trimEnd()}…` : trimmed };
  }
  return { title, intro: "" };
}

/**
 * Distill a markdown blob into the world-model readmeSummary slot.
 * Returns null when the input has nothing useful (saves a write).
 */
export function distillReadme(markdown: string): string | null {
  if (!markdown || typeof markdown !== "string") return null;
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return null;

  const { title, intro } = extractIntroParagraph(trimmed);
  const sections: Array<{ heading: string; body: string }> = [];
  for (const pat of SECTION_PATTERNS) {
    const m = trimmed.match(pat);
    if (!m) continue;
    const body = extractSectionBody(trimmed, m, SECTION_BODY_CAP);
    if (body) sections.push({ heading: m[0].replace(/^#+\s*/, "").trim(), body });
    if (sections.length >= 3) break; // cap section count
  }

  const parts: string[] = [];
  if (title) parts.push(`# ${title}`);
  if (intro) parts.push(intro);
  for (const sec of sections) parts.push(`## ${sec.heading}\n\n${sec.body}`);

  if (parts.length === 0) return null;
  const joined = parts.join("\n\n");
  return joined.length > README_SUMMARY_CAP
    ? `${joined.slice(0, README_SUMMARY_CAP).trimEnd()}…`
    : joined;
}

/**
 * Group the capability's indexed code symbols by top-level directory
 * (first path segment of filePath) and pick up to MAX_SYMBOLS_PER_PACKAGE
 * symbols per group. Public-looking heuristic: symbolName starts with
 * an uppercase letter (class / type) OR symbolType matches a "public
 * surface" kind (class, interface, function, struct, enum).
 *
 * Returns null when no symbols are indexed (the WorldModel field
 * stays empty {}).
 */
export async function buildArchitectureSliceFromSymbols(capabilityId: string): Promise<ArchitectureSlice | null> {
  const rows = await prisma.capabilityCodeSymbol.findMany({
    where: { capabilityId },
    select: { filePath: true, language: true, symbolName: true, symbolType: true },
    take: 5_000,
  });
  if (rows.length === 0) return null;

  // path → { language, symbols }
  const groups = new Map<string, { language?: string; symbols: Map<string, string> }>();
  for (const row of rows) {
    if (!row.filePath) continue;
    const top = row.filePath.split(/[\\/]/).filter(Boolean)[0];
    if (!top) continue;
    let g = groups.get(top);
    if (!g) {
      g = { language: row.language ?? undefined, symbols: new Map() };
      groups.set(top, g);
    } else if (!g.language && row.language) {
      g.language = row.language;
    }
    const name = (row.symbolName ?? "").trim();
    if (!name) continue;
    // "Public-looking" filter — keeps the prompt budget tight.
    const isPublic =
      /^[A-Z]/.test(name) ||
      (row.symbolType && ["class", "interface", "function", "struct", "enum", "type"].includes(row.symbolType.toLowerCase()));
    if (!isPublic) continue;
    // Dedup by name within group; first wins (smallest filePath since
    // findMany is unordered, but consistent across calls is fine).
    if (!g.symbols.has(name)) g.symbols.set(name, row.symbolType ?? "");
  }

  const rootPackages: NonNullable<ArchitectureSlice["rootPackages"]> = [];
  // Sort groups by symbol count desc so the biggest packages render first.
  const sorted = Array.from(groups.entries()).sort((a, b) => b[1].symbols.size - a[1].symbols.size);
  for (const [path, info] of sorted) {
    if (rootPackages.length >= MAX_ROOT_PACKAGES) break;
    if (info.symbols.size === 0) continue;
    rootPackages.push({
      path,
      language: info.language,
      publicSymbols: Array.from(info.symbols.keys()).slice(0, MAX_SYMBOLS_PER_PACKAGE),
    });
  }
  if (rootPackages.length === 0) return null;
  return { rootPackages };
}

/**
 * The actual Phase 3 entry point. Called from
 * runBootstrapDiscoveryPhase / the sync bootstrap path AFTER Phase 1
 * finishes. Wraps the two outputs in the phase-marker contract so
 * skipped + failed + completed all show up in phaseProgress.
 */
export async function runBootstrapDistillationPhase(input: {
  capabilityId: string;
  runId: string;
}): Promise<void> {
  const { capabilityId, runId } = input;
  await markPhaseStarted(runId, PHASE_KEYS.P3);

  try {
    // Find the most-confident README-like learning candidate. Bootstrap
    // groups discovered files by groupKey; READMEs land under
    // "capability_overview" (see buildLearningCandidates).
    const candidate = await prisma.capabilityLearningCandidate.findFirst({
      where: { capabilityId, groupKey: "capability_overview" },
      orderBy: [{ confidence: "desc" }, { createdAt: "asc" }],
      select: { content: true },
    });
    const readmeSummary = candidate?.content ? distillReadme(candidate.content) : null;
    const architectureSlice = await buildArchitectureSliceFromSymbols(capabilityId);

    if (!readmeSummary && !architectureSlice) {
      await markPhaseSkipped(runId, PHASE_KEYS.P3, "no README candidate or indexed symbols available");
      return;
    }

    await upsertWorldModel({
      capabilityId,
      ...(readmeSummary !== null ? { readmeSummary } : {}),
      ...(architectureSlice ? { architectureSlice } : {}),
    });

    await markPhaseCompleted(runId, PHASE_KEYS.P3, {
      readmeSummary: readmeSummary ? readmeSummary.length : 0,
      rootPackages: architectureSlice?.rootPackages?.length ?? 0,
    });
  } catch (err) {
    await markPhaseFailed(runId, PHASE_KEYS.P3, err as Error);
  }
}
