/**
 * M61 Slice A — CapabilityWorldModel service helpers.
 *
 * Single read/write surface for the "world model" row each capability
 * owns. Callers from the bootstrap flow (Slice C — auto-promote agent
 * rules), the Tests & Build wizard (Slice D), the drift detector
 * (Slice E), the CODE_WORLD_MODEL prompt layer (Slice F), and the
 * async bootstrap phases (Slice B) all go through here so the JSON
 * shape stays normalized.
 *
 * The Prisma model stores agentRules / testCommands / etc. as raw
 * JSONB. This file pins their TypeScript shapes and provides safe
 * coercion at read time — JSONB returns `Prisma.JsonValue`, which
 * forces every consumer to defend against `unknown`.
 */
import { Prisma } from "../../../generated/prisma-client";
import { prisma } from "../../config/prisma";

// ---------- Public TS shapes ------------------------------------------------

/**
 * A command the operator (or the verifier-registry heuristic) believes
 * we should run against this capability. testCommands / buildCommands /
 * runCommands all share this shape so the wizard UI doesn't need three
 * different forms.
 *
 * `kind` is documentation for humans — the agent decides when to run
 * a unit vs. integration vs. e2e suite based on the workflow stage.
 */
export type CapabilityCommand = {
  kind: string;
  cmd: string;
  cwd?: string;
  expectedDurationSec?: number;
  requiresNetwork?: boolean;
  // Optional verification receipt from the Slice D "Verify now" button:
  // last time the operator ran this and saw it pass.
  lastVerifiedAt?: string;
  lastVerifiedExitCode?: number;
  lastVerifiedDurationMs?: number;
};

/**
 * A privileged ambient-context file. Sources we auto-promote at
 * bootstrap (Slice C):
 *   CLAUDE.md, AGENTS.md, .cursor/rules/*, .cursorrules,
 *   .windsurfrules, .claude/*, .github/copilot-instructions.md, SKILL.md.
 *
 * `sha256` lets the drift detector notice when an upstream rule file
 * changed without re-fetching the body.
 */
export type AgentRule = {
  source: string;
  content: string;
  sha256: string;
};

/**
 * The architectureSlice JSONB — mirrors the M43 `repo_map` tool's
 * output shape (top-level packages + public symbols, no method
 * bodies). Cached here so workflow start doesn't re-walk the tree.
 */
export type ArchitectureSlice = {
  rootPackages?: Array<{
    path: string;
    language?: string;
    publicSymbols?: string[];
  }>;
  // Free-form bag so we can extend without breaking callers.
  extras?: Record<string, unknown>;
};

// ---------- M99 S4.2 — enrichment shapes ------------------------------------

/** A detected repo convention / structural pattern. */
export type RepoPattern = {
  kind: string;        // e.g. "test_layout" | "module_boundary" | "naming"
  pattern: string;     // human-readable description
  example?: string;
  confidence?: number; // 0..1
};

/** How the app is started/exercised — a code location + its invocation. */
export type Entrypoint = {
  kind: string;        // main | server | cli | worker
  target: string;      // file path or symbol
  command?: string;
};

/** A pre-existing/flaky failure the agent must NOT treat as a regression. */
export type KnownFailure = {
  test: string;
  reason?: string;
  firstSeenAt?: string;
  flaky?: boolean;
};

/** A distilled summary of a skill/instruction file. */
export type SkillFileSummary = {
  source: string;
  summary: string;
  sha256?: string;
};

/** A parsed/structured code convention (vs raw agentRules text). */
export type CodeConvention = {
  topic: string;       // e.g. "imports" | "error_handling" | "tests"
  rule: string;
  source?: string;
};

export type CapabilityWorldModelView = {
  id: string;
  capabilityId: string;
  repoFingerprint: string | null;
  primaryLanguage: string | null;
  buildSystem: string | null;
  testCommands: CapabilityCommand[];
  buildCommands: CapabilityCommand[];
  runCommands: CapabilityCommand[];
  agentRules: AgentRule[];
  readmeSummary: string | null;
  architectureSlice: ArchitectureSlice;
  astIndexedAt: Date | null;
  astIndexFiles: number;
  // M99 S4.2 enrichment
  repoPatterns: RepoPattern[];
  entrypoints: Entrypoint[];
  knownFailures: KnownFailure[];
  skillFileSummaries: SkillFileSummary[];
  codeConventions: CodeConvention[];
  lastAutoRefreshAt: Date | null;
  generatedAt: Date;
  refreshedAt: Date;
};

// ---------- Coercion (JSONB → TS) ------------------------------------------

function asCommands(value: Prisma.JsonValue | undefined): CapabilityCommand[] {
  if (!Array.isArray(value)) return [];
  const out: CapabilityCommand[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const kind = typeof obj.kind === "string" ? obj.kind : "";
    const cmd = typeof obj.cmd === "string" ? obj.cmd : "";
    if (!kind || !cmd) continue;
    out.push({
      kind,
      cmd,
      cwd: typeof obj.cwd === "string" ? obj.cwd : undefined,
      expectedDurationSec:
        typeof obj.expectedDurationSec === "number" ? obj.expectedDurationSec : undefined,
      requiresNetwork:
        typeof obj.requiresNetwork === "boolean" ? obj.requiresNetwork : undefined,
      lastVerifiedAt:
        typeof obj.lastVerifiedAt === "string" ? obj.lastVerifiedAt : undefined,
      lastVerifiedExitCode:
        typeof obj.lastVerifiedExitCode === "number" ? obj.lastVerifiedExitCode : undefined,
      lastVerifiedDurationMs:
        typeof obj.lastVerifiedDurationMs === "number" ? obj.lastVerifiedDurationMs : undefined,
    });
  }
  return out;
}

function asAgentRules(value: Prisma.JsonValue | undefined): AgentRule[] {
  if (!Array.isArray(value)) return [];
  const out: AgentRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const source = typeof obj.source === "string" ? obj.source : "";
    const content = typeof obj.content === "string" ? obj.content : "";
    const sha256 = typeof obj.sha256 === "string" ? obj.sha256 : "";
    if (!source || !content) continue;
    out.push({ source, content, sha256 });
  }
  return out;
}

function asArchitectureSlice(value: Prisma.JsonValue | undefined): ArchitectureSlice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as ArchitectureSlice;
}

// M99 S4.2 — generic JSON-array coercion for the enrichment fields. Keeps
// only object entries that have the required string keys; everything else
// is dropped so a malformed JSONB blob can't crash a consumer.
function asObjectArray<T>(
  value: Prisma.JsonValue | undefined,
  required: string[],
): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (required.every((k) => typeof obj[k] === "string" && (obj[k] as string).length > 0)) {
      out.push(obj as unknown as T);
    }
  }
  return out;
}

/**
 * Project a Prisma row to the public view. The Prisma client returns
 * `JsonValue` for JSONB columns; this is the only place that handles
 * the coercion so callers can stay strongly typed.
 */
export function projectWorldModel(row: {
  id: string;
  capabilityId: string;
  repoFingerprint: string | null;
  primaryLanguage: string | null;
  buildSystem: string | null;
  testCommands: Prisma.JsonValue;
  buildCommands: Prisma.JsonValue;
  runCommands: Prisma.JsonValue;
  agentRules: Prisma.JsonValue;
  readmeSummary: string | null;
  architectureSlice: Prisma.JsonValue;
  astIndexedAt: Date | null;
  astIndexFiles: number;
  // M99 S4.2 — optional so callers projecting a pre-migration row shape
  // (or a partial select) still type-check; coercion defaults to [].
  repoPatterns?: Prisma.JsonValue;
  entrypoints?: Prisma.JsonValue;
  knownFailures?: Prisma.JsonValue;
  skillFileSummaries?: Prisma.JsonValue;
  codeConventions?: Prisma.JsonValue;
  lastAutoRefreshAt?: Date | null;
  generatedAt: Date;
  refreshedAt: Date;
}): CapabilityWorldModelView {
  return {
    id: row.id,
    capabilityId: row.capabilityId,
    repoFingerprint: row.repoFingerprint,
    primaryLanguage: row.primaryLanguage,
    buildSystem: row.buildSystem,
    testCommands: asCommands(row.testCommands),
    buildCommands: asCommands(row.buildCommands),
    runCommands: asCommands(row.runCommands),
    agentRules: asAgentRules(row.agentRules),
    readmeSummary: row.readmeSummary,
    architectureSlice: asArchitectureSlice(row.architectureSlice),
    astIndexedAt: row.astIndexedAt,
    astIndexFiles: row.astIndexFiles,
    repoPatterns: asObjectArray<RepoPattern>(row.repoPatterns, ["kind", "pattern"]),
    entrypoints: asObjectArray<Entrypoint>(row.entrypoints, ["kind", "target"]),
    knownFailures: asObjectArray<KnownFailure>(row.knownFailures, ["test"]),
    skillFileSummaries: asObjectArray<SkillFileSummary>(row.skillFileSummaries, ["source", "summary"]),
    codeConventions: asObjectArray<CodeConvention>(row.codeConventions, ["topic", "rule"]),
    lastAutoRefreshAt: row.lastAutoRefreshAt ?? null,
    generatedAt: row.generatedAt,
    refreshedAt: row.refreshedAt,
  };
}

// ---------- Read --------------------------------------------------------------

export async function getWorldModel(
  capabilityId: string,
): Promise<CapabilityWorldModelView | null> {
  const row = await prisma.capabilityWorldModel.findUnique({
    where: { capabilityId },
  });
  return row ? projectWorldModel(row) : null;
}

// ---------- Write (upsert + targeted patch) ----------------------------------

export type WorldModelUpsertInput = {
  capabilityId: string;
  repoFingerprint?: string | null;
  primaryLanguage?: string | null;
  buildSystem?: string | null;
  testCommands?: CapabilityCommand[];
  buildCommands?: CapabilityCommand[];
  runCommands?: CapabilityCommand[];
  agentRules?: AgentRule[];
  readmeSummary?: string | null;
  architectureSlice?: ArchitectureSlice;
  astIndexedAt?: Date | null;
  astIndexFiles?: number;
  // M99 S4.2 enrichment — each owned by the bootstrap/refresh worker.
  repoPatterns?: RepoPattern[];
  entrypoints?: Entrypoint[];
  knownFailures?: KnownFailure[];
  skillFileSummaries?: SkillFileSummary[];
  codeConventions?: CodeConvention[];
  lastAutoRefreshAt?: Date | null;
};

/**
 * Upsert the world-model row. Caller specifies only the fields it
 * owns — the bootstrap path writes (fingerprint, language, buildSystem,
 * agentRules), the Slice D wizard writes testCommands/buildCommands,
 * the P2 async worker writes (astIndexedAt, astIndexFiles), the P4
 * worker writes readmeSummary + architectureSlice.
 */
export async function upsertWorldModel(
  input: WorldModelUpsertInput,
): Promise<CapabilityWorldModelView> {
  const data: Prisma.CapabilityWorldModelUncheckedUpdateInput = {};
  if (input.repoFingerprint !== undefined) data.repoFingerprint = input.repoFingerprint;
  if (input.primaryLanguage !== undefined) data.primaryLanguage = input.primaryLanguage;
  if (input.buildSystem !== undefined) data.buildSystem = input.buildSystem;
  if (input.testCommands !== undefined) data.testCommands = input.testCommands as unknown as Prisma.InputJsonValue;
  if (input.buildCommands !== undefined) data.buildCommands = input.buildCommands as unknown as Prisma.InputJsonValue;
  if (input.runCommands !== undefined) data.runCommands = input.runCommands as unknown as Prisma.InputJsonValue;
  if (input.agentRules !== undefined) data.agentRules = input.agentRules as unknown as Prisma.InputJsonValue;
  if (input.readmeSummary !== undefined) data.readmeSummary = input.readmeSummary;
  if (input.architectureSlice !== undefined) data.architectureSlice = input.architectureSlice as unknown as Prisma.InputJsonValue;
  if (input.astIndexedAt !== undefined) data.astIndexedAt = input.astIndexedAt;
  if (input.astIndexFiles !== undefined) data.astIndexFiles = input.astIndexFiles;
  // M99 S4.2 enrichment fields.
  if (input.repoPatterns !== undefined) data.repoPatterns = input.repoPatterns as unknown as Prisma.InputJsonValue;
  if (input.entrypoints !== undefined) data.entrypoints = input.entrypoints as unknown as Prisma.InputJsonValue;
  if (input.knownFailures !== undefined) data.knownFailures = input.knownFailures as unknown as Prisma.InputJsonValue;
  if (input.skillFileSummaries !== undefined) data.skillFileSummaries = input.skillFileSummaries as unknown as Prisma.InputJsonValue;
  if (input.codeConventions !== undefined) data.codeConventions = input.codeConventions as unknown as Prisma.InputJsonValue;
  if (input.lastAutoRefreshAt !== undefined) data.lastAutoRefreshAt = input.lastAutoRefreshAt;

  const row = await prisma.capabilityWorldModel.upsert({
    where: { capabilityId: input.capabilityId },
    create: {
      capabilityId: input.capabilityId,
      repoFingerprint: input.repoFingerprint ?? null,
      primaryLanguage: input.primaryLanguage ?? null,
      buildSystem: input.buildSystem ?? null,
      testCommands: (input.testCommands ?? []) as unknown as Prisma.InputJsonValue,
      buildCommands: (input.buildCommands ?? []) as unknown as Prisma.InputJsonValue,
      runCommands: (input.runCommands ?? []) as unknown as Prisma.InputJsonValue,
      agentRules: (input.agentRules ?? []) as unknown as Prisma.InputJsonValue,
      readmeSummary: input.readmeSummary ?? null,
      architectureSlice: (input.architectureSlice ?? {}) as unknown as Prisma.InputJsonValue,
      astIndexedAt: input.astIndexedAt ?? null,
      astIndexFiles: input.astIndexFiles ?? 0,
      repoPatterns: (input.repoPatterns ?? []) as unknown as Prisma.InputJsonValue,
      entrypoints: (input.entrypoints ?? []) as unknown as Prisma.InputJsonValue,
      knownFailures: (input.knownFailures ?? []) as unknown as Prisma.InputJsonValue,
      skillFileSummaries: (input.skillFileSummaries ?? []) as unknown as Prisma.InputJsonValue,
      codeConventions: (input.codeConventions ?? []) as unknown as Prisma.InputJsonValue,
      lastAutoRefreshAt: input.lastAutoRefreshAt ?? null,
    },
    update: data,
  });
  return projectWorldModel(row);
}

// ---------- M99 S4.2 — auto-refresh bookkeeping ------------------------------

/**
 * Stamp lastAutoRefreshAt so operators can see the world model is
 * self-healing on drift (vs the pre-M99 observational-only behavior).
 * Separate from upsertWorldModel so the refresh worker can mark an
 * attempt even when it has no new field values to write. No-op-safe:
 * upserts the row if it somehow doesn't exist yet.
 */
export async function markWorldModelAutoRefreshed(
  capabilityId: string,
  at: Date,
): Promise<void> {
  await prisma.capabilityWorldModel.upsert({
    where: { capabilityId },
    create: { capabilityId, lastAutoRefreshAt: at },
    update: { lastAutoRefreshAt: at },
  });
}
