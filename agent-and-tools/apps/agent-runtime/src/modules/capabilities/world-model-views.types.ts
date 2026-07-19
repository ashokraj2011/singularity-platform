/**
 * Layered capability world model — view-document types.
 *
 * The single CapabilityWorldModel row stays the machine-readable core (commands,
 * architecture slice, agent rules). THESE are the prose layers an agent actually
 * reads, stored broadly and loaded narrowly: a small shared core, one view per
 * role, plus on-demand domain models and task guides. An agent receives core +
 * its role view + the relevant domain/task guide — never the whole set.
 *
 * Every claim in a view carries provenance (observed vs inferred, a confidence,
 * and either repo locations or knowledge-artifact refs) so a verifying agent can
 * check the grounding instead of trusting prose. Vocabulary is borrowed from the
 * claim-registry evidence model deliberately; there is NO service coupling — this
 * is local JSON.
 */

export const WORLD_MODEL_VIEW_KINDS = [
  "core_summary",
  "business",
  "architecture",
  "development",
  "testing",
  "release",
  "operations",
  "security",
  "domain",
  "task_guide",
] as const;

export type WorldModelViewKind = (typeof WORLD_MODEL_VIEW_KINDS)[number];

/** The seven role views (everything except the core and the on-demand kinds). */
export const ROLE_VIEW_KINDS = [
  "business",
  "architecture",
  "development",
  "testing",
  "release",
  "operations",
  "security",
] as const satisfies ReadonlyArray<WorldModelViewKind>;

/** Kinds that are scoped by a domainKey (a domain slug or a task slug). */
export const KEYED_VIEW_KINDS = ["domain", "task_guide"] as const satisfies ReadonlyArray<WorldModelViewKind>;

export function isWorldModelViewKind(value: unknown): value is WorldModelViewKind {
  return typeof value === "string" && (WORLD_MODEL_VIEW_KINDS as readonly string[]).includes(value);
}

export function requiresDomainKey(kind: WorldModelViewKind): boolean {
  return (KEYED_VIEW_KINDS as readonly string[]).includes(kind);
}

export type EvidenceStatus = "observed" | "inferred";
export type EvidenceConfidence = "high" | "medium" | "low";

export type EvidenceLocation = {
  path: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
};

export type EvidenceArtifactRef = {
  artifactId: string;
  title?: string;
};

/**
 * One provenance-bearing claim. `observed` means it was read out of the grounding
 * (a repo location or an artifact); `inferred` means the model concluded it. An
 * entry claiming `observed` with no location and no artifact is downgraded by the
 * parser — we never let a view invent its own provenance.
 */
export type EvidenceEntry = {
  claim: string;
  status: EvidenceStatus;
  confidence: EvidenceConfidence;
  locations: EvidenceLocation[];
  artifacts: EvidenceArtifactRef[];
  commit: string | null;
};

export type WorldModelViewStatus = "PENDING" | "BUILDING" | "READY" | "FAILED";

export type WorldModelViewDoc = {
  capabilityId: string;
  kind: WorldModelViewKind;
  /** "" for the non-keyed kinds — never null, so the composite unique works. */
  domainKey: string;
  title: string;
  contentMd: string;
  structured: Record<string, unknown> | null;
  evidence: EvidenceEntry[];
  sourceCommit: string | null;
  /** WorldModel.repoFingerprint at build time; staleness = differs from current. */
  repoFingerprint: string | null;
  tokenEstimate: number;
  contentHash: string | null;
  status: WorldModelViewStatus;
  buildError: string | null;
  generatedBy: string | null;
  generatedAt: Date;
  updatedAt: Date;
};

function asString(value: unknown, cap: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > cap ? trimmed.slice(0, cap) : trimmed;
}

function projectLocations(value: unknown): EvidenceLocation[] {
  if (!Array.isArray(value)) return [];
  const out: EvidenceLocation[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const path = asString(rec.path, 400);
    if (!path) continue;
    const loc: EvidenceLocation = { path };
    if (typeof rec.startLine === "number" && Number.isFinite(rec.startLine)) loc.startLine = Math.max(1, Math.floor(rec.startLine));
    if (typeof rec.endLine === "number" && Number.isFinite(rec.endLine)) loc.endLine = Math.max(1, Math.floor(rec.endLine));
    const symbol = asString(rec.symbol, 200);
    if (symbol) loc.symbol = symbol;
    out.push(loc);
  }
  return out;
}

function projectArtifacts(value: unknown): EvidenceArtifactRef[] {
  if (!Array.isArray(value)) return [];
  const out: EvidenceArtifactRef[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const artifactId = asString(rec.artifactId, 200);
    if (!artifactId) continue;
    const ref: EvidenceArtifactRef = { artifactId };
    const title = asString(rec.title, 300);
    if (title) ref.title = title;
    out.push(ref);
  }
  return out;
}

/** Coerce a stored evidence JSON array into typed entries (defensive; drops junk). */
export function projectEvidence(value: unknown): EvidenceEntry[] {
  if (!Array.isArray(value)) return [];
  const out: EvidenceEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const claim = asString(rec.claim, 1000);
    if (!claim) continue;
    const status: EvidenceStatus = rec.status === "observed" ? "observed" : "inferred";
    const confidence: EvidenceConfidence =
      rec.confidence === "high" ? "high" : rec.confidence === "medium" ? "medium" : "low";
    out.push({
      claim,
      status,
      confidence,
      locations: projectLocations(rec.locations),
      artifacts: projectArtifacts(rec.artifacts),
      commit: asString(rec.commit, 80),
    });
  }
  return out;
}

/**
 * JSONB → typed projection for a stored view row. Mirrors projectWorldModel's
 * defensive stance: never trust the column shape, coerce and drop rather than throw.
 */
export function projectViewDoc(row: {
  capabilityId: string;
  kind: string;
  domainKey: string;
  title: string;
  contentMd: string;
  structured: unknown;
  evidence: unknown;
  sourceCommit: string | null;
  repoFingerprint: string | null;
  tokenEstimate: number;
  contentHash: string | null;
  status: string;
  buildError: string | null;
  generatedBy: string | null;
  generatedAt: Date;
  updatedAt: Date;
}): WorldModelViewDoc {
  const status: WorldModelViewStatus =
    row.status === "READY" || row.status === "BUILDING" || row.status === "FAILED" ? row.status : "PENDING";
  return {
    capabilityId: row.capabilityId,
    kind: isWorldModelViewKind(row.kind) ? row.kind : "core_summary",
    domainKey: typeof row.domainKey === "string" ? row.domainKey : "",
    title: row.title,
    contentMd: row.contentMd,
    structured:
      row.structured && typeof row.structured === "object" && !Array.isArray(row.structured)
        ? (row.structured as Record<string, unknown>)
        : null,
    evidence: projectEvidence(row.evidence),
    sourceCommit: row.sourceCommit,
    repoFingerprint: row.repoFingerprint,
    tokenEstimate: Number.isFinite(row.tokenEstimate) ? row.tokenEstimate : 0,
    contentHash: row.contentHash,
    status,
    buildError: row.buildError,
    generatedBy: row.generatedBy,
    generatedAt: row.generatedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A view is stale when it was built against a different repo fingerprint than the
 * capability's current one. Unknown on either side → not stale (we do not cry wolf
 * for capabilities that have no repo, or that were never fingerprinted).
 */
export function isViewStale(viewFingerprint: string | null, currentFingerprint: string | null): boolean {
  if (!viewFingerprint || !currentFingerprint) return false;
  return viewFingerprint !== currentFingerprint;
}

/**
 * The in-memory key for a view, matching the (kind, domainKey) unique index.
 *
 * It lives here so the separator is written once. Anywhere a map is BUILT with
 * one separator and READ with another, every lookup misses and the caller
 * silently sees zero views — a failure that looks exactly like "nobody has built
 * views yet". A shared helper makes that mismatch unrepresentable.
 *
 * The separator is U+0000 rather than a space because a task_guide's domainKey
 * is free text ("add a migration"), so a space would not reliably delimit.
 */
export function viewKey(kind: WorldModelViewKind | string, domainKey: string): string {
  return `${kind}\u0000${domainKey}`;
}
