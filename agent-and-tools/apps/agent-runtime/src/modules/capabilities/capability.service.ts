import { Prisma } from "../../../generated/prisma-client";
import { v4 as uuidv4 } from "uuid";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors";
import { sha256 } from "../../shared/hash";
import { readUpstreamJsonObject } from "../../shared/upstream-json";
import { extractSymbols, type InputFile } from "./symbol-extractor";
import {
  getEmbeddingProvider, REQUIRED_EMBEDDING_DIM, assertDimMatches, toVectorLiteral,
} from "@agentandtools/shared";
import { summariseSymbol, fileSnippetFor } from "../../lib/llm/summarise";
import { syncIamCapabilityReference } from "./iam-capability-reference";
// M61 Slice C — Auto-promote CLAUDE.md / AGENTS.md into the
// CapabilityWorldModel.agentRules JSONB so the prompt-composer's
// CODE_AGENT_RULES layer (Slice F) can render them directly without
// waiting for human review of the corresponding CapabilityLearningCandidate.
import { upsertWorldModel } from "./world-model.service";
// M61 Slice B — Async bootstrap orchestration. The slow discovery
// block runs as Phase 1 either inline (default) or fired off via
// setImmediate when BOOTSTRAP_ASYNC=true. Phase progress is stamped
// on CapabilityBootstrapRun.phaseProgress so the wizard UI can poll.
import {
  PHASE_KEYS,
  isAsyncBootstrapEnabled,
  isCapabilityAutoGroundEnabled,
  isGroundCodeAtOnboardEnabled,
  markPhaseStarted,
  markPhaseCompleted,
  markPhaseFailed,
  markPhaseSkipped,
  patchPhase,
} from "./bootstrap-phases";
import {
  deriveCapabilityGroundingState,
  learningMessageForStatus,
  missingRepositoryMessage,
  shouldRecordGroundingAttempt,
  buildGroundingFixCommand,
  type CapabilityLearningGroundingStatus,
} from "./capability-grounding-status";
import { isBootstrapRunStale, BOOTSTRAP_REAP_ERROR } from "./capability-bootstrap-reaper";
import {
  capabilityDuplicateConflictMessage,
  capabilityDuplicateWhere,
  capabilityNaturalKey,
  normalizedCapabilityType,
  normalizedIdentityValue,
  type CapabilityIdentityInput,
} from "./capability-identity";
import { sourceBackedKnowledgeArtifactKey } from "./capability-knowledge-identity";
import {
  capabilityKnowledgeSourceKey,
  capabilityRepositorySourceKey,
  normalizedKnowledgeArtifactType,
  normalizedRepositoryBranch,
  normalizedRepositoryType,
  normalizedSourceValue,
} from "./capability-source-identity";
import { capabilityCodeSymbolKey } from "./capability-code-symbol-identity";
import {
  capabilityCodeEmbeddingKey,
  normalizedCodeEmbeddingValue,
} from "./capability-code-embedding-identity";
import { capabilityAgentBindingKey } from "./capability-binding-identity";
import {
  capabilityAgentTemplateKey,
  normalizedAgentTemplateName,
} from "./capability-agent-template-identity";
import {
  capabilityLearningCandidateKey,
  normalizedLearningCandidateIdentityValue,
} from "./capability-learning-candidate-identity";
import { collapseCapabilityListDuplicates } from "./capability-list-identity";
import { assertCapabilityNotArchived, requireActiveCapability } from "./capability-lifecycle";
import { loadAgentCatalog, type AgentCatalogItem } from "./agent-catalog-config";
// M61 Wire B P3 — README distillation + architecture slice worker.
// Runs after Phase 1 completes (both sync and async paths) and writes
// readmeSummary + architectureSlice.rootPackages to CapabilityWorldModel.
import { runBootstrapDistillationPhase, distillAndUpsertWorldModel } from "./bootstrap-phase3-distill";

const CAPABILITY_LEARNING_RUN_STALE_MS = env.CAPABILITY_LEARNING_RUN_STALE_MS;
const CAPABILITY_DISCOVERY_FETCH_TIMEOUT_MS = env.CAPABILITY_DISCOVERY_FETCH_TIMEOUT_SEC * 1000;
const AGENT_GOVERNANCE_LIMITS_TIMEOUT_MS = env.AGENT_GOVERNANCE_LIMITS_TIMEOUT_SEC * 1000;
type CapabilityLearningWorkerOperation = "grounding" | "sync";

async function claimCapabilityLearningWorker(capabilityId: string, operation: CapabilityLearningWorkerOperation): Promise<() => Promise<void>> {
  const staleAfterMs = Math.max(CAPABILITY_LEARNING_RUN_STALE_MS, 60_000);
  const ownerId = uuidv4();
  const expiresAt = new Date(Date.now() + staleAfterMs);
  const claim = await prisma.$queryRaw<Array<{ ownerId: string }>>`
    INSERT INTO "CapabilityLearningWorkerLock" (
      "id", "capabilityId", "operation", "ownerId", "startedAt", "expiresAt", "createdAt", "updatedAt"
    )
    SELECT ${uuidv4()}, ${capabilityId}, ${operation}, ${ownerId}, CURRENT_TIMESTAMP, ${expiresAt}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM "Capability" c
    WHERE c.id = ${capabilityId}
      AND c.status <> 'ARCHIVED'
    ON CONFLICT ("capabilityId") DO UPDATE
    SET
      "operation" = EXCLUDED."operation",
      "ownerId" = EXCLUDED."ownerId",
      "startedAt" = EXCLUDED."startedAt",
      "expiresAt" = EXCLUDED."expiresAt",
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "CapabilityLearningWorkerLock"."expiresAt" <= CURRENT_TIMESTAMP
    RETURNING "ownerId"
  `;
  if (claim[0]?.ownerId !== ownerId) {
    await requireActiveCapability(capabilityId, "Cannot run learning worker for an archived capability.");
    const [current] = await prisma.$queryRaw<Array<{ operation: string; expiresAt: Date | null }>>`
      SELECT "operation", "expiresAt"
      FROM "CapabilityLearningWorkerLock"
      WHERE "capabilityId" = ${capabilityId}
      LIMIT 1
    `;
    const runningOperation = current?.operation === "grounding" ? "Repository grounding refresh" : "Approved source sync";
    const retryHint = current?.expiresAt instanceof Date
      ? `retry after ${current.expiresAt.toISOString()} if the worker crashed`
      : `retry after ${Math.ceil(staleAfterMs / 60000)} minutes if the worker crashed`;
    throw new ConflictError(
      `${runningOperation} is already running for this capability. Wait for the current learning worker to finish, or ${retryHint}.`,
    );
  }
  return async () => {
    await prisma.$executeRaw`
      DELETE FROM "CapabilityLearningWorkerLock"
      WHERE "capabilityId" = ${capabilityId}
        AND "ownerId" = ${ownerId}
    `;
  };
}

// The bootstrap agent catalog (the 9 role-agents) and the team presets are now
// externalized to agent-catalog-config.ts — an env-pointed JSON config with a
// compiled-in default equal to what used to live here. This alias keeps the
// local type name used throughout this file.
type BootstrapAgentCatalogItem = AgentCatalogItem;

const DISCOVERY_FILE_CAP = 60;
const DISCOVERY_TOTAL_CHAR_CAP = 500_000;
const DISCOVERY_SOURCE_CHAR_CAP = 40_000;
const LOCAL_BOOTSTRAP_REF = "local://bootstrap-source";
const ENABLE_LLM_SYMBOL_SUMMARIES = (process.env.ENABLE_LLM_SYMBOL_SUMMARIES ?? "0") === "1";

type BootstrapRepositoryInput = {
  repoName?: string;
  repoUrl: string;
  defaultBranch?: string;
  repositoryType?: string;
};

type BootstrapDocumentInput = {
  url: string;
  artifactType?: string;
  title?: string;
  pollIntervalSec?: number | null;
};

type BootstrapInput = {
  name: string;
  appId?: string;
  parentCapabilityId?: string;
  capabilityType?: string;
  businessUnitId?: string;
  ownerTeamId?: string;
  criticality?: string;
  description?: string;
  targetWorkflowPattern?: string;
  agentPreset?: "minimal" | "engineering_core" | "governed_delivery";
  includeAgentKeys?: string[];
  excludeAgentKeys?: string[];
  childCapabilityIds?: string[];
  sharedApplications?: string[];
  repositories?: BootstrapRepositoryInput[];
  documentLinks?: BootstrapDocumentInput[];
  localFiles?: InputFile[];
  // M61 Slice D — Operator-confirmed test/build commands from the
  // capabilities wizard's "Tests & Build" step. Written verbatim
  // into the new CapabilityWorldModel row after bootstrap.
  testCommands?: Array<{ kind: string; cmd: string; cwd?: string; expectedDurationSec?: number; requiresNetwork?: boolean }>;
  buildCommands?: Array<{ kind: string; cmd: string; cwd?: string }>;
};

type DiscoveryDoc = {
  title: string;
  content: string;
  sourceType: string;
  sourceRef: string;
  path?: string;
  metadata?: Record<string, unknown>;
};

type RepositoryProfile = {
  repoName: string;
  repoUrl: string;
  branch: string;
  fileCount: number;
  totalBytes: number;
  languages: Array<{ language: string; files: number }>;
  frameworks: string[];
  buildTools: string[];
  endpointCount: number;
  endpoints: Array<{ method: string; path: string; file: string }>;
  keyFiles: string[];
  graphMermaid: string;
};

type RepositoryProfileSummary = Pick<RepositoryProfile, "repoName" | "languages" | "frameworks" | "buildTools" | "endpointCount">;

type RepositoryRefreshResult = {
  refreshed: number;
  artifacts: number;
  profiles: RepositoryProfileSummary[];
  warnings: string[];
};

type CapabilityArchitectureDiagram = {
  kind: "APPLICATION_CAPABILITY_ARCHITECTURE" | "TOGAF_CAPABILITY_COLLECTION";
  title: string;
  view: "application" | "togaf";
  description: string;
  mermaid: string;
  codeGraphMermaid?: string;
  repositoryProfiles?: RepositoryProfile[];
  highlights?: Array<{ key: string; label: string; value: string; detail?: string }>;
  layers: Array<{ key: string; label: string; items: string[] }>;
};

type ReadinessStatus = "READY" | "NEEDS_ATTENTION" | "NOT_READY" | "UNKNOWN";

type ReadinessCheck = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  severity: "blocker" | "warning" | "info";
};

type ReadinessCategory = {
  key: string;
  label: string;
  score: number;
  maxScore: number;
  status: ReadinessStatus;
  summary: string;
  checks: ReadinessCheck[];
};

export const capabilityService = {
  bootstrapAgentCatalog() {
    const catalog = loadAgentCatalog();
    return {
      // Presets come from config now (any custom preset shows up here too), each
      // normalized to catalog order to match what bootstrap will actually materialize.
      presets: Object.entries(catalog.presets).map(([key, preset]) => ({
        key,
        label: preset.label,
        agents: catalog.agents.filter(agent => preset.agents.includes(agent.key)).map(agent => agent.key),
      })),
      agents: catalog.agents,
    };
  },

  async create(input: {
    name: string; parentCapabilityId?: string; capabilityType?: string;
    appId?: string; businessUnitId?: string; ownerTeamId?: string; criticality?: string; description?: string;
  }, authHeader?: string) {
    const capability = await prisma.$transaction(async (tx) => {
      await lockCapabilityNaturalKey(tx, input);
      await assertNoActiveCapabilityDuplicate(tx, input);
      return tx.capability.create({ data: { ...input, status: "ACTIVE" } });
    }).catch(err => rethrowCapabilityIdentityConflict(err, input));
    const warning = await syncIamCapabilityReference(capability, { authHeader });
    if (warning) console.warn(`[capability] ${warning}`);
    const governanceWarning = await ensureDefaultGovernanceLimits(capability.id);
    if (governanceWarning) console.warn(`[capability] ${governanceWarning}`);
    return capability;
  },

  async bootstrap(input: BootstrapInput, userId?: string, authHeader?: string) {
    const warnings: string[] = [];
    const errors: string[] = [];
    const requestedChildCapabilityIds = Array.from(new Set(input.childCapabilityIds ?? []));
    const capability = await prisma.$transaction(async (tx) => {
      await lockCapabilityNaturalKey(tx, input);
      await assertNoActiveCapabilityDuplicate(tx, input);
      return tx.capability.create({
        data: {
          name: input.name,
          appId: input.appId,
          parentCapabilityId: input.parentCapabilityId,
          capabilityType: input.capabilityType,
          businessUnitId: input.businessUnitId,
          ownerTeamId: input.ownerTeamId,
          criticality: input.criticality,
          description: input.description,
          status: "ACTIVE",
        },
      });
    }).catch(err => rethrowCapabilityIdentityConflict(err, input));
    const iamWarning = await syncIamCapabilityReference(capability, {
      authHeader,
      ownerUserId: userId,
      metadata: {
        bootstrapRunPending: true,
        childCapabilityIds: requestedChildCapabilityIds,
        sharedApplications: input.sharedApplications ?? [],
      },
    });
    if (iamWarning) warnings.push(iamWarning);
    const governanceWarning = await ensureDefaultGovernanceLimits(capability.id);
    if (governanceWarning) warnings.push(governanceWarning);

    // M61 Slice B — Phase 0: synchronous setup is now reflected in
    // the BootstrapRun's currentPhase + phaseProgress. If async is
    // enabled we return early after marking Phase 1 as "running" so
    // the caller doesn't block on the slow discovery work.
    const phase0Started = new Date().toISOString();
    const run = await prisma.capabilityBootstrapRun.create({
      data: {
        capabilityId: capability.id,
        status: "RUNNING",
        createdBy: userId,
        currentPhase: PHASE_KEYS.P0,
        phaseProgress: {
          [PHASE_KEYS.P0]: { status: "running", startedAt: phase0Started },
        },
        sourceSummary: {
          repositories: input.repositories?.length ?? 0,
          documentLinks: input.documentLinks?.length ?? 0,
          localFiles: input.localFiles?.length ?? 0,
        },
      },
    });
    // Phase 0 is the synchronous prelude — capability row, IAM sync,
    // governance defaults, BootstrapRun row. Everything above this
    // point has already completed by the time we get here.
    await markPhaseCompleted(run.id, PHASE_KEYS.P0, {
      iamWarning: Boolean(iamWarning),
      governanceWarning: Boolean(governanceWarning),
    });

    // M61 Slice B — async opt-in. When enabled, return the just-created
    // run row immediately (status=RUNNING, currentPhase=phase1_discovery)
    // and fire the heavy work via setImmediate. The UI polls
    // GET /capabilities/:id/bootstrap-runs/:runId to render progress.
    if (isAsyncBootstrapEnabled()) {
      await patchPhase(run.id, PHASE_KEYS.P1, { status: "pending" }, { setCurrentPhase: PHASE_KEYS.P1 });
      setImmediate(() => {
        capabilityService.runBootstrapDiscoveryPhase({
          capability,
          run,
          input,
          userId,
          warnings,
          errors,
          requestedChildCapabilityIds,
        }).catch(async (err) => {
          // Top-level catch: anything that escapes runBootstrapDiscoveryPhase
          // means the worker itself crashed before it could mark its own
          // failure. Stamp the run as FAILED so the UI doesn't spin forever.
          // eslint-disable-next-line no-console
          console.error(`[bootstrap.async] capabilityId=${capability.id} runId=${run.id} crashed: ${(err as Error).message}`);
          try {
            await markPhaseFailed(run.id, PHASE_KEYS.P1, err as Error);
            await prisma.capabilityBootstrapRun.update({
              where: { id: run.id },
              data: { status: "FAILED", completedAt: new Date(), currentPhase: PHASE_KEYS.DONE },
            });
          } catch {
            // Best-effort; the worker already crashed.
          }
        });
      });
      return run;
    }

    // M61 Slice B — Sync path: mark Phase 1 as started so both code
    // paths produce consistent phaseProgress. The phase is closed at
    // the end of the try block / failed in the catch.
    await markPhaseStarted(run.id, PHASE_KEYS.P1);

    const generatedAgents: Array<{
      id: string;
      key: string;
      roleType: string;
      bindingRole: string;
      label: string;
      name: string;
      baseTemplateId?: string | null;
      bindingId?: string;
      locked: boolean;
      activationRequired: boolean;
      learnsFromGit: boolean;
      grounding: string;
    }> = [];
    const discovered: DiscoveryDoc[] = [];
    const repositoryProfiles: RepositoryProfile[] = [];

    try {
      const common = await prisma.agentTemplate.findMany({
        where: { capabilityId: null, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
      });

      const selectedAgents = selectBootstrapAgents(input);
      for (const agent of selectedAgents) {
        const base = common.find(t => t.roleType === agent.baseRoleType);
        if (!base) warnings.push(`No common ${agent.baseRoleType} base template found for ${agent.label}; created a draft placeholder.`);
        const template = await persistCapabilityAgentTemplate({
          name: `${capability.name} ${agent.label} Agent`,
          roleType: agent.roleType,
          description: capabilityAgentDescription(capability.name, agent, base?.description),
          basePromptProfileId: base?.basePromptProfileId ?? undefined,
          defaultToolPolicyId: base?.defaultToolPolicyId ?? undefined,
          capabilityId: capability.id,
          baseTemplateId: base?.id ?? undefined,
          lockedReason: agent.locked ? `${agent.label} is a locked capability gate derived from the platform baseline.` : null,
          status: "DRAFT",
          createdBy: userId,
        });
        const binding = await persistAgentCapabilityBinding({
          capabilityId: capability.id,
          agentTemplateId: template.id,
          bindingName: `${agent.label} binding`,
          roleInCapability: agent.bindingRole,
          status: "DRAFT",
          createdBy: userId,
        });
        generatedAgents.push({
          id: template.id,
          key: agent.key,
          roleType: agent.roleType,
          bindingRole: agent.bindingRole,
          label: agent.label,
          name: template.name,
          baseTemplateId: template.baseTemplateId ?? base?.id,
          bindingId: binding.id,
          locked: agent.locked,
          activationRequired: agent.activationRequired,
          learnsFromGit: agent.learnsFromGit,
          grounding: agent.grounding,
        });
      }

      for (const repoInput of input.repositories ?? []) {
        const repoName = repoInput.repoName?.trim() || repoNameFromUrl(repoInput.repoUrl);
        const repo = await persistCapabilityRepositorySource(capability.id, {
          repoName,
          repoUrl: repoInput.repoUrl,
          defaultBranch: repoInput.defaultBranch ?? "main",
          repositoryType: repoInput.repositoryType ?? "GITHUB",
          pollIntervalSec: null,
        });
        try {
          const discovery = await discoverGitHubRepoWithProfile(repo.repoUrl, repo.defaultBranch ?? "main", userId);
          discovered.push(...discovery.docs);
          repositoryProfiles.push(discovery.profile);
        } catch (err) {
          warnings.push(`Repository discovery skipped for ${repo.repoName}: ${(err as Error).message}`);
        }
      }

      const requestedChildren = requestedChildCapabilityIds
        .filter(id => id && id !== capability.id);
      if (isCollectionCapabilityType(capability.capabilityType) && requestedChildren.length > 0) {
        await prisma.capability.updateMany({
          where: { id: { in: requestedChildren } },
          data: { parentCapabilityId: capability.id },
        });
      }

      for (const doc of input.documentLinks ?? []) {
        await persistCapabilityKnowledgeSource(capability.id, {
          url: doc.url,
          artifactType: doc.artifactType ?? "DOC",
          title: doc.title,
          pollIntervalSec: null,
        });
        try {
          discovered.push(await fetchDocumentLink(doc));
        } catch (err) {
          warnings.push(`Document discovery skipped for ${doc.url}: ${(err as Error).message}`);
        }
      }

      if ((input.localFiles ?? []).length > 0) {
        await persistCapabilityRepositorySource(capability.id, {
          repoName: "Local bootstrap source",
          repoUrl: LOCAL_BOOTSTRAP_REF,
          defaultBranch: "local",
          repositoryType: "LOCAL",
          pollIntervalSec: null,
        });
        discovered.push(...discoverLocalSignals(input.localFiles ?? []));
      }

      const architectureDiagram = buildCapabilityArchitectureDiagram(capability, input, generatedAgents, discovered, repositoryProfiles);

      // M61 Slice C — Seed CapabilityWorldModel with the privileged
      // agent-rule files (CLAUDE.md / AGENTS.md / .cursor/rules etc.)
      // plus best-guess primary language + build system pulled from
      // the repositoryProfiles. The Slice D wizard later overrides
      // language/buildSystem if the operator confirms different values.
      //
      // Best-effort: a failure here must not break the whole bootstrap.
      // Discovered rule docs still live in the CapabilityLearningCandidate
      // table, so an operator can recover by approving them manually.
      try {
        const agentRules = extractAgentRules(discovered);
        const primaryLanguage = pickPrimaryLanguage(repositoryProfiles);
        const buildSystem = pickPrimaryBuildSystem(repositoryProfiles);
        // M61 Slice D — operator-confirmed test/build commands from
        // the wizard. Bootstrap schema accepts them as parsed arrays;
        // empty arrays mean the operator skipped the step and we'll
        // fall back to the runtime verifier-registry heuristics.
        const testCommands = input.testCommands ?? [];
        const buildCommands = input.buildCommands ?? [];
        // Always create the world-model row on onboarding, even when the
        // discovery pass found nothing yet (empty rules/commands). The upsert
        // is idempotent and the row is enriched later by the AST / distillation
        // / drift-refresh workers. Guaranteeing the row exists means
        // context-fabric's per-phase injection never silently 404s for an
        // onboarded capability.
        await upsertWorldModel({
          capabilityId: capability.id,
          agentRules,
          primaryLanguage,
          buildSystem,
          testCommands,
          buildCommands,
        });
      } catch (err) {
        warnings.push(`World-model seed failed: ${(err as Error).message}`);
      }

      const candidates = [
        buildArchitectureDiagramCandidate(capability.name, architectureDiagram),
        ...buildPlatformInventoryCandidates(repositoryProfiles),
        ...buildLearningCandidates(discovered),
        ...buildAgentGroundingCandidates(capability.name, selectedAgents, discovered),
      ];
      const reusedLearningCandidateIds: string[] = [];
      for (const candidate of candidates) {
        const persisted = await persistCapabilityLearningCandidate({
          capabilityId: capability.id,
          bootstrapRunId: run.id,
          groupKey: candidate.groupKey,
          groupTitle: candidate.groupTitle,
          artifactType: candidate.artifactType,
          title: candidate.title,
          content: candidate.content,
          sourceType: candidate.sourceType,
          sourceRef: candidate.sourceRef,
          confidence: candidate.confidence,
          status: "PENDING",
        });
        if (persisted.bootstrapRunId && persisted.bootstrapRunId !== run.id) {
          reusedLearningCandidateIds.push(persisted.id);
        }
      }

      // B (auto-grounding) — make onboarding yield a usable team: activate the
      // non-locked agents + materialize internally-derived knowledge now, so the
      // capability is runnable without the separate manual review step. Locked
      // gates + external knowledge stay for review. Opt-in via CAPABILITY_AUTO_GROUND.
      const autoGround = await autoGroundCapability(capability.id, run.id, generatedAgents, userId);
      if (autoGround.reviewNote) warnings.push(autoGround.reviewNote);
      // D3 — eager central code grounding (clone + AST index server-side) at onboard.
      void triggerCentralCodeGrounding(capability.id);

      // M61 Slice B — Capture the row first, then stamp phase
      // closures, then return. Previously the original code returned
      // the awaited update directly; we await + assign here so the
      // sync path can mark phaseProgress identically to the async
      // worker before handing control back to the controller.
      const runResult = await prisma.capabilityBootstrapRun.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          generatedAgentIds: generatedAgents as unknown as Prisma.InputJsonValue,
          warnings,
          errors,
          sourceSummary: {
            repositories: input.repositories?.length ?? 0,
            documentLinks: input.documentLinks?.length ?? 0,
            localFiles: input.localFiles?.length ?? 0,
            discoveredSignals: discovered.length,
            candidateGroups: candidates.length,
            reusedLearningCandidateIds: Array.from(new Set(reusedLearningCandidateIds)),
            reusedLearningCandidateCount: new Set(reusedLearningCandidateIds).size,
            childCapabilityIds: requestedChildren,
            sharedApplications: input.sharedApplications ?? [],
            repositoryProfiles,
            agentPreset: input.agentPreset ?? "governed_delivery",
            operatingModel: buildOperatingModel(capability, input.targetWorkflowPattern, generatedAgents, candidates.length, architectureDiagram, repositoryProfiles, {
              childCapabilityIds: requestedChildren,
              sharedApplications: input.sharedApplications ?? [],
            }),
          },
        },
        include: { candidates: true, capability: { include: { bindings: { include: { agentTemplate: true } }, repositories: true, knowledgeSources: true } } },
      });
      await markPhaseCompleted(run.id, PHASE_KEYS.P1);
      // Phase 2 is "deferred at bootstrap" — mcp-server builds the AST
      // index lazily at first workflow run, then POSTs back to
      // /world-model/ast-index-built (M61 Wire B P2), which stamps
      // astIndexedAt + astIndexFiles on the WorldModel row. The
      // phaseProgress entry shows skipped here so the wizard UI can
      // render the bootstrap timeline without claiming work that
      // hasn't happened yet.
      await markPhaseSkipped(run.id, PHASE_KEYS.P2, "deferred to first workflow — mcp-server reports back via ast-index-built callback");
      // M61 Wire B P3 — Run the distillation worker inline. It marks
      // its own phaseProgress (started → completed / skipped / failed)
      // so the wizard UI gets the same progress shape regardless of
      // whether the worker found a README, no symbols, or errored.
      await runBootstrapDistillationPhase({ capabilityId: capability.id, runId: run.id });
      await patchPhase(run.id, PHASE_KEYS.DONE, { status: "completed", completedAt: new Date().toISOString() }, { setCurrentPhase: PHASE_KEYS.DONE });
      return runResult;
    } catch (err) {
      errors.push((err as Error).message);
      await markPhaseFailed(run.id, PHASE_KEYS.P1, err as Error);
      await prisma.capabilityBootstrapRun.update({
        where: { id: run.id },
        data: { status: "FAILED", completedAt: new Date(), currentPhase: PHASE_KEYS.DONE, generatedAgentIds: generatedAgents as unknown as Prisma.InputJsonValue, warnings, errors },
      });
      throw err;
    }
  },

  /**
   * M61 Slice B — Async Phase 1 worker.
   *
   * Re-runs the discovery + agent-generation + candidate-insert +
   * world-model-seed work outside the HTTP request. Called by
   * setImmediate after the bootstrap row is created when
   * BOOTSTRAP_ASYNC=true. The body is intentionally a minimal
   * rebuild of the inline bootstrap path — long-term we want to
   * extract one shared implementation, but for this slice we keep
   * both paths so the sync default cannot regress.
   *
   * Phases 2 (AST index) and 3 (distillation) are stubbed as
   * skipped — their workers land in follow-up commits. The
   * phaseProgress entries are written so the wizard UI can render
   * the full pipeline even before the workers exist.
   */
  async runBootstrapDiscoveryPhase(ctx: {
    capability: { id: string; name: string; capabilityType?: string | null; appId?: string | null };
    run: { id: string };
    input: BootstrapInput;
    userId?: string;
    warnings: string[];
    errors: string[];
    requestedChildCapabilityIds: string[];
  }): Promise<void> {
    const { capability, run, input, userId, warnings, errors, requestedChildCapabilityIds } = ctx;
    await markPhaseStarted(run.id, PHASE_KEYS.P1);

    const generatedAgents: Array<{
      id: string; key: string; roleType: string; bindingRole: string; label: string;
      name: string; baseTemplateId?: string | null; bindingId?: string; locked: boolean;
      activationRequired: boolean; learnsFromGit: boolean; grounding: string;
    }> = [];
    const discovered: DiscoveryDoc[] = [];
    const repositoryProfiles: RepositoryProfile[] = [];

    try {
      const common = await prisma.agentTemplate.findMany({
        where: { capabilityId: null, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
      });
      const selectedAgents = selectBootstrapAgents(input);
      for (const agent of selectedAgents) {
        const base = common.find((t) => t.roleType === agent.baseRoleType);
        if (!base) warnings.push(`No common ${agent.baseRoleType} base template found for ${agent.label}; created a draft placeholder.`);
        const template = await persistCapabilityAgentTemplate({
          name: `${capability.name} ${agent.label} Agent`,
          roleType: agent.roleType,
          description: capabilityAgentDescription(capability.name, agent, base?.description),
          basePromptProfileId: base?.basePromptProfileId ?? undefined,
          defaultToolPolicyId: base?.defaultToolPolicyId ?? undefined,
          capabilityId: capability.id,
          baseTemplateId: base?.id ?? undefined,
          lockedReason: agent.locked ? `${agent.label} is a locked capability gate derived from the platform baseline.` : null,
          status: "DRAFT",
          createdBy: userId,
        });
        const binding = await persistAgentCapabilityBinding({
          capabilityId: capability.id,
          agentTemplateId: template.id,
          bindingName: `${agent.label} binding`,
          roleInCapability: agent.bindingRole,
          status: "DRAFT",
          createdBy: userId,
        });
        generatedAgents.push({
          id: template.id, key: agent.key, roleType: agent.roleType, bindingRole: agent.bindingRole,
          label: agent.label, name: template.name, baseTemplateId: template.baseTemplateId ?? base?.id, bindingId: binding.id,
          locked: agent.locked, activationRequired: agent.activationRequired,
          learnsFromGit: agent.learnsFromGit, grounding: agent.grounding,
        });
      }

      for (const repoInput of input.repositories ?? []) {
        const repoName = repoInput.repoName?.trim() || repoNameFromUrl(repoInput.repoUrl);
        const repo = await persistCapabilityRepositorySource(capability.id, {
          repoName,
          repoUrl: repoInput.repoUrl,
          defaultBranch: repoInput.defaultBranch ?? "main",
          repositoryType: repoInput.repositoryType ?? "GITHUB",
          pollIntervalSec: null,
        });
        try {
          const discovery = await discoverGitHubRepoWithProfile(repo.repoUrl, repo.defaultBranch ?? "main", userId);
          discovered.push(...discovery.docs);
          repositoryProfiles.push(discovery.profile);
        } catch (err) {
          warnings.push(`Repository discovery skipped for ${repo.repoName}: ${(err as Error).message}`);
        }
      }

      const requestedChildren = requestedChildCapabilityIds.filter((id) => id && id !== capability.id);
      if (isCollectionCapabilityType(capability.capabilityType) && requestedChildren.length > 0) {
        await prisma.capability.updateMany({
          where: { id: { in: requestedChildren } },
          data: { parentCapabilityId: capability.id },
        });
      }

      for (const doc of input.documentLinks ?? []) {
        await persistCapabilityKnowledgeSource(capability.id, {
          url: doc.url,
          artifactType: doc.artifactType ?? "DOC",
          title: doc.title,
          pollIntervalSec: null,
        });
        try {
          discovered.push(await fetchDocumentLink(doc));
        } catch (err) {
          warnings.push(`Document discovery skipped for ${doc.url}: ${(err as Error).message}`);
        }
      }

      if ((input.localFiles ?? []).length > 0) {
        await persistCapabilityRepositorySource(capability.id, {
          repoName: "Local bootstrap source",
          repoUrl: LOCAL_BOOTSTRAP_REF,
          defaultBranch: "local",
          repositoryType: "LOCAL",
          pollIntervalSec: null,
        });
        discovered.push(...discoverLocalSignals(input.localFiles ?? []));
      }

      const architectureDiagram = buildCapabilityArchitectureDiagram(
        capability as Parameters<typeof buildCapabilityArchitectureDiagram>[0],
        input, generatedAgents, discovered, repositoryProfiles,
      );

      try {
        const agentRules = extractAgentRules(discovered);
        const primaryLanguage = pickPrimaryLanguage(repositoryProfiles);
        const buildSystem = pickPrimaryBuildSystem(repositoryProfiles);
        const testCommands = input.testCommands ?? [];
        const buildCommands = input.buildCommands ?? [];
        // Always create the world-model row (see sync path above). Idempotent
        // upsert; enriched later by AST / distillation / drift-refresh workers.
        await upsertWorldModel({
          capabilityId: capability.id,
          agentRules, primaryLanguage, buildSystem, testCommands, buildCommands,
        });
      } catch (err) {
        warnings.push(`World-model seed failed: ${(err as Error).message}`);
      }

      const candidates = [
        buildArchitectureDiagramCandidate(capability.name, architectureDiagram),
        ...buildPlatformInventoryCandidates(repositoryProfiles),
        ...buildLearningCandidates(discovered),
        ...buildAgentGroundingCandidates(capability.name, selectedAgents, discovered),
      ];
      const reusedLearningCandidateIds: string[] = [];
      for (const candidate of candidates) {
        const persisted = await persistCapabilityLearningCandidate({
          capabilityId: capability.id, bootstrapRunId: run.id,
          groupKey: candidate.groupKey, groupTitle: candidate.groupTitle,
          artifactType: candidate.artifactType, title: candidate.title, content: candidate.content,
          sourceType: candidate.sourceType, sourceRef: candidate.sourceRef,
          confidence: candidate.confidence, status: "PENDING",
        });
        if (persisted.bootstrapRunId && persisted.bootstrapRunId !== run.id) {
          reusedLearningCandidateIds.push(persisted.id);
        }
      }

      // B (auto-grounding) — same as the sync path: activate non-locked agents +
      // materialize internally-derived knowledge at onboard (opt-in). Runs before
      // the run is marked COMPLETED so the reviewNote lands in `warnings`.
      const autoGround = await autoGroundCapability(capability.id, run.id, generatedAgents, userId);
      if (autoGround.reviewNote) warnings.push(autoGround.reviewNote);
      // D3 — eager central code grounding (clone + AST index server-side) at onboard.
      void triggerCentralCodeGrounding(capability.id);

      await prisma.capabilityBootstrapRun.update({
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          generatedAgentIds: generatedAgents as unknown as Prisma.InputJsonValue,
          warnings, errors,
          sourceSummary: {
            repositories: input.repositories?.length ?? 0,
            documentLinks: input.documentLinks?.length ?? 0,
            localFiles: input.localFiles?.length ?? 0,
            discoveredSignals: discovered.length,
            candidateGroups: candidates.length,
            reusedLearningCandidateIds: Array.from(new Set(reusedLearningCandidateIds)),
            reusedLearningCandidateCount: new Set(reusedLearningCandidateIds).size,
            childCapabilityIds: requestedChildren,
            sharedApplications: input.sharedApplications ?? [],
            repositoryProfiles,
            agentPreset: input.agentPreset ?? "governed_delivery",
            operatingModel: buildOperatingModel(
              capability as Parameters<typeof buildOperatingModel>[0],
              input.targetWorkflowPattern, generatedAgents, candidates.length, architectureDiagram,
              repositoryProfiles, { childCapabilityIds: requestedChildren, sharedApplications: input.sharedApplications ?? [] },
            ),
          },
        },
      });
      await markPhaseCompleted(run.id, PHASE_KEYS.P1, {
        agentsCreated: generatedAgents.length,
        discoveredSignals: discovered.length,
        candidateRows: candidates.length,
        repositoryProfiles: repositoryProfiles.length,
      });

      // Phases 2 + 3 are stubs. The schema + UI surface exists; the
      // workers themselves land in follow-up commits.
      // Phase 2 is "deferred at bootstrap" — mcp-server builds the AST
      // index lazily at first workflow run, then POSTs back to
      // /world-model/ast-index-built (M61 Wire B P2), which stamps
      // astIndexedAt + astIndexFiles on the WorldModel row. The
      // phaseProgress entry shows skipped here so the wizard UI can
      // render the bootstrap timeline without claiming work that
      // hasn't happened yet.
      await markPhaseSkipped(run.id, PHASE_KEYS.P2, "deferred to first workflow — mcp-server reports back via ast-index-built callback");
      // M61 Wire B P3 — Run the distillation worker inline. It marks
      // its own phaseProgress (started → completed / skipped / failed)
      // so the wizard UI gets the same progress shape regardless of
      // whether the worker found a README, no symbols, or errored.
      await runBootstrapDistillationPhase({ capabilityId: capability.id, runId: run.id });
      await patchPhase(run.id, PHASE_KEYS.DONE, { status: "completed", completedAt: new Date().toISOString() }, { setCurrentPhase: PHASE_KEYS.DONE });
    } catch (err) {
      errors.push((err as Error).message);
      await markPhaseFailed(run.id, PHASE_KEYS.P1, err as Error);
      await prisma.capabilityBootstrapRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED", completedAt: new Date(), currentPhase: PHASE_KEYS.DONE,
          generatedAgentIds: generatedAgents as unknown as Prisma.InputJsonValue,
          warnings, errors,
        },
      });
      // Async path: do NOT rethrow — there's no caller to catch.
    }
  },

  async getBootstrapRun(capabilityId: string, runId: string) {
    const run = await prisma.capabilityBootstrapRun.findUnique({
      where: { id: runId },
      include: {
        candidates: {
          where: { status: { not: "SUPERSEDED" } },
          orderBy: [{ groupKey: "asc" }, { createdAt: "asc" }],
        },
        capability: { include: { bindings: { include: { agentTemplate: true } }, repositories: true, knowledgeSources: true } },
      },
    });
    if (!run || run.capabilityId !== capabilityId) throw new NotFoundError("Capability bootstrap run not found");
    // Reap a stuck async bootstrap when it is polled (crashed/redeployed worker →
    // RUNNING forever with no reaper) so the wizard stops spinning and the
    // operator gets a clear FAILED + retry instead of an infinite spinner.
    if (isBootstrapRunStale(run)) {
      const reapedAt = await reapStaleBootstrapRun(run.id);
      if (reapedAt) {
        run.status = "FAILED";
        run.completedAt = reapedAt;
        (run as { errors: unknown }).errors = [BOOTSTRAP_REAP_ERROR];
      }
    }
    const reusedLearningCandidateIds = jsonStringArray(jsonRecord(run.sourceSummary).reusedLearningCandidateIds);
    if (reusedLearningCandidateIds.length === 0) return run;

    const reusedCandidates = await prisma.capabilityLearningCandidate.findMany({
      where: {
        capabilityId,
        id: { in: reusedLearningCandidateIds },
        status: { not: "SUPERSEDED" },
      },
      orderBy: [{ groupKey: "asc" }, { createdAt: "asc" }],
    });
    if (reusedCandidates.length === 0) return run;

    const candidatesById = new Map<string, typeof run.candidates[number]>();
    for (const candidate of run.candidates) candidatesById.set(candidate.id, candidate);
    for (const candidate of reusedCandidates) candidatesById.set(candidate.id, candidate);
    return {
      ...run,
      candidates: Array.from(candidatesById.values()).sort(compareLearningCandidatesForReview),
    };
  },

  async reviewBootstrapRun(capabilityId: string, runId: string, input: {
    approveGroupKeys: string[]; rejectGroupKeys: string[]; activateAgentTemplateIds: string[];
  }, userId?: string) {
    await requireActiveCapability(capabilityId);
    const run = await this.getBootstrapRun(capabilityId, runId);
    const approve = new Set(input.approveGroupKeys);
    const reject = new Set(input.rejectGroupKeys);
    const conflictingGroups = Array.from(approve).filter(groupKey => reject.has(groupKey));
    if (conflictingGroups.length > 0) {
      throw new ConflictError(
        `Bootstrap learning group(s) cannot be both approved and rejected: ${conflictingGroups.join(", ")}`,
      );
    }
    const approvedCandidates = run.candidates.filter(c => c.status === "PENDING" && approve.has(c.groupKey));
    const rejectedIds = run.candidates.filter(c => c.status === "PENDING" && reject.has(c.groupKey)).map(c => c.id);

    for (const candidate of approvedCandidates) {
      await materializeBootstrapLearningCandidate(capabilityId, candidate, userId);
    }

    if (rejectedIds.length > 0) {
      await prisma.capabilityLearningCandidate.updateMany({
        where: { id: { in: rejectedIds }, status: "PENDING" },
        data: { status: "REJECTED", reviewedBy: userId, reviewedAt: new Date() },
      });
    }

    const generatedAgentSnapshot = Array.isArray(run.generatedAgentIds)
      ? (run.generatedAgentIds as unknown[])
      : [];
    const generatedAgents = generatedAgentSnapshot.filter((agent): agent is Record<string, unknown> =>
      Boolean(agent && typeof agent === "object" && !Array.isArray(agent)),
    );
    const requiredActivationIds = generatedAgents
      .filter(agent => agent.activationRequired === true && typeof agent.id === "string")
      .map(agent => agent.id as string);
    const activateAgentTemplateIds = Array.from(new Set([...input.activateAgentTemplateIds, ...requiredActivationIds]));

    if (activateAgentTemplateIds.length > 0) {
      await prisma.agentTemplate.updateMany({
        where: { capabilityId, id: { in: activateAgentTemplateIds }, status: { not: "ARCHIVED" } },
        data: { status: "ACTIVE" },
      });
      await prisma.agentCapabilityBinding.updateMany({
        where: { capabilityId, agentTemplateId: { in: activateAgentTemplateIds }, status: { not: "ARCHIVED" } },
        data: { status: "ACTIVE" },
      });
    }

    const pending = await prisma.capabilityLearningCandidate.count({ where: { bootstrapRunId: runId, status: "PENDING" } });
    await prisma.capabilityBootstrapRun.update({
      where: { id: runId },
      data: { status: pending === 0 ? "REVIEWED" : "COMPLETED", reviewedAt: pending === 0 ? new Date() : undefined },
    });
    return this.getBootstrapRun(capabilityId, runId);
  },

  async syncCapability(capabilityId: string, input: {
    repositoryIds?: string[]; knowledgeSourceIds?: string[]; localFiles?: InputFile[];
  }, helpers: {
    syncRepository: (capabilityId: string, repoId: string) => Promise<unknown>;
    syncKnowledgeSource: (capabilityId: string, sourceId: string) => Promise<unknown>;
  }) {
    await requireActiveCapability(capabilityId);
    const approved = await prisma.capabilityLearningCandidate.findMany({
      where: { capabilityId, status: "MATERIALIZED" },
      select: { sourceRef: true, sourceType: true },
    });
    if (approved.length === 0) {
      return { repositories: [], knowledgeSources: [], local: null, warnings: ["No approved bootstrap learning exists yet; approve the bootstrap packet before syncing."] };
    }

    const warnings: string[] = [];
    const repositories = [];
    const syncedRepositoryKeys = new Set<string>();
    for (const repoId of input.repositoryIds ?? []) {
      const repo = await prisma.capabilityRepository.findUnique({ where: { id: repoId } });
      if (!repo || repo.capabilityId !== capabilityId) {
        warnings.push(`Repository ${repoId} not found for capability.`);
        continue;
      }
      const repoKey = capabilityRepositorySourceKey({
        capabilityId,
        repoUrl: repo.repoUrl,
        defaultBranch: repo.defaultBranch,
        repositoryType: repo.repositoryType,
      });
      if (repoKey && syncedRepositoryKeys.has(repoKey)) {
        warnings.push(`Repository ${repo.repoName} was skipped because another active repository source has the same URL, branch, and type.`);
        continue;
      }
      if (!isApprovedSource(approved, repo.repoUrl)) {
        warnings.push(`Repository ${repo.repoName} is not approved for runtime learning yet.`);
        continue;
      }
      if (repoKey) syncedRepositoryKeys.add(repoKey);
      repositories.push({ repoId, result: await helpers.syncRepository(capabilityId, repoId) });
    }

    const knowledgeSources = [];
    const syncedKnowledgeSourceKeys = new Set<string>();
    for (const sourceId of input.knowledgeSourceIds ?? []) {
      const source = await prisma.capabilityKnowledgeSource.findUnique({ where: { id: sourceId } });
      if (!source || source.capabilityId !== capabilityId) {
        warnings.push(`Knowledge source ${sourceId} not found for capability.`);
        continue;
      }
      const sourceKey = capabilityKnowledgeSourceKey({
        capabilityId,
        url: source.url,
        artifactType: source.artifactType,
      });
      if (sourceKey && syncedKnowledgeSourceKeys.has(sourceKey)) {
        warnings.push(`Knowledge source ${source.url} was skipped because another active source has the same URL and artifact type.`);
        continue;
      }
      if (!isApprovedSource(approved, source.url)) {
        warnings.push(`Knowledge source ${source.url} is not approved for runtime learning yet.`);
        continue;
      }
      if (sourceKey) syncedKnowledgeSourceKeys.add(sourceKey);
      knowledgeSources.push({ sourceId, result: await helpers.syncKnowledgeSource(capabilityId, sourceId) });
    }

    let local: unknown = null;
    if ((input.localFiles ?? []).length > 0) {
      if (!approved.some(item => item.sourceRef?.includes(LOCAL_BOOTSTRAP_REF) || item.sourceType === "LOCAL_FILE")) {
        warnings.push("Local source is not approved for runtime learning yet.");
      } else {
        const localRepo = await prisma.capabilityRepository.findFirst({
          where: { capabilityId, repositoryType: "LOCAL", status: "ACTIVE" },
          orderBy: { createdAt: "desc" },
        });
        if (!localRepo) warnings.push("No local bootstrap repository record exists.");
        else local = await this.extractRepositorySymbols(capabilityId, localRepo.id, input.localFiles ?? []);
      }
    }

    return { repositories, knowledgeSources, local, warnings };
  },

  async runLearningWorker(capabilityId: string, input: {
    approveGroupKeys?: string[];
    rejectGroupKeys?: string[];
    activateAgentTemplateIds?: string[];
    syncApprovedSources?: boolean;
    refreshRepositoryProfiles?: boolean;
    reembed?: boolean;
    reembedKinds?: ("knowledge" | "memory" | "code")[];
    dryRun?: boolean;
  }, helpers: {
    syncRepository: (capabilityId: string, repoId: string) => Promise<unknown>;
    syncKnowledgeSource: (capabilityId: string, sourceId: string) => Promise<unknown>;
  }, userId?: string) {
    await requireActiveCapability(capabilityId);
    const dryRun = input.dryRun === true;
    const willRefreshRepositoryProfiles = input.refreshRepositoryProfiles !== false;
    const willSyncApprovedSources = input.syncApprovedSources !== false;
    const releaseLearningWorker = !dryRun && (willSyncApprovedSources || willRefreshRepositoryProfiles)
      ? await claimCapabilityLearningWorker(capabilityId, willRefreshRepositoryProfiles ? "grounding" : "sync")
      : null;

    try {
    const warnings: string[] = [];
    const nextActions: string[] = [];
    const before = await learningWorkerSnapshot(capabilityId);

    const latestRun = await prisma.capabilityBootstrapRun.findFirst({
      where: { capabilityId },
      orderBy: { createdAt: "desc" },
      include: { candidates: { orderBy: [{ groupKey: "asc" }, { createdAt: "asc" }] } },
    });

    const approveGroupKeys = input.approveGroupKeys ?? [];
    const rejectGroupKeys = input.rejectGroupKeys ?? [];
    const activateAgentTemplateIds = input.activateAgentTemplateIds ?? [];
    let review: unknown = null;
    if (latestRun && (approveGroupKeys.length > 0 || rejectGroupKeys.length > 0 || activateAgentTemplateIds.length > 0)) {
      if (dryRun) {
        review = {
          dryRun: true,
          bootstrapRunId: latestRun.id,
          approveGroupKeys,
          rejectGroupKeys,
          activateAgentTemplateIds,
        };
      } else {
        review = await this.reviewBootstrapRun(capabilityId, latestRun.id, {
          approveGroupKeys,
          rejectGroupKeys,
          activateAgentTemplateIds,
        }, userId);
      }
    }

    if (latestRun && before.learning.pending > 0 && approveGroupKeys.length === 0 && rejectGroupKeys.length === 0) {
      warnings.push(`${before.learning.pending} bootstrap learning candidate(s) are still pending human review.`);
      nextActions.push("Review pending bootstrap learning groups, then rerun the worker to materialize approved knowledge.");
    }

    if (willRefreshRepositoryProfiles && shouldRecordGroundingAttempt({ dryRun, refreshRepositoryProfiles: input.refreshRepositoryProfiles })) {
      const claim = await recordLearningAttempt(capabilityId, {
        message: "Learning refresh started.",
        diagnostics: { requestedByUserId: userId ?? null },
      });
      if (!claim.claimed) {
        throw new ConflictError(
          `Repository grounding refresh is already running for this capability. Wait for the current refresh to finish, or retry after ${Math.ceil(CAPABILITY_LEARNING_RUN_STALE_MS / 60000)} minutes if the worker crashed.`,
        );
      }
    }

    let sync: unknown = null;
    if (willSyncApprovedSources) {
      const [repositories, knowledgeSources] = await Promise.all([
        prisma.capabilityRepository.findMany({ where: { capabilityId, status: "ACTIVE" }, select: { id: true } }),
        prisma.capabilityKnowledgeSource.findMany({ where: { capabilityId, status: "ACTIVE" }, select: { id: true } }),
      ]);
      if (dryRun) {
        sync = {
          dryRun: true,
          repositoryIds: repositories.map(repo => repo.id),
          knowledgeSourceIds: knowledgeSources.map(source => source.id),
        };
      } else {
        try {
          sync = await this.syncCapability(capabilityId, {
            repositoryIds: repositories.map(repo => repo.id),
            knowledgeSourceIds: knowledgeSources.map(source => source.id),
          }, helpers);
        } catch (err) {
          const message = `Approved source sync failed: ${(err as Error).message}`;
          warnings.push(message);
          sync = { error: message };
        }
      }
    }

    if (sync && typeof sync === "object" && !Array.isArray(sync)) {
      const syncWarnings = (sync as { warnings?: unknown }).warnings;
      if (Array.isArray(syncWarnings)) warnings.push(...syncWarnings.map(String));
    }

    let repositoryProfiles: unknown = null;
    if (willRefreshRepositoryProfiles) {
      if (dryRun) {
        const repositories = await prisma.capabilityRepository.findMany({
          where: { capabilityId, status: "ACTIVE" },
          select: { id: true, repoName: true, repoUrl: true, defaultBranch: true, repositoryType: true },
        });
        repositoryProfiles = {
          dryRun: true,
          repositoryIds: repositories.map(repo => repo.id),
        };
      } else {
        try {
          repositoryProfiles = await refreshRepositoryProfileLearning(capabilityId, userId);
          const profileWarnings = (repositoryProfiles as { warnings?: unknown }).warnings;
          if (Array.isArray(profileWarnings)) warnings.push(...profileWarnings.map(String));
          await recordRepositoryLearningStatus(capabilityId, repositoryProfiles as RepositoryRefreshResult);
        } catch (err) {
          const message = `Repository intelligence refresh failed: ${(err as Error).message}`;
          warnings.push(message);
          repositoryProfiles = { error: message };
          await recordLearningFailure(capabilityId, "REPOSITORY_PROFILE_REFRESH_FAILED", message, {
            requestedByUserId: userId ?? null,
          });
        }
      }
    }

    let reembed: unknown = null;
    if (input.reembed !== false) {
      const kinds = input.reembedKinds ?? ["knowledge", "memory", "code"];
      if (dryRun) reembed = { dryRun: true, kinds };
      else reembed = await this.reembedCapability(capabilityId, { kinds });
    }

    const after = dryRun ? before : await learningWorkerSnapshot(capabilityId);
    if (after.learning.materialized === 0) {
      nextActions.push("Approve at least one learning group so repo/doc sync can promote grounded knowledge.");
    }
    if (after.knowledge.active === 0) {
      nextActions.push("Materialize bootstrap candidates or upload knowledge artifacts before running governed workflows.");
    }
    if (after.repositories.active > 0 && after.codeSymbols.total === 0) {
      nextActions.push("Use MCP local AST indexing for private code, or enable POLL_REPOSITORIES_ENABLED and EXTRACTOR_MODE for central code-symbol mirroring.");
    }

    return {
      capabilityId,
      ranAt: new Date().toISOString(),
      dryRun,
      latestBootstrapRunId: latestRun?.id ?? null,
      before,
      review,
      sync,
      repositoryProfiles,
      reembed,
      after,
      warnings: Array.from(new Set(warnings)),
      nextActions: Array.from(new Set(nextActions)),
      capsuleInvalidation: "No direct purge required. Prompt Composer task signatures include capability content timestamps/counts, so newly materialized artifacts and memory make old capsules unreachable.",
    };
    } finally {
      try {
        await releaseLearningWorker?.();
      } catch {
        // Lease expiry is the safety net; do not mask the worker result.
      }
    }
  },

  async list(options: { includeArchived?: boolean } = {}) {
    const rows = await prisma.capability.findMany({
      where: options.includeArchived ? undefined : { status: { not: "ARCHIVED" } },
      orderBy: { createdAt: "desc" },
      include: {
        children: { where: { status: { not: "ARCHIVED" } } },
        repositories: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } },
      },
    });
    return collapseCapabilityListDuplicates(rows);
  },

  async get(id: string) {
    const cap = await prisma.capability.findUnique({
      where: { id },
      include: {
        children: { where: { status: { not: "ARCHIVED" } } },
        parent: true,
        repositories: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } },
        learningStatus: true,
        worldModel: true,
        knowledgeArtifacts: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" } },
        bindings: {
          where: {
            status: { not: "ARCHIVED" },
            agentTemplate: { status: { not: "ARCHIVED" } },
          },
          include: { agentTemplate: true },
        },
        bootstrapRuns: { orderBy: { createdAt: "desc" }, take: 5 },
        learningCandidates: { where: { status: { not: "SUPERSEDED" } }, orderBy: { createdAt: "desc" }, take: 100 },
      },
    });
    if (!cap) throw new NotFoundError("Capability not found");
    return cap;
  },

  // List a capability's linked repositories regardless of status (ACTIVE, plus
  // any still bootstrapping/failed). Unlike get()/list()/architectureDiagram —
  // which all filter to status:"ACTIVE" — this returns every linked repo so
  // callers that only need the repo URL (branch picker, repo resolution) can
  // find one even before indexing completes. ACTIVE repos sort first.
  async listRepositories(id: string) {
    const cap = await prisma.capability.findUnique({
      where: { id },
      select: {
        id: true,
        repositories: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true, repoName: true, repoUrl: true,
            defaultBranch: true, repositoryType: true, status: true,
          },
        },
      },
    });
    if (!cap) throw new NotFoundError("Capability not found");
    const repositories = [...cap.repositories].sort(
      (a, b) => (String(a.status) === "ACTIVE" ? 0 : 1) - (String(b.status) === "ACTIVE" ? 0 : 1),
    );
    return { capabilityId: cap.id, repositories };
  },

  async groundingStatus(id: string) {
    return buildCapabilityGroundingStatus(id);
  },

  async readiness(id: string) {
    const cap = await prisma.capability.findUnique({
      where: { id },
      include: {
        repositories: true,
        knowledgeArtifacts: true,
        knowledgeSources: true,
        bindings: { include: { agentTemplate: true } },
        bootstrapRuns: { orderBy: { createdAt: "desc" }, take: 3 },
        learningCandidates: { where: { status: { not: "SUPERSEDED" } }, orderBy: { createdAt: "desc" }, take: 100 },
      },
    });
    if (!cap) throw new NotFoundError("Capability not found");

    const activeBindings = cap.bindings.filter(binding =>
      String(binding.status) === "ACTIVE" && String(binding.agentTemplate?.status ?? "") === "ACTIVE",
    );
    const allBindings = cap.bindings.filter(binding => String(binding.status) !== "ARCHIVED");
    const activeRepos = cap.repositories.filter(repo => String(repo.status) === "ACTIVE");
    const activeKnowledge = cap.knowledgeArtifacts.filter(artifact => String(artifact.status) === "ACTIVE");
    const activeSources = cap.knowledgeSources.filter(source => String(source.status) === "ACTIVE");
    const latestBootstrap = cap.bootstrapRuns[0];
    const materializedLearning = cap.learningCandidates.filter(candidate => candidate.status === "MATERIALIZED");
    const pendingLearning = cap.learningCandidates.filter(candidate => candidate.status === "PENDING");
    const codeSymbols = await prisma.capabilityCodeSymbol.count({ where: { capabilityId: id } });
    const lockedRoles = new Set(
      allBindings
        .filter(binding => Boolean(binding.agentTemplate?.lockedReason))
        .map(binding => String(binding.roleInCapability ?? binding.agentTemplate?.roleType ?? "").toUpperCase()),
    );
    const activeRoles = new Set(activeBindings.map(binding =>
      String(binding.roleInCapability ?? binding.agentTemplate?.roleType ?? "").toUpperCase(),
    ));

    const category = (
      key: string,
      label: string,
      maxScore: number,
      checks: ReadinessCheck[],
      summary: string,
      forcedStatus?: ReadinessStatus,
    ): ReadinessCategory => {
      const passed = checks.filter(check => check.ok).length;
      const score = checks.length === 0 ? 0 : Math.round((passed / checks.length) * maxScore);
      const hasBlocker = checks.some(check => !check.ok && check.severity === "blocker");
      const hasWarning = checks.some(check => !check.ok && check.severity === "warning");
      const percent = maxScore > 0 ? score / maxScore : 0;
      const status: ReadinessStatus = forcedStatus ?? (hasBlocker ? "NOT_READY" : hasWarning || percent < 0.85 ? "NEEDS_ATTENTION" : "READY");
      return { key, label, score, maxScore, status, summary, checks };
    };

    const categories = [
      category("identity_governance", "Identity & governance", 20, [
        {
          key: "active",
          label: "Capability is active",
          ok: String(cap.status) === "ACTIVE",
          detail: `Current status is ${String(cap.status)}.`,
          severity: "blocker",
        },
        {
          key: "owner_team",
          label: "Owner team is set",
          ok: Boolean(cap.ownerTeamId),
          detail: cap.ownerTeamId ? `Owner team ${cap.ownerTeamId}.` : "No IAM owner team is recorded.",
          severity: "blocker",
        },
        {
          key: "business_unit",
          label: "Business unit is set",
          ok: Boolean(cap.businessUnitId),
          detail: cap.businessUnitId ? `Business unit ${cap.businessUnitId}.` : "No business unit is recorded.",
          severity: "warning",
        },
        {
          key: "criticality",
          label: "Criticality is set",
          ok: Boolean(cap.criticality),
          detail: cap.criticality ? `Criticality ${cap.criticality}.` : "No criticality is recorded.",
          severity: "warning",
        },
      ], "Capability identity has enough metadata for ownership and governance routing."),
      category("agent_team", "Agent team", 25, [
        {
          key: "active_agents",
          label: "Capability agents are active",
          ok: activeBindings.length >= 3,
          detail: `${activeBindings.length} active agent binding(s).`,
          severity: "blocker",
        },
        {
          key: "governance_gate",
          label: "Locked governance gate exists",
          ok: lockedRoles.has("GOVERNANCE"),
          detail: lockedRoles.has("GOVERNANCE") ? "Governance agent is locked." : "No locked Governance agent binding found.",
          severity: "blocker",
        },
        {
          key: "verifier_gate",
          label: "Locked verifier gate exists",
          ok: lockedRoles.has("VERIFIER") || lockedRoles.has("QA"),
          detail: lockedRoles.has("VERIFIER") || lockedRoles.has("QA") ? "Verifier/QA gate is locked." : "No locked Verifier/QA gate found.",
          severity: "warning",
        },
        {
          key: "prompt_bindings",
          label: "Prompt bindings exist",
          ok: activeBindings.some(binding => Boolean(binding.promptProfileId ?? binding.agentTemplate?.basePromptProfileId)),
          detail: `${activeBindings.filter(binding => Boolean(binding.promptProfileId ?? binding.agentTemplate?.basePromptProfileId)).length} agent(s) have prompt profile references.`,
          severity: "warning",
        },
        {
          key: "core_roles",
          label: "Core delivery roles exist",
          ok: ["PRODUCT_OWNER", "ARCHITECT", "DEVELOPER"].every(role => activeRoles.has(role)),
          detail: `Active roles: ${Array.from(activeRoles).sort().join(", ") || "none"}.`,
          severity: "warning",
        },
      ], "Activated agents, prompt bindings, and locked gates are ready for governed delivery."),
      category("knowledge_code", "Knowledge & code grounding", 20, [
        {
          key: "repository",
          label: "Repository/source configured",
          ok: activeRepos.length > 0 || activeSources.length > 0,
          detail: `${activeRepos.length} active repo(s), ${activeSources.length} active knowledge source(s).`,
          severity: "warning",
        },
        {
          key: "knowledge_artifacts",
          label: "Knowledge artifacts materialized",
          ok: activeKnowledge.length > 0,
          detail: `${activeKnowledge.length} active knowledge artifact(s).`,
          severity: "warning",
        },
        {
          key: "learning_review",
          label: "Learning review is not stuck",
          ok: pendingLearning.length === 0 || materializedLearning.length > 0,
          detail: `${pendingLearning.length} pending learning candidate(s), ${materializedLearning.length} materialized.`,
          severity: "warning",
        },
        {
          key: "code_symbols",
          label: "Code symbols or MCP AST available",
          ok: codeSymbols > 0 || activeRepos.length > 0,
          detail: codeSymbols > 0 ? `${codeSymbols} central code symbol(s).` : "Central symbols absent; MCP local AST can supply private code context.",
          severity: "info",
        },
      ], "Knowledge, source, and learning signals exist for grounded context."),
      category("workflow_readiness", "Workflow readiness", 20, [
        {
          key: "bootstrap_completed",
          label: "Bootstrap produced an operating model",
          ok: Boolean(latestBootstrap && ["COMPLETED", "REVIEWED"].includes(latestBootstrap.status)),
          detail: latestBootstrap ? `Latest bootstrap status ${latestBootstrap.status}.` : "No bootstrap run found.",
          severity: "warning",
        },
        {
          key: "bootstrap_reviewed",
          label: "Bootstrap review completed",
          ok: Boolean(latestBootstrap?.reviewedAt),
          detail: latestBootstrap?.reviewedAt ? `Reviewed ${latestBootstrap.reviewedAt.toISOString()}.` : "Bootstrap packet has not been fully reviewed.",
          severity: "warning",
        },
      ], "Agent-runtime can confirm bootstrap intent; Workgraph confirms actual workflows and budgets in Operations."),
      category("runtime_readiness", "Runtime readiness", 15, [
        {
          key: "mcp_endpoint",
          label: "MCP invoke endpoint configured",
          ok: Boolean(process.env.MCP_INVOKE_URL),
          detail: process.env.MCP_INVOKE_URL ? `MCP invoke URL configured.` : "MCP invoke URL is not set in agent-runtime.",
          severity: "info",
        },
        {
          // Embeddings must be routed through MCP; provider credential
          // presence is enforced behind the MCP/gateway boundary.
          key: "embedding_provider",
          label: "MCP configured for embeddings",
          ok: Boolean(process.env.MCP_SERVER_URL || process.env.MCP_INVOKE_URL),
          detail: `Embedding dim target is ${REQUIRED_EMBEDDING_DIM}; routed via MCP.`,
          severity: "info",
        },
      ], "Runtime endpoint checks are local configuration hints; full health is shown in Operations.", "UNKNOWN"),
    ];

    const blockers = categories.flatMap(cat => cat.checks
      .filter(check => !check.ok && check.severity === "blocker")
      .map(check => ({ category: cat.key, key: check.key, message: check.detail })));
    const warnings = categories.flatMap(cat => cat.checks
      .filter(check => !check.ok && check.severity !== "blocker")
      .map(check => ({ category: cat.key, key: check.key, message: check.detail, severity: check.severity })));
    const maxScore = categories.reduce((sum, cat) => sum + cat.maxScore, 0);
    const score = Math.round(categories.reduce((sum, cat) => sum + cat.score, 0) / Math.max(maxScore, 1) * 100);
    const status: ReadinessStatus = blockers.length > 0
      ? "NOT_READY"
      : score >= 85 && warnings.length === 0
          ? "READY"
          : score >= 60
            ? "NEEDS_ATTENTION"
            : "NOT_READY";
    const recommendedActions = [
      ...blockers.map(blocker => blocker.message),
      ...warnings.slice(0, 5).map(warning => warning.message),
    ];

    return {
      capabilityId: cap.id,
      generatedAt: new Date().toISOString(),
      score,
      status,
      categories,
      blockers,
      warnings,
      recommendedActions,
      facts: {
        activeAgents: activeBindings.length,
        repositories: activeRepos.length,
        knowledgeSources: activeSources.length,
        knowledgeArtifacts: activeKnowledge.length,
        pendingLearningCandidates: pendingLearning.length,
        materializedLearningCandidates: materializedLearning.length,
        codeSymbols,
        latestBootstrapStatus: latestBootstrap?.status ?? null,
      },
    };
  },

  async architectureDiagram(id: string) {
    const cap = await prisma.capability.findUnique({
      where: { id },
      include: {
        repositories: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } },
        knowledgeSources: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } },
        knowledgeArtifacts: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 20 },
        bindings: { where: { status: "ACTIVE" }, include: { agentTemplate: true }, orderBy: { createdAt: "asc" } },
        bootstrapRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!cap) throw new NotFoundError("Capability not found");

    const bootstrap = cap.bootstrapRuns[0];
    const summary = jsonRecord(bootstrap?.sourceSummary);
    const operatingModel = jsonRecord(summary.operatingModel);
    const stored = normalizeArchitectureDiagram(operatingModel.architectureDiagram);
    const storedHasApplicationFacts = Boolean(stored?.codeGraphMermaid)
      || Boolean(stored?.repositoryProfiles?.length)
      || Boolean(stored?.layers.some(layer => /platform|api|domain|stack|contract|repository/i.test(`${layer.key} ${layer.label}`)));
    if (stored && storedHasApplicationFacts) {
      return {
        capabilityId: cap.id,
        generatedAt: (bootstrap.completedAt ?? bootstrap.updatedAt ?? bootstrap.createdAt).toISOString(),
        source: "bootstrap",
        ...stored,
      };
    }

    const input: BootstrapInput = {
      name: cap.name,
      appId: cap.appId ?? undefined,
      parentCapabilityId: cap.parentCapabilityId ?? undefined,
      capabilityType: cap.capabilityType ?? undefined,
      businessUnitId: cap.businessUnitId ?? undefined,
      ownerTeamId: cap.ownerTeamId ?? undefined,
      criticality: cap.criticality ?? undefined,
      description: cap.description ?? undefined,
      repositories: cap.repositories.map(repo => ({
        repoName: repo.repoName,
        repoUrl: repo.repoUrl,
        defaultBranch: repo.defaultBranch ?? undefined,
        repositoryType: repo.repositoryType ?? undefined,
      })),
      documentLinks: cap.knowledgeSources.map(source => ({
        url: source.url,
        artifactType: source.artifactType,
        title: source.title ?? undefined,
        pollIntervalSec: source.pollIntervalSec ?? undefined,
      })),
    };
    const generatedAgents = cap.bindings.map(binding => ({
      label: binding.agentTemplate?.name ?? binding.bindingName,
      roleType: String(binding.roleInCapability ?? binding.agentTemplate?.roleType ?? "AGENT"),
      locked: Boolean(binding.agentTemplate?.lockedReason),
      learnsFromGit: true,
    }));
    const docs: DiscoveryDoc[] = cap.knowledgeSources.map(source => ({
      title: source.title ?? source.url,
      content: source.url,
      sourceType: "DOCUMENT_LINK",
      sourceRef: source.url,
    })).concat(cap.knowledgeArtifacts.map(artifact => ({
      title: artifact.title,
      content: artifact.content,
      sourceType: "LOCAL_FILE",
      sourceRef: artifact.sourceRef ?? `knowledge-artifact:${artifact.id}`,
    })));
    const diagram = buildCapabilityArchitectureDiagram(cap, input, generatedAgents, docs, stored?.repositoryProfiles ?? []);
    return {
      capabilityId: cap.id,
      generatedAt: new Date().toISOString(),
      source: stored ? "live_enriched_from_bootstrap" : "live",
      ...diagram,
    };
  },

  async update(id: string, input: {
    name?: string;
    appId?: string | null;
    parentCapabilityId?: string | null;
    capabilityType?: string | null;
    businessUnitId?: string | null;
    ownerTeamId?: string | null;
    criticality?: string | null;
    description?: string | null;
  }, authHeader?: string) {
    const existing = await prisma.capability.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Capability not found");
    assertCapabilityNotArchived(existing);

    const data: Prisma.CapabilityUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.appId !== undefined) data.appId = input.appId;
    if (input.parentCapabilityId !== undefined) {
      data.parent = input.parentCapabilityId
        ? { connect: { id: input.parentCapabilityId } }
        : { disconnect: true };
    }
    if (input.capabilityType !== undefined) data.capabilityType = input.capabilityType;
    if (input.businessUnitId !== undefined) data.businessUnitId = input.businessUnitId;
    if (input.ownerTeamId !== undefined) data.ownerTeamId = input.ownerTeamId;
    if (input.criticality !== undefined) data.criticality = input.criticality;
    if (input.description !== undefined) data.description = input.description;

    const identityChanged = input.name !== undefined || input.appId !== undefined || input.capabilityType !== undefined;
    const nextIdentity = {
      name: input.name ?? existing.name,
      appId: input.appId !== undefined ? input.appId : existing.appId,
      capabilityType: input.capabilityType !== undefined ? input.capabilityType : existing.capabilityType,
    };
    const updated = identityChanged
      ? await prisma.$transaction(async (tx) => {
          await lockCapabilityNaturalKey(tx, nextIdentity);
          await assertNoActiveCapabilityDuplicate(tx, nextIdentity, id);
          return tx.capability.update({ where: { id }, data });
        }).catch(err => rethrowCapabilityIdentityConflict(err, nextIdentity, id))
      : await prisma.capability.update({ where: { id }, data });
    const warning = await syncIamCapabilityReference(updated, { authHeader });
    if (warning) console.warn(`[capability] ${warning}`);
    return this.get(id);
  },

  async archive(id: string, userId?: string, authHeader?: string) {
    const existing = await prisma.capability.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Capability not found");

    const result = await prisma.$transaction(async (tx) => {
      const [scopedTemplates, scopedBindings] = await Promise.all([
        tx.agentTemplate.findMany({ where: { capabilityId: id }, select: { id: true } }),
        tx.agentCapabilityBinding.findMany({ where: { capabilityId: id }, select: { id: true } }),
      ]);
      const scopedTemplateIds = scopedTemplates.map((template) => template.id);
      const scopedBindingIds = scopedBindings.map((binding) => binding.id);

      const archived = await tx.capability.update({
        where: { id },
        data: { status: "ARCHIVED" },
      });

      await tx.agentCapabilityBinding.updateMany({
        where: { capabilityId: id, status: { not: "ARCHIVED" } },
        data: { status: "INACTIVE" },
      });
      await tx.agentTemplate.updateMany({
        where: { capabilityId: id, status: { not: "ARCHIVED" } },
        data: { status: "ARCHIVED" },
      });
      await tx.capabilityRepository.updateMany({
        where: { capabilityId: id, status: { not: "ARCHIVED" } },
        data: { status: "ARCHIVED", pollIntervalSec: null },
      });
      await tx.capabilityKnowledgeSource.updateMany({
        where: { capabilityId: id, status: { not: "ARCHIVED" } },
        data: { status: "ARCHIVED", pollIntervalSec: null },
      });
      await tx.capabilityKnowledgeArtifact.updateMany({
        where: { capabilityId: id, status: "ACTIVE" },
        data: { status: "ARCHIVED" },
      });
      await tx.capabilityLearningCandidate.updateMany({
        where: { capabilityId: id, status: "PENDING" },
        data: { status: "REJECTED", reviewedBy: userId, reviewedAt: new Date() },
      });
      const toolGrantScopes: Prisma.ToolGrantWhereInput[] = [
        { grantScopeType: "CAPABILITY", grantScopeId: id },
      ];
      const toolPolicyScopes: Prisma.ToolPolicyWhereInput[] = [
        { scopeType: "CAPABILITY", scopeId: id },
      ];
      if (scopedTemplateIds.length > 0) {
        toolGrantScopes.push({ grantScopeType: "AGENT_TEMPLATE", grantScopeId: { in: scopedTemplateIds } });
        toolPolicyScopes.push({ scopeType: "AGENT_TEMPLATE", scopeId: { in: scopedTemplateIds } });
      }
      if (scopedBindingIds.length > 0) {
        toolGrantScopes.push({ grantScopeType: "AGENT_BINDING", grantScopeId: { in: scopedBindingIds } });
        toolPolicyScopes.push({ scopeType: "AGENT_BINDING", scopeId: { in: scopedBindingIds } });
      }
      await tx.toolGrant.updateMany({
        where: { status: { not: "ARCHIVED" }, OR: toolGrantScopes },
        data: { status: "ARCHIVED" },
      });
      await tx.toolPolicy.updateMany({
        where: { status: { not: "ARCHIVED" }, OR: toolPolicyScopes },
        data: { status: "ARCHIVED" },
      });
      await tx.capabilityLearningWorkerLock.deleteMany({
        where: { capabilityId: id },
      });
      await tx.capabilityLearningStatus.upsert({
        where: { capabilityId: id },
        create: {
          capabilityId: id,
          status: "ARCHIVED",
          message: learningMessageForStatus("ARCHIVED"),
          lastAttemptAt: new Date(),
          diagnostics: { archivedBy: userId ?? null, archiveCancelledLearningWorker: true },
        },
        update: {
          status: "ARCHIVED",
          message: learningMessageForStatus("ARCHIVED"),
          lastAttemptAt: new Date(),
          lastFailureCode: null,
          lastFailureMessage: null,
          diagnostics: { archivedBy: userId ?? null, archiveCancelledLearningWorker: true },
        },
      });

      return {
        capability: archived,
        archived: true,
      };
    });
    const warning = await syncIamCapabilityReference(result.capability, { authHeader });
    if (warning) console.warn(`[capability] ${warning}`);
    return result;
  },

  async attachRepository(capabilityId: string, input: {
    repoName: string; repoUrl: string; defaultBranch: string; repositoryType: string;
  }) {
    await requireActiveCapability(capabilityId);
    return persistCapabilityRepositorySource(capabilityId, input);
  },

  async deleteRepository(capabilityId: string, repoId: string) {
    await requireActiveCapability(capabilityId);
    return prisma.$transaction(async (tx) => {
      await assertActiveCapabilityForWrite(tx, capabilityId);
      const updated = await tx.capabilityRepository.updateMany({
        where: { id: repoId, capabilityId, status: "ACTIVE" },
        data: { status: "ARCHIVED", pollIntervalSec: null },
      });
      if (updated.count === 0) throw new NotFoundError("Repository not found");
      return tx.capabilityRepository.findUniqueOrThrow({ where: { id: repoId } });
    });
  },

  async bindAgent(capabilityId: string, input: {
    agentTemplateId: string; bindingName: string;
    roleInCapability?: string; promptProfileId?: string;
    toolPolicyId?: string; memoryScopePolicyId?: string;
  }, userId?: string) {
    await requireActiveCapability(capabilityId);
    const template = await prisma.agentTemplate.findUnique({ where: { id: input.agentTemplateId } });
    if (!template) throw new NotFoundError("Agent template not found");
    if (template.status !== "ACTIVE") {
      throw new ConflictError(`Agent template "${template.name}" is ${template.status} and cannot be bound as an active capability agent.`);
    }
    if (template.capabilityId && template.capabilityId !== capabilityId) {
      throw new ForbiddenError("Cannot bind an agent template owned by another capability.");
    }
    return persistAgentCapabilityBinding({
      ...input,
      roleInCapability: input.roleInCapability ?? template.roleType,
      capabilityId,
      createdBy: userId,
      status: "ACTIVE",
    });
  },

  async listBindings(capabilityId: string) {
    return prisma.agentCapabilityBinding.findMany({
      where: {
        capabilityId,
        status: { not: "ARCHIVED" },
        agentTemplate: { status: { not: "ARCHIVED" } },
      },
      include: { agentTemplate: true },
      orderBy: { createdAt: "desc" },
    });
  },

  async deleteBinding(capabilityId: string, bindingId: string) {
    await requireActiveCapability(capabilityId);
    return prisma.$transaction(async (tx) => {
      await assertActiveCapabilityForWrite(tx, capabilityId);
      const updated = await tx.agentCapabilityBinding.updateMany({
        where: { id: bindingId, capabilityId, status: { not: "ARCHIVED" } },
        data: { status: "ARCHIVED" },
      });
      if (updated.count === 0) throw new NotFoundError("Agent binding not found");
      return tx.agentCapabilityBinding.findUniqueOrThrow({ where: { id: bindingId }, include: { agentTemplate: true } });
    });
  },

  async addKnowledge(capabilityId: string, input: {
    artifactType: string; title: string; content: string;
    sourceType?: string; sourceRef?: string; confidence?: number;
  }) {
    await requireActiveCapability(capabilityId);
    const { artifact, contentHash } = await persistKnowledgeArtifact(capabilityId, input);
    await ensureKnowledgeEmbedding({
      artifactId: artifact.id,
      title: input.title,
      content: input.content,
      contentHash,
    });
    return artifact;
  },

  async listKnowledge(capabilityId: string, input: { includeArchived?: boolean } = {}) {
    return prisma.capabilityKnowledgeArtifact.findMany({
      where: input.includeArchived ? { capabilityId } : { capabilityId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
  },

  async deleteKnowledgeArtifact(capabilityId: string, artifactId: string) {
    await requireActiveCapability(capabilityId);
    return prisma.$transaction(async (tx) => {
      await assertActiveCapabilityForWrite(tx, capabilityId);
      const updated = await tx.capabilityKnowledgeArtifact.updateMany({
        where: { id: artifactId, capabilityId, status: "ACTIVE" },
        data: { status: "ARCHIVED" },
      });
      if (updated.count === 0) throw new NotFoundError("Knowledge artifact not found");
      return tx.capabilityKnowledgeArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    });
  },

  // M14 — repository symbol extraction. Idempotent on `(repositoryId,
  // symbolHash)` so re-running an extract over the same files won't create
  // duplicates. Embeds each new symbol via the configured provider; failures
  // don't abort the whole run — the symbol row still lands so a follow-up
  // can re-embed.
  async extractRepositorySymbols(capabilityId: string, repositoryId: string, files: InputFile[]) {
    await requireActiveCapability(capabilityId);
    const repo = await prisma.capabilityRepository.findUnique({ where: { id: repositoryId } });
    if (!repo || repo.capabilityId !== capabilityId) {
      throw new NotFoundError("Repository not found for this capability");
    }
    // M25.7 #4 — CapabilityCodeSymbol / CapabilityCodeEmbedding are
    // superseded by mcp-server's local AST index (lives wherever
    // mcp-server runs — laptop, VPC, dev box). EXTRACTOR_MODE defaults
    // to `off`; when set, extractSymbols() short-circuits to [] and we
    // return early without touching the symbol tables. This keeps
    // existing rows queryable (read-only) without churning new ones.
    await assertCodeExtractionApproved(capabilityId, repo);
    const symbols = await extractSymbols(files);
    if (symbols.length === 0) {
      // Either EXTRACTOR_MODE=off OR the files genuinely produced no
      // symbols. Either way there's nothing to persist; short-circuit
      // before allocating the embedder + maps.
      return {
        inserted: 0,
        skippedDuplicate: 0,
        embeddingErrors: 0,
        llmSummaries: 0,
        parentLinked: 0,
        scannedFiles: files.length,
        extractorMode: process.env.EXTRACTOR_MODE ?? "off",
      };
    }
    const embedder = getEmbeddingProvider();

    // Index files by path so we can pull a snippet for the LLM summariser.
    const fileByPath = new Map(files.map((f) => [f.path, f.content]));

    let inserted = 0;
    let skippedDuplicate = 0;
    let embeddingErrors = 0;
    let llmSummaries = 0;
    let parentLinked = 0;

    // M16 — track each class row by (filePath, symbolName) so methods landing
    // later in the same file can link via parentSymbolId. Pre-load existing
    // class rows for this repo so re-extracts also link correctly.
    const classByKey = new Map<string, string>();
    {
      const existingClasses = await prisma.capabilityCodeSymbol.findMany({
        where: { repositoryId, symbolType: "class" },
        select: { id: true, filePath: true, symbolName: true },
      });
      for (const c of existingClasses) {
        if (c.symbolName) classByKey.set(`${c.filePath}::${c.symbolName}`, c.id);
      }
    }

    for (const s of symbols) {
      const existing = await prisma.capabilityCodeSymbol.findFirst({
        where: { repositoryId, symbolHash: s.symbolHash },
        select: { id: true },
      });
      if (existing) {
        // Symbol already exists. Skip the row write but re-embed if no
        // pgvector embedding lives for it yet — common after migrating M14
        // rows where vectorId was JSON text and `embedding` is null. Prisma
        // can't `select` an Unsupported() column, so count via raw SQL.
        try {
          await ensureCodeSymbolEmbedding({
            symbolId: existing.id,
            symbolName: s.symbolName,
            summary: s.summary ?? null,
            embedder,
          });
        } catch (err) {
          embeddingErrors += 1;
          // eslint-disable-next-line no-console
          console.warn(`[symbol-extractor] re-embed failed for ${s.filePath}:${s.symbolName}: ${(err as Error).message}`);
        }
        skippedDuplicate += 1;
        continue;
      }

      // M15 — keep per-symbol LLM calls opt-in. By default we use the
      // extractor/docstring signal plus deterministic summaries so a large
      // repo sync does not create one LLM call per undocumented symbol.
      let summary = s.summary ?? null;
      if (!summary && ENABLE_LLM_SYMBOL_SUMMARIES) {
        const content = fileByPath.get(s.filePath);
        if (content) {
          const generated = await summariseSymbol({
            symbolName: s.symbolName,
            symbolType: s.symbolType,
            language: s.language,
            filePath: s.filePath,
            fileSnippet: fileSnippetFor(content, s.startLine),
          });
          if (generated) {
            summary = generated;
            llmSummaries += 1;
          }
        }
      }
      if (!summary) summary = deterministicSymbolSummary(s);

      // Resolve parentSymbolId for methods to the enclosing class row, when
      // the class was extracted in this batch or persisted from a prior run.
      let parentSymbolId: string | undefined;
      if (s.symbolType === "method" && s.parentClassName) {
        const key = `${s.filePath}::${s.parentClassName}`;
        parentSymbolId = classByKey.get(key);
        if (parentSymbolId) parentLinked += 1;
      }

      const { symbol: row, created } = await persistCapabilityCodeSymbol({
        capabilityId,
        repositoryId,
        filePath: s.filePath,
        language: s.language,
        symbolName: s.symbolName,
        symbolType: s.symbolType,
        parentSymbolId,
        startLine: s.startLine,
        summary,
        symbolHash: s.symbolHash,
      });
      if (!created) {
        try {
          await ensureCodeSymbolEmbedding({
            symbolId: row.id,
            symbolName: s.symbolName,
            summary,
            embedder,
          });
        } catch (err) {
          embeddingErrors += 1;
          // eslint-disable-next-line no-console
          console.warn(`[symbol-extractor] race re-embed failed for ${s.filePath}:${s.symbolName}: ${(err as Error).message}`);
        }
        skippedDuplicate += 1;
        continue;
      }
      if (s.symbolType === "class") {
        classByKey.set(`${s.filePath}::${s.symbolName}`, row.id);
      }
      inserted += 1;

      try {
        await ensureCodeSymbolEmbedding({
          symbolId: row.id,
          symbolName: s.symbolName,
          summary,
          embedder,
        });
      } catch (err) {
        embeddingErrors += 1;
        // eslint-disable-next-line no-console
        console.warn(`[symbol-extractor] embedding failed for ${s.filePath}:${s.symbolName}: ${(err as Error).message}`);
      }
    }

    return {
      filesProcessed: files.length,
      symbolsScanned: symbols.length,
      inserted,
      skippedDuplicate,
      embeddingErrors,
      llmSummaries,
      parentLinked,
      provider: embedder.name,
      providerModel: embedder.defaultModel,
      requiredDim: REQUIRED_EMBEDDING_DIM,
    };
  },

  // M17 — polling config + knowledge sources.
  async updateRepositoryPoll(capabilityId: string, repoId: string, input: {
    pollIntervalSec?: number | null; defaultBranch?: string;
  }) {
    await requireActiveCapability(capabilityId);
    const repo = await prisma.capabilityRepository.findUnique({ where: { id: repoId } });
    if (!repo || repo.capabilityId !== capabilityId) throw new NotFoundError("Repository not found");
    if (repo.status !== "ACTIVE") throw new ConflictError(`Repository is ${repo.status} and cannot be updated.`);
    const identityChanged = input.defaultBranch !== undefined;
    if (!identityChanged) {
      return prisma.$transaction(async (tx) => {
        await assertActiveCapabilityForWrite(tx, capabilityId);
        const updated = await tx.capabilityRepository.updateMany({
          where: { id: repoId, capabilityId, status: "ACTIVE" },
          data: {
            pollIntervalSec: input.pollIntervalSec === undefined ? undefined : input.pollIntervalSec,
          },
        });
        if (updated.count === 0) throw new NotFoundError("Repository not found");
        return tx.capabilityRepository.findUniqueOrThrow({ where: { id: repoId } });
      });
    }
    const nextIdentity = {
      capabilityId,
      repoUrl: repo.repoUrl,
      defaultBranch: normalizedRepositoryBranch(input.defaultBranch),
      repositoryType: repo.repositoryType,
    };
    const sourceKey = capabilityRepositorySourceKey(nextIdentity);
    if (!sourceKey) throw new Error("Repository source identity is incomplete.");
    return prisma.$transaction(async (tx) => {
      await assertActiveCapabilityForWrite(tx, capabilityId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sourceKey}))`;
      await assertNoActiveRepositorySourceDuplicate(tx, nextIdentity, repoId);
      const updated = await tx.capabilityRepository.updateMany({
        where: { id: repoId, capabilityId, status: "ACTIVE" },
        data: {
          pollIntervalSec: input.pollIntervalSec === undefined ? undefined : input.pollIntervalSec,
          defaultBranch: nextIdentity.defaultBranch,
        },
      });
      if (updated.count === 0) throw new NotFoundError("Repository not found");
      return tx.capabilityRepository.findUniqueOrThrow({ where: { id: repoId } });
    });
  },

  async listKnowledgeSources(capabilityId: string) {
    return prisma.capabilityKnowledgeSource.findMany({
      where: { capabilityId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });
  },

  async addKnowledgeSource(capabilityId: string, input: {
    url: string; artifactType?: string; title?: string; pollIntervalSec?: number | null;
  }) {
    await requireActiveCapability(capabilityId);
    return persistCapabilityKnowledgeSource(capabilityId, {
      ...input,
      pollIntervalSec: input.pollIntervalSec ?? 600,
    });
  },

  async updateKnowledgeSource(capabilityId: string, sourceId: string, input: {
    url?: string; artifactType?: string; title?: string; pollIntervalSec?: number | null;
  }) {
    await requireActiveCapability(capabilityId);
    const src = await prisma.capabilityKnowledgeSource.findUnique({ where: { id: sourceId } });
    if (!src || src.capabilityId !== capabilityId) throw new NotFoundError("Knowledge source not found");
    if (src.status !== "ACTIVE") throw new ConflictError(`Knowledge source is ${src.status} and cannot be updated.`);
    const identityChanged = input.url !== undefined || input.artifactType !== undefined;
    if (!identityChanged) {
      return prisma.$transaction(async (tx) => {
        await assertActiveCapabilityForWrite(tx, capabilityId);
        const updated = await tx.capabilityKnowledgeSource.updateMany({
          where: { id: sourceId, capabilityId, status: "ACTIVE" },
          data: {
            title: input.title ?? undefined,
            pollIntervalSec: input.pollIntervalSec === undefined ? undefined : input.pollIntervalSec,
          },
        });
        if (updated.count === 0) throw new NotFoundError("Knowledge source not found");
        return tx.capabilityKnowledgeSource.findUniqueOrThrow({ where: { id: sourceId } });
      });
    }
    const nextIdentity = {
      capabilityId,
      url: normalizedSourceValue(input.url ?? src.url),
      artifactType: normalizedKnowledgeArtifactType(input.artifactType ?? src.artifactType),
    };
    const sourceKey = capabilityKnowledgeSourceKey(nextIdentity);
    if (!sourceKey) throw new Error("Knowledge source identity is incomplete.");
    return prisma.$transaction(async (tx) => {
      await assertActiveCapabilityForWrite(tx, capabilityId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sourceKey}))`;
      await assertNoActiveKnowledgeSourceDuplicate(tx, nextIdentity, sourceId);
      const updated = await tx.capabilityKnowledgeSource.updateMany({
        where: { id: sourceId, capabilityId, status: "ACTIVE" },
        data: {
          url: input.url === undefined ? undefined : nextIdentity.url,
          artifactType: input.artifactType === undefined ? undefined : nextIdentity.artifactType,
          title: input.title ?? undefined,
          pollIntervalSec: input.pollIntervalSec === undefined ? undefined : input.pollIntervalSec,
        },
      });
      if (updated.count === 0) throw new NotFoundError("Knowledge source not found");
      return tx.capabilityKnowledgeSource.findUniqueOrThrow({ where: { id: sourceId } });
    });
  },

  async deleteKnowledgeSource(capabilityId: string, sourceId: string) {
    await requireActiveCapability(capabilityId);
    const src = await prisma.capabilityKnowledgeSource.findUnique({ where: { id: sourceId } });
    if (!src || src.capabilityId !== capabilityId) throw new NotFoundError("Knowledge source not found");
    const sourceUrl = normalizedSourceValue(src.url);
    return prisma.$transaction(async (tx) => {
      await assertActiveCapabilityForWrite(tx, capabilityId);
      const archivedArtifactCount = await tx.$executeRaw(Prisma.sql`
        UPDATE "CapabilityKnowledgeArtifact"
        SET status = 'ARCHIVED', "updatedAt" = now()
        WHERE "capabilityId" = ${capabilityId}
          AND status = 'ACTIVE'
          AND NULLIF(btrim(COALESCE("sourceRef", '')), '') IS NOT NULL
          AND lower(btrim("sourceRef")) = lower(${sourceUrl})
      `);
      const source = await tx.capabilityKnowledgeSource.update({
        where: { id: sourceId },
        data: { status: "ARCHIVED", pollIntervalSec: null },
      });
      return { ...source, archivedArtifactCount };
    });
  },

  // M16 — re-embed worker. Backfills embeddings for any rows whose vector
  // column is NULL across all three tables for a capability. Used after:
  //   1. Switching providers (eg mock → openai) — old vectors are still
  //      stored but the new model won't find anything until backfilled.
  //   2. Migrating M14 v0 rows whose vectorId is JSON text but `embedding`
  //      is NULL.
  // Scoped to a single capability so a partial-tenant backfill is possible.
  async reembedCapability(capabilityId: string, opts: { kinds?: ("knowledge" | "memory" | "code")[] } = {}) {
    await requireActiveCapability(capabilityId);
    const embedder = getEmbeddingProvider();
    const kinds = new Set(opts.kinds ?? ["knowledge", "memory", "code"]);

    const out = {
      provider: embedder.name,
      providerModel: embedder.defaultModel,
      knowledge: { scanned: 0, embedded: 0, failed: 0 },
      memory:    { scanned: 0, embedded: 0, failed: 0 },
      code:      { scanned: 0, embedded: 0, failed: 0 },
    };

    if (kinds.has("knowledge")) {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; title: string; content: string }>>(
        `SELECT id, title, content FROM "CapabilityKnowledgeArtifact"
         WHERE "capabilityId" = $1 AND status = 'ACTIVE' AND embedding IS NULL
         ORDER BY "createdAt" DESC LIMIT 500`,
        capabilityId,
      );
      out.knowledge.scanned = rows.length;
      for (const r of rows) {
        try {
          const emb = await embedder.embed({ text: `${r.title}\n${r.content}`.slice(0, 8_000) });
          assertDimMatches(emb.dim, `${emb.provider}:${emb.model}`);
          const updated = await prisma.$executeRawUnsafe(
            `UPDATE "CapabilityKnowledgeArtifact" target
             SET embedding = $1::vector
             WHERE target.id = $2
               AND target.status = 'ACTIVE'
               AND EXISTS (
                 SELECT 1
                 FROM "Capability" c
                 WHERE c.id = target."capabilityId"
                   AND c.status <> 'ARCHIVED'
               )`,
            toVectorLiteral(emb.vector), r.id,
          );
          if (updated > 0) out.knowledge.embedded += 1;
        } catch { out.knowledge.failed += 1; }
      }
    }

    if (kinds.has("memory")) {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; title: string; content: string }>>(
        `SELECT id, title, content FROM "DistilledMemory"
         WHERE "scopeType" = 'CAPABILITY' AND "scopeId" = $1
           AND status = 'ACTIVE' AND embedding IS NULL
         ORDER BY "createdAt" DESC LIMIT 500`,
        capabilityId,
      );
      out.memory.scanned = rows.length;
      for (const r of rows) {
        try {
          const emb = await embedder.embed({ text: `${r.title}\n${r.content}`.slice(0, 8_000) });
          assertDimMatches(emb.dim, `${emb.provider}:${emb.model}`);
          const updated = await prisma.$executeRawUnsafe(
            `UPDATE "DistilledMemory" target
             SET embedding = $1::vector
             WHERE target.id = $2
               AND target.status = 'ACTIVE'
               AND target."scopeType" = 'CAPABILITY'
               AND EXISTS (
                 SELECT 1
                 FROM "Capability" c
                 WHERE c.id = target."scopeId"
                   AND c.status <> 'ARCHIVED'
               )`,
            toVectorLiteral(emb.vector), r.id,
          );
          if (updated > 0) out.memory.embedded += 1;
        } catch { out.memory.failed += 1; }
      }
    }

    if (kinds.has("code")) {
      // Two flavours: (a) symbol has no embedding row at all, (b) row exists
      // but `embedding` is NULL (M14 v0 rows). Both mean "no semantic data".
      const rows = await prisma.$queryRawUnsafe<Array<{
        symbol_id: string; symbolName: string; summary: string | null;
        embedding_id: string | null;
      }>>(
        `SELECT s.id AS symbol_id, s."symbolName", s.summary,
                e.id AS embedding_id
         FROM "CapabilityCodeSymbol" s
         LEFT JOIN "CapabilityCodeEmbedding" e ON e."symbolId" = s.id
         WHERE s."capabilityId" = $1
           AND (e.id IS NULL OR e.embedding IS NULL)
         ORDER BY s."createdAt" DESC LIMIT 1000`,
        capabilityId,
      );
      out.code.scanned = rows.length;
      for (const r of rows) {
        try {
          const embedded = await ensureCodeSymbolEmbedding({
            symbolId: r.symbol_id,
            symbolName: r.symbolName,
            summary: r.summary,
            embedder,
          });
          if (embedded) out.code.embedded += 1;
        } catch { out.code.failed += 1; }
      }
    }

    return out;
  },
};

function repoNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || parsed.hostname;
  } catch {
    return url.slice(0, 80);
  }
}

function parseGitHub(url: string): { owner: string; repo: string } {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") throw new Error("Only public github.com repositories are supported in bootstrap discovery.");
  const [owner, repoRaw] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repoRaw) throw new Error("GitHub URL must include owner and repository.");
  return { owner, repo: repoRaw.replace(/\.git$/, "") };
}

/**
 * MCP-mediated GitHub access. Platform policy: GitHub egress only happens
 * through the MCP server — even during capability onboarding. These helpers
 * call mcp-server's /mcp/source/* endpoints (which hold any GITHUB_TOKEN and
 * are the single GitHub egress point) instead of hitting api.github.com /
 * raw.githubusercontent.com directly.
 */
async function mcpSourcePost(path: string, body: Record<string, unknown>, routeUserId?: string): Promise<unknown> {
  // Prefer routing repo discovery through the CF bridge to the requesting user's
  // laptop runtime. In the cloud+laptop split the control plane has no
  // co-located mcp HTTP (mcp is on the laptop, dial-in), so the bridge is the
  // only way to reach a GitHub-capable runtime. Falls back to direct mcp HTTP
  // (all-in-one / co-located) when CF isn't configured, the user is unknown, or
  // no laptop runtime is online — so existing single-box deployments are
  // unchanged.
  const cfUrl = (process.env.CONTEXT_FABRIC_URL ?? "").replace(/\/+$/, "");
  const cfToken = process.env.CONTEXT_FABRIC_SERVICE_TOKEN ?? "";
  let bridgeFailure = "";
  if (cfUrl && cfToken && routeUserId) {
    const op = path.endsWith("/file") ? "file" : "tree";
    try {
      const res = await fetch(`${cfUrl}/api/runtime-bridge/source/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Service-Token": cfToken },
        body: JSON.stringify({ user_id: routeUserId, ...body }),
        signal: AbortSignal.timeout(CAPABILITY_DISCOVERY_FETCH_TIMEOUT_MS),
      });
      if (res.ok) return await readUpstreamJsonObject(res, `Runtime Bridge source-${op}`);
      const detail = await res.text().catch(() => "");
      bridgeFailure = `Runtime Bridge source-${op} returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`;
      // 503 = no laptop runtime online for this user → fall back to HTTP below.
      // Other statuses fall through too, so a transient bridge error doesn't
      // become a hard discovery failure when a co-located mcp is reachable.
      console.warn(`[capability] ${bridgeFailure}; falling back to MCP_SERVER_URL`);
    } catch (err) {
      bridgeFailure = `Runtime Bridge source-${op} failed: ${(err as Error).message}`;
      console.warn(`[capability] ${bridgeFailure}; falling back to MCP_SERVER_URL`);
    }
  }

  const base = (process.env.MCP_SERVER_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new Error(`${bridgeFailure ? `${bridgeFailure}; ` : ""}MCP_SERVER_URL is not configured; GitHub access must go through MCP runtime.`);
  }
  const token = process.env.MCP_BEARER_TOKEN ?? "";
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CAPABILITY_DISCOVERY_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`MCP source request ${path} failed (${res.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`);
    }
    return readUpstreamJsonObject(res, `MCP source request ${path}`);
  } catch (err) {
    throw new Error(`${bridgeFailure ? `${bridgeFailure}; ` : ""}Direct MCP source fallback failed: ${(err as Error).message}`);
  }
}

async function fetchRepoTreeViaMcp(repoUrl: string, branch: string, routeUserId?: string): Promise<Array<{ path?: string; type?: string; size?: number }>> {
  const data = await mcpSourcePost("/mcp/source/tree", { repoUrl, branch }, routeUserId) as { tree?: Array<{ path?: string; type?: string; size?: number }> };
  return data.tree ?? [];
}

async function discoverGitHubRepoWithProfile(repoUrl: string, branch: string, routeUserId?: string): Promise<{ docs: DiscoveryDoc[]; profile: RepositoryProfile }> {
  const { owner, repo } = parseGitHub(repoUrl);
  const blobs = (await fetchRepoTreeViaMcp(repoUrl, branch, routeUserId))
    .filter(item => item.type === "blob" && item.path);
  const candidates = blobs
    .filter(item => item.type === "blob" && item.path && isDiscoveryPath(item.path) && (item.size ?? 0) <= 250_000)
    .slice(0, DISCOVERY_FILE_CAP);
  const docs: DiscoveryDoc[] = [];
  let total = 0;
  const sourceByPath = new Map<string, string>();
  for (const item of candidates) {
    const itemPath = item.path!;
    const content = (await fetchRepoFileViaMcp(repoUrl, branch, itemPath, routeUserId)).slice(0, DISCOVERY_SOURCE_CHAR_CAP);
    if (!content) continue;
    sourceByPath.set(itemPath, content);
    total += content.length;
    if (total > DISCOVERY_TOTAL_CHAR_CAP) break;
    docs.push({ title: itemPath, content, path: itemPath, sourceType: "GITHUB_REPO", sourceRef: repoUrl });
  }
  const profile = await buildRepositoryProfileFromTree({
    owner,
    repo,
    repoUrl,
    branch,
    blobs,
    sourceByPath,
    routeUserId,
  });
  return { docs, profile };
}

async function fetchRepoFileViaMcp(repoUrl: string, branch: string, itemPath: string, routeUserId?: string): Promise<string> {
  const data = await mcpSourcePost("/mcp/source/file", { repoUrl, branch, path: itemPath }, routeUserId) as { content?: string };
  return data.content ?? "";
}

async function buildRepositoryProfileFromTree(input: {
  owner: string;
  repo: string;
  repoUrl: string;
  branch: string;
  blobs: Array<{ path?: string; type?: string; size?: number }>;
  sourceByPath: Map<string, string>;
  routeUserId?: string;
}): Promise<RepositoryProfile> {
  const languageCounts = new Map<string, number>();
  let totalBytes = 0;
  for (const blob of input.blobs) {
    const path = blob.path ?? "";
    totalBytes += blob.size ?? 0;
    const language = languageFromPath(path);
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }

  const keyFiles = input.blobs
    .map(blob => blob.path ?? "")
    .filter(path => isPlatformKeyFile(path))
    .slice(0, 40);
  const sourceFiles = input.blobs
    .map(blob => blob.path ?? "")
    .filter(path => shouldProfileSourceFile(path))
    .slice(0, 80);

  const sourceByPath = new Map(input.sourceByPath);
  for (const path of [...keyFiles, ...sourceFiles]) {
    if (sourceByPath.has(path)) continue;
    const blob = input.blobs.find(item => item.path === path);
    if ((blob?.size ?? 0) > 250_000) continue;
    const content = await fetchRepoFileViaMcp(input.repoUrl, input.branch, path, input.routeUserId);
    if (content) sourceByPath.set(path, content.slice(0, DISCOVERY_SOURCE_CHAR_CAP));
  }

  const textCorpus = Array.from(sourceByPath.entries())
    .filter(([path]) => isPlatformKeyFile(path) || /(^|\/)README/i.test(path))
    .map(([path, content]) => `\n# ${path}\n${content}`)
    .join("\n")
    .slice(0, 200_000);
  const frameworks = detectFrameworks(textCorpus, Array.from(sourceByPath.keys()));
  const buildTools = detectBuildTools(Array.from(sourceByPath.keys()), textCorpus);
  const endpoints = Array.from(sourceByPath.entries())
    .filter(([path]) => /\.java$/i.test(path))
    .flatMap(([path, content]) => extractJavaEndpoints(path, content))
    .slice(0, 100);

  const languages = Array.from(languageCounts.entries())
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 10);
  const repoName = `${input.owner}/${input.repo}`;
  return {
    repoName,
    repoUrl: input.repoUrl,
    branch: input.branch,
    fileCount: input.blobs.length,
    totalBytes,
    languages,
    frameworks,
    buildTools,
    endpointCount: endpoints.length,
    endpoints,
    keyFiles,
    graphMermaid: buildCodeGraphMermaid(repoName, languages, frameworks, buildTools, endpoints),
  };
}

function languageFromPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    java: "Java",
    kt: "Kotlin",
    kts: "Kotlin",
    scala: "Scala",
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    py: "Python",
    go: "Go",
    rb: "Ruby",
    cs: "C#",
    sql: "SQL",
    yaml: "YAML",
    yml: "YAML",
    xml: "XML",
    json: "JSON",
    md: "Markdown",
  };
  return ext ? map[ext] ?? null : null;
}

function isPlatformKeyFile(path: string): boolean {
  return /(^|\/)(pom\.xml|build\.gradle|build\.gradle\.kts|settings\.gradle|settings\.gradle\.kts|package\.json|requirements\.txt|pyproject\.toml|go\.mod|Dockerfile|docker-compose\.ya?ml|application\.(ya?ml|properties)|README(\..*)?)$/i.test(path);
}

function shouldProfileSourceFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (/\/(target|build|dist|node_modules|vendor|\.git)\//i.test(`/${normalized}`)) return false;
  if (/Controller\.java$|Resource\.java$|Endpoint\.java$|Application\.java$/i.test(normalized)) return true;
  if (/src\/main\/java\/.+\.java$/i.test(normalized) && /api|controller|resource|endpoint/i.test(normalized)) return true;
  return false;
}

function detectBuildTools(paths: string[], corpus: string): string[] {
  const tools = new Set<string>();
  if (paths.some(path => /(^|\/)pom\.xml$/i.test(path))) tools.add("Maven");
  if (paths.some(path => /(^|\/)build\.gradle(\.kts)?$/i.test(path))) tools.add("Gradle");
  if (paths.some(path => /(^|\/)package\.json$/i.test(path))) tools.add("npm");
  if (paths.some(path => /(^|\/)Dockerfile$/i.test(path))) tools.add("Docker");
  if (/\bMaven\b|\bmvn\s|pom\.xml/i.test(corpus)) tools.add("Maven");
  if (/\bGradle\b|build\.gradle/i.test(corpus)) tools.add("Gradle");
  if (/spring-boot-maven-plugin|org\.springframework\.boot/i.test(corpus)) tools.add("Spring Boot");
  return Array.from(tools);
}

function detectFrameworks(corpus: string, paths: string[]): string[] {
  const frameworks = new Set<string>();
  if (/spring-boot|org\.springframework\.boot|@SpringBootApplication|@RestController|@Controller/i.test(corpus)) frameworks.add("Spring Boot");
  if (/jakarta\.ws\.rs|javax\.ws\.rs|@Path\(/i.test(corpus)) frameworks.add("JAX-RS");
  if (/react|next|vite/i.test(corpus) || paths.some(path => /\.(tsx|jsx)$/i.test(path))) frameworks.add("React/Vite");
  if (/express|fastify|nestjs/i.test(corpus)) frameworks.add("Node API");
  if (/fastapi|flask|django/i.test(corpus)) frameworks.add("Python web");
  return Array.from(frameworks);
}

function extractJavaEndpoints(path: string, content: string): Array<{ method: string; path: string; file: string }> {
  const out: Array<{ method: string; path: string; file: string }> = [];
  const lines = content.split(/\r?\n/);
  let classPrefix = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!classPrefix && /@RequestMapping\b/.test(line) && lines.slice(index, index + 4).some(next => /\bclass\b/.test(next))) {
      classPrefix = extractAnnotationPath(line);
    }
    const match = line.match(/@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\b(.*)$/);
    if (!match) continue;
    const annotation = match[1];
    const args = match[2] ?? "";
    if (annotation === "RequestMapping" && lines.slice(index, index + 4).some(next => /\bclass\b/.test(next))) continue;
    const method = annotation === "RequestMapping"
      ? (args.match(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/i)?.[1]?.toUpperCase() ?? "ANY")
      : annotation.replace("Mapping", "").toUpperCase();
    const suffix = extractAnnotationPath(line) || "/";
    out.push({ method, path: joinEndpointPath(classPrefix, suffix), file: path });
  }
  return out;
}

function extractAnnotationPath(line: string): string {
  const quoted = line.match(/["']([^"']+)["']/)?.[1];
  if (quoted) return quoted;
  const value = line.match(/\bpath\s*=\s*\{?\s*["']([^"']+)["']/)?.[1]
    ?? line.match(/\bvalue\s*=\s*\{?\s*["']([^"']+)["']/)?.[1];
  return value ?? "";
}

function joinEndpointPath(prefix: string, suffix: string): string {
  const joined = `/${[prefix, suffix].filter(Boolean).join("/")}`.replace(/\/+/g, "/");
  return joined === "/" ? "/" : joined.replace(/\/$/, "");
}

function buildCodeGraphMermaid(
  repoName: string,
  languages: Array<{ language: string; files: number }>,
  frameworks: string[],
  buildTools: string[],
  endpoints: Array<{ method: string; path: string; file: string }>,
): string {
  const topLanguages = languages.slice(0, 4).map(item => `${item.language} ${item.files}`).join(" / ") || "No source files detected";
  const frameworkLabel = frameworks.slice(0, 4).join(" / ") || "Framework pending";
  const buildLabel = buildTools.slice(0, 4).join(" / ") || "Build tool pending";
  const endpointLabel = endpoints.length ? `${endpoints.length} endpoint(s)` : "No endpoints detected";
  const endpointNodes = endpoints.slice(0, 6).map((endpoint, index) =>
    `  E${index + 1}["${escapeMermaid(`${endpoint.method} ${endpoint.path}`)}"]`,
  );
  const endpointEdges = endpoints.slice(0, 6).map((_, index) => `  API --> E${index + 1}`);
  return [
    "flowchart LR",
    `  R["${escapeMermaid(repoName)}"]`,
    `  L["Languages<br/>${escapeMermaid(topLanguages)}"]`,
    `  F["Frameworks<br/>${escapeMermaid(frameworkLabel)}"]`,
    `  B["Build<br/>${escapeMermaid(buildLabel)}"]`,
    `  API["API Surface<br/>${escapeMermaid(endpointLabel)}"]`,
    "  R --> L",
    "  R --> F",
    "  R --> B",
    "  F --> API",
    ...endpointNodes,
    ...endpointEdges,
  ].join("\n");
}

async function fetchDocumentLink(doc: BootstrapDocumentInput): Promise<DiscoveryDoc> {
  const res = await fetch(doc.url, { signal: AbortSignal.timeout(CAPABILITY_DISCOVERY_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const content = (await res.text()).slice(0, DISCOVERY_SOURCE_CHAR_CAP);
  return {
    title: doc.title ?? extractMarkdownTitle(content) ?? doc.url,
    content,
    sourceType: "DOCUMENT_LINK",
    sourceRef: doc.url,
  };
}

function discoverLocalSignals(files: InputFile[]): DiscoveryDoc[] {
  const docs: DiscoveryDoc[] = [];
  let total = 0;
  for (const file of files) {
    if (!isDiscoveryPath(file.path)) continue;
    const content = file.content.slice(0, DISCOVERY_SOURCE_CHAR_CAP);
    total += content.length;
    if (total > DISCOVERY_TOTAL_CHAR_CAP || docs.length >= DISCOVERY_FILE_CAP) break;
    docs.push({ title: file.path, content, path: file.path, sourceType: "LOCAL_FILE", sourceRef: LOCAL_BOOTSTRAP_REF });
  }
  return docs;
}

function isDiscoveryPath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? normalized;
  if (/^README(\..*)?$/i.test(name)) return true;
  if (/^(CLAUDE|AGENTS)\.md$/i.test(name)) return true;
  if (normalized === ".github/copilot-instructions.md") return true;
  if (normalized.startsWith(".cursor/rules/")) return true;
  if (name === ".cursorrules" || name === ".windsurfrules") return true;
  if (normalized.startsWith(".claude/")) return true;
  if (/(\.codex\/skills\/|\/)?SKILL\.md$/i.test(normalized)) return true;
  if (/^docs\/.+\.md$/i.test(normalized)) return true;
  return false;
}

/**
 * M61 Slice C — Privileged "agent rule" paths.
 *
 * A subset of isDiscoveryPath that captures files explicitly authored
 * for agents (Claude Code, Cursor, Copilot, Windsurf, generic AGENTS.md).
 * These are auto-promoted into CapabilityWorldModel.agentRules at
 * bootstrap and surface as ambient system context via the Slice F
 * CODE_AGENT_RULES prompt layer — they bypass the human-gated
 * CapabilityLearningCandidate review path that arbitrary docs go through.
 *
 * Conservative on purpose: a stray docs/installation.md is not an
 * "agent rule" even though it matches isDiscoveryPath. The litmus test
 * is "would I want this prepended to the system prompt verbatim?"
 */
export function isAgentRulePath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? normalized;
  if (/^(CLAUDE|AGENTS)\.md$/i.test(name)) return true;
  if (normalized === ".github/copilot-instructions.md") return true;
  if (normalized.startsWith(".cursor/rules/")) return true;
  if (name === ".cursorrules" || name === ".windsurfrules") return true;
  if (normalized.startsWith(".claude/") && /\.(md|txt)$/i.test(name)) return true;
  if (/(\.codex\/skills\/|\/)?SKILL\.md$/i.test(normalized)) return true;
  return false;
}

/**
 * M61 Slice C — Pull AgentRule[] out of the discovered-docs bag.
 *
 * We do NOT filter `discovered` in place — the rule docs continue to
 * flow into buildLearningCandidates / candidates so an operator who
 * wants to manage them via the existing review UI still can. The
 * world-model copy is the privileged, auto-trusted ambient context.
 *
 * Each rule's content is capped here at 32KB. Anything larger is
 * truncated with a trailing "[truncated]" marker — these files are
 * meant to be terse instructions; multi-megabyte rule files are
 * almost certainly a misfiling that would blow up the system prompt.
 */
const AGENT_RULE_CONTENT_CAP = 32 * 1024;

export function extractAgentRules(discovered: DiscoveryDoc[]): Array<{ source: string; content: string; sha256: string }> {
  const out: Array<{ source: string; content: string; sha256: string }> = [];
  const seen = new Set<string>();
  for (const doc of discovered) {
    const path = doc.path ?? doc.title;
    if (!path || !isAgentRulePath(path)) continue;
    // Deduplicate by source path — a doc-link and a local-file can
    // surface the same CLAUDE.md from two angles.
    if (seen.has(path)) continue;
    seen.add(path);
    const raw = (doc.content ?? "").trim();
    if (!raw) continue;
    const content = raw.length > AGENT_RULE_CONTENT_CAP
      ? `${raw.slice(0, AGENT_RULE_CONTENT_CAP).trimEnd()}\n\n[truncated — original ${raw.length} chars]`
      : raw;
    out.push({
      source: path,
      content,
      sha256: sha256(content),
    });
  }
  return out;
}

/**
 * M61 Slice C — Best-guess primary language from RepositoryProfile[].
 *
 * Sums file counts across all repos by language and picks the largest.
 * Returns null when no profile reported anything — the Slice D wizard
 * gives the operator a chance to confirm.
 */
export function pickPrimaryLanguage(profiles: RepositoryProfile[]): string | null {
  const totals = new Map<string, number>();
  for (const p of profiles ?? []) {
    for (const { language, files } of p.languages ?? []) {
      if (!language) continue;
      totals.set(language, (totals.get(language) ?? 0) + (files ?? 0));
    }
  }
  if (totals.size === 0) return null;
  let best: { lang: string; n: number } | null = null;
  for (const [lang, n] of totals) {
    if (!best || n > best.n) best = { lang, n };
  }
  return best?.lang ?? null;
}

/**
 * M61 Slice C — Best-guess build system from RepositoryProfile[].
 *
 * Uses a priority order tuned to "which one drives the verifier" —
 * pnpm beats npm beats yarn (since pnpm-workspace.yaml fully determines
 * the workspace), Gradle/Maven for JVM, Cargo for Rust, etc.
 */
const BUILD_SYSTEM_PRIORITY = [
  "bazel", "pnpm", "gradle", "maven", "cargo", "poetry", "go-modules",
  "yarn", "npm", "make", "pip",
];

export function pickPrimaryBuildSystem(profiles: RepositoryProfile[]): string | null {
  const seen = new Set<string>();
  for (const p of profiles ?? []) {
    for (const tool of p.buildTools ?? []) {
      if (tool) seen.add(tool.toLowerCase());
    }
  }
  for (const candidate of BUILD_SYSTEM_PRIORITY) {
    if (seen.has(candidate)) return candidate;
  }
  // Fallback: first reported tool, if any.
  const first = Array.from(seen)[0];
  return first ?? null;
}

function selectBootstrapAgents(input: BootstrapInput): BootstrapAgentCatalogItem[] {
  const catalog = loadAgentCatalog();
  const preset = input.agentPreset ?? catalog.defaultPreset;
  // Preset membership comes from config; an unknown preset falls back to the whole catalog.
  const presetKeys = new Set(catalog.presets[preset]?.agents ?? catalog.agents.map(agent => agent.key));
  for (const key of input.includeAgentKeys ?? []) presetKeys.add(key);
  for (const key of input.excludeAgentKeys ?? []) {
    const agent = catalog.agents.find(item => item.key === key);
    // Locked activation-required gates cannot be excluded.
    if (agent?.activationRequired) continue;
    presetKeys.delete(key);
  }
  return catalog.agents.filter(agent => presetKeys.has(agent.key));
}

function capabilityAgentDescription(
  capabilityName: string,
  agent: BootstrapAgentCatalogItem,
  baseDescription?: string | null,
): string {
  const lock = agent.locked
    ? "This capability agent is locked: capability owners can activate or use it, but cannot edit its baseline prompt/tool policy without platform-admin review."
    : "This capability agent starts as a draft: capability owners can tune it before activation.";
  const learning = agent.learnsFromGit
    ? "It should use approved Git/doc/local learning candidates, capability knowledge artifacts, compiled context, and MCP AST/symbol tools before reading large files."
    : "It should rely on capability identity, policy, audit receipts, approvals, budget evidence, and required artifact lineage.";
  return [
    `${agent.description}`,
    `Capability grounding: ${agent.grounding}`,
    `Capability: ${capabilityName}.`,
    learning,
    lock,
    baseDescription ? `Platform baseline: ${baseDescription}` : undefined,
  ].filter(Boolean).join("\n\n");
}

function buildLearningCandidates(docs: DiscoveryDoc[]): Array<{
  groupKey: string; groupTitle: string; artifactType: string; title: string; content: string;
  sourceType: string; sourceRef: string; confidence: number;
}> {
  const groups = [
    { key: "capability_overview", title: "Capability overview", type: "CAPABILITY_OVERVIEW", test: (d: DiscoveryDoc) => /readme/i.test(d.path ?? d.title) },
    { key: "architecture_domain", title: "Architecture and domain vocabulary", type: "ARCHITECTURE_SUMMARY", test: (d: DiscoveryDoc) => /architecture|domain|design|docs\//i.test(`${d.path ?? ""}\n${d.content}`) },
    { key: "build_test_run", title: "Build, test, and run commands", type: "RUNBOOK", test: (d: DiscoveryDoc) => /(pnpm|npm|yarn|mvn|gradle|pytest|go test|cargo|docker|make|build|test|start|run)/i.test(d.content) },
    { key: "coding_conventions", title: "Coding conventions", type: "CODING_CONVENTIONS", test: (d: DiscoveryDoc) => /(convention|style|lint|format|cursor|windsurf|copilot|claude|agents|skill)/i.test(`${d.path ?? ""}\n${d.content}`) },
    { key: "agent_instructions", title: "Agent instructions", type: "AGENT_INSTRUCTIONS", test: (d: DiscoveryDoc) => /(CLAUDE|AGENTS|SKILL|\.claude|\.codex|copilot|cursor|windsurf)/i.test(d.path ?? d.title) },
    { key: "external_documentation", title: "External documentation facts", type: "EXTERNAL_DOC", test: (d: DiscoveryDoc) => d.sourceType === "DOCUMENT_LINK" },
  ];

  const out: Array<{
    groupKey: string; groupTitle: string; artifactType: string; title: string; content: string;
    sourceType: string; sourceRef: string; confidence: number;
  }> = [];
  for (const group of groups) {
    const hits = docs.filter(group.test).slice(0, 12);
    if (hits.length === 0) continue;
    out.push({
      groupKey: group.key,
      groupTitle: group.title,
      artifactType: group.type,
      title: group.title,
      content: formatCandidateContent(group.title, hits),
      sourceType: Array.from(new Set(hits.map(h => h.sourceType))).join(","),
      sourceRef: Array.from(new Set(hits.map(h => h.sourceRef))).join(","),
      confidence: group.key === "external_documentation" ? 0.8 : 0.75,
    });
  }
  return out;
}

function buildAgentGroundingCandidates(
  capabilityName: string,
  agents: BootstrapAgentCatalogItem[],
  docs: DiscoveryDoc[],
): Array<{
  groupKey: string; groupTitle: string; artifactType: string; title: string; content: string;
  sourceType: string; sourceRef: string; confidence: number;
}> {
  if (agents.length === 0) return [];
  const sourceRefs = Array.from(new Set(docs.map(doc => doc.sourceRef).filter(Boolean))).join(",") || "capability-bootstrap";
  const gitBacked = agents.filter(agent => agent.learnsFromGit).map(agent => `- ${agent.label}: ${agent.grounding}`).join("\n");
  const locked = agents.filter(agent => agent.locked).map(agent => `- ${agent.label}: locked gate; activation required=${agent.activationRequired ? "yes" : "no"}`).join("\n");
  return [{
    groupKey: "agent_team_grounding",
    groupTitle: "Capability agent team grounding",
    artifactType: "AGENT_TEAM_GROUNDING",
    title: `${capabilityName} agent team grounding`,
    content: [
      `# ${capabilityName} agent team grounding`,
      "This candidate records the predefined capability agent team created by bootstrap. Approving it makes the operating model visible to runtime retrieval and later compiled-context capsules.",
      "",
      "## Git/doc grounded agents",
      gitBacked || "- No Git/doc-grounded agents selected.",
      "",
      "## Locked governance gates",
      locked || "- No locked gates selected.",
      "",
      "## Runtime rule",
      "All activated agents are capability-scoped. They should use approved capability knowledge, memory, code symbols, MCP AST slices, citations, budget receipts, and artifact lineage instead of ungrounded free-form context.",
    ].join("\n"),
    sourceType: "BOOTSTRAP_AGENT_CATALOG",
    sourceRef: sourceRefs,
    confidence: 0.9,
  }];
}

function buildArchitectureDiagramCandidate(
  capabilityName: string,
  diagram: CapabilityArchitectureDiagram,
): {
  groupKey: string; groupTitle: string; artifactType: string; title: string; content: string;
  sourceType: string; sourceRef: string; confidence: number;
} {
  return {
    groupKey: "architecture_diagram",
    groupTitle: "Capability architecture diagram",
    artifactType: "ARCHITECTURE_DIAGRAM",
    title: `${capabilityName} architecture diagram`,
    content: [
      `# ${diagram.title}`,
      diagram.description,
      "",
      "```mermaid",
      diagram.mermaid,
      "```",
      ...(diagram.codeGraphMermaid ? [
        "",
        "## Code graph",
        "```mermaid",
        diagram.codeGraphMermaid,
        "```",
      ] : []),
      "",
      "## Layers",
      ...diagram.layers.flatMap(layer => [
        "",
        `### ${layer.label}`,
        ...layer.items.map(item => `- ${item}`),
      ]),
    ].join("\n"),
    sourceType: "BOOTSTRAP_ARCHITECTURE",
    sourceRef: "capability-bootstrap:architecture-diagram",
    confidence: 0.9,
  };
}

function buildPlatformInventoryCandidates(profiles: RepositoryProfile[]): Array<{
  groupKey: string; groupTitle: string; artifactType: string; title: string; content: string;
  sourceType: string; sourceRef: string; confidence: number;
}> {
  if (profiles.length === 0) return [];
  const lines = ["# Repository platform inventory"];
  for (const profile of profiles) {
    lines.push(
      "",
      `## ${profile.repoName}`,
      `- Branch: ${profile.branch}`,
      `- Files: ${profile.fileCount}`,
      `- Approx bytes: ${profile.totalBytes}`,
      `- Languages: ${profile.languages.map(item => `${item.language} (${item.files})`).join(", ") || "none detected"}`,
      `- Frameworks: ${profile.frameworks.join(", ") || "none detected"}`,
      `- Build tools: ${profile.buildTools.join(", ") || "none detected"}`,
      `- Endpoints detected: ${profile.endpointCount}`,
    );
    if (profile.endpoints.length > 0) {
      lines.push("", "### Endpoint sample");
      for (const endpoint of profile.endpoints.slice(0, 30)) {
        lines.push(`- ${endpoint.method} ${endpoint.path} (${endpoint.file})`);
      }
    }
    lines.push("", "### Code graph", "```mermaid", profile.graphMermaid, "```");
  }
  return [{
    groupKey: "platform_inventory",
    groupTitle: "Platform, endpoint, and code graph inventory",
    artifactType: "PLATFORM_INVENTORY",
    title: "Repository platform inventory",
    content: lines.join("\n"),
    sourceType: "GITHUB_REPO_PROFILE",
    sourceRef: profiles.map(profile => profile.repoUrl).join(","),
    confidence: 0.86,
  }];
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.map(item => String(item ?? "").trim()).filter(item => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function compareLearningCandidatesForReview(
  a: { groupKey: string; createdAt: Date; id: string },
  b: { groupKey: string; createdAt: Date; id: string },
): number {
  return a.groupKey.localeCompare(b.groupKey)
    || a.createdAt.getTime() - b.createdAt.getTime()
    || a.id.localeCompare(b.id);
}

function normalizeArchitectureDiagram(value: unknown): CapabilityArchitectureDiagram | null {
  const raw = jsonRecord(value);
  const kind = raw.kind === "TOGAF_CAPABILITY_COLLECTION" ? raw.kind
    : raw.kind === "APPLICATION_CAPABILITY_ARCHITECTURE" ? raw.kind
      : null;
  const view = raw.view === "togaf" ? "togaf"
    : raw.view === "application" ? "application"
      : null;
  if (!kind || !view || typeof raw.title !== "string" || typeof raw.description !== "string" || typeof raw.mermaid !== "string") {
    return null;
  }
  const layers = Array.isArray(raw.layers)
    ? raw.layers.map(layer => {
      const row = jsonRecord(layer);
      return {
        key: typeof row.key === "string" ? row.key : "layer",
        label: typeof row.label === "string" ? row.label : "Layer",
        items: Array.isArray(row.items)
          ? row.items.map(item => String(item ?? "").trim()).filter(Boolean)
          : [],
      };
    }).filter(layer => layer.items.length > 0 && !isPlaceholderArchitectureLayer(layer))
    : [];
  const highlights = Array.isArray(raw.highlights)
    ? raw.highlights.map(item => {
      const row = jsonRecord(item);
      return {
        key: typeof row.key === "string" ? row.key : "signal",
        label: typeof row.label === "string" ? row.label : "Signal",
        value: typeof row.value === "string" ? row.value : String(row.value ?? "--"),
        detail: typeof row.detail === "string" ? row.detail : undefined,
      };
    }).filter(highlight => !isPlaceholderArchitectureHighlight(highlight))
    : undefined;
  return {
    kind,
    view,
    title: raw.title,
    description: raw.description,
    mermaid: raw.mermaid,
    codeGraphMermaid: typeof raw.codeGraphMermaid === "string" ? raw.codeGraphMermaid : undefined,
    repositoryProfiles: Array.isArray(raw.repositoryProfiles) ? raw.repositoryProfiles as RepositoryProfile[] : undefined,
    highlights: highlights?.length ? highlights : undefined,
    layers,
  };
}

function isPlaceholderArchitectureHighlight(highlight: { key: string; value: string }): boolean {
  return /^(stack|api)$/i.test(highlight.key.trim()) && /^(pending|stack pending|api pending)$/i.test(highlight.value.trim());
}

function isPlaceholderArchitectureLayer(layer: { key: string; items: string[] }): boolean {
  if (!/^(runtime_stack|contract|domain_model)$/i.test(layer.key.trim())) return false;
  return layer.items.length > 0 && layer.items.every(item => /\bpending\b/i.test(item));
}

function buildCapabilityArchitectureDiagram(
  capability: { name: string; appId?: string | null; capabilityType?: string | null; criticality?: string | null },
  input: BootstrapInput,
  generatedAgents: Array<{ label: string; roleType: string; locked: boolean; learnsFromGit: boolean }>,
  docs: DiscoveryDoc[],
  repositoryProfiles: RepositoryProfile[] = [],
): CapabilityArchitectureDiagram {
  const capabilityName = capability.name;
  const collection = isCollectionCapabilityType(capability.capabilityType);
  const repos = (input.repositories ?? []).map(repo => repo.repoName?.trim() || repoNameFromUrl(repo.repoUrl)).filter(Boolean);
  const docCount = (input.documentLinks?.length ?? 0) + docs.filter(doc => doc.sourceType === "DOCUMENT_LINK").length;
  const localCount = input.localFiles?.length ?? 0;
  const agents = generatedAgents.map(agent => agent.label || agent.roleType);
  const appSuffix = capability.appId ? ` (${capability.appId})` : "";
  const sharedApplications = input.sharedApplications ?? [];
  const docCorpus = docs.map(doc => `${doc.title}\n${doc.content}`).join("\n").slice(0, 200_000);
  const docPaths = docs.map(doc => doc.path ?? doc.title);
  const profileEndpoints = repositoryProfiles.flatMap(profile =>
    profile.endpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`),
  );
  const endpointItems = unique([...profileEndpoints, ...extractEndpointMentions(docCorpus)]).slice(0, 8);
  const endpointTotal = endpointItems.length || repositoryProfiles.reduce((sum, profile) => sum + profile.endpointCount, 0);
  const languageSummary = unique([
    ...repositoryProfiles.flatMap(profile => profile.languages.slice(0, 4).map(lang => `${lang.language} (${lang.files})`)),
    ...inferLanguagesFromCorpus(docCorpus),
  ]).slice(0, 6);
  const frameworkSummary = unique([
    ...repositoryProfiles.flatMap(profile => profile.frameworks),
    ...detectFrameworks(docCorpus, docPaths),
  ]).slice(0, 6);
  const buildToolSummary = unique([
    ...repositoryProfiles.flatMap(profile => profile.buildTools),
    ...detectBuildTools(docPaths, docCorpus),
  ]).slice(0, 6);
  const domainSummary = inferDomainArchitectureItems(docCorpus, capabilityName);
  const contractSummary = inferContractArchitectureItems(docCorpus);
  const codeGraphMermaid = repositoryProfiles.length === 1
    ? repositoryProfiles[0].graphMermaid
    : repositoryProfiles.length > 1
      ? buildPortfolioCodeGraphMermaid(capabilityName, repositoryProfiles)
      : buildInferredApplicationGraphMermaid(capabilityName, endpointItems, frameworkSummary, domainSummary);
  const hasRepositorySource = repos.length > 0 || repositoryProfiles.length > 0;
  const hasDocumentSource = docCount > 0 || docs.length > 0 || localCount > 0;
  const stackEvidenceItems = unique([...frameworkSummary, ...languageSummary]);
  const stackStatusValue = stackEvidenceItems[0]
    ?? (hasRepositorySource ? "Not learned yet" : hasDocumentSource ? "Document-only" : "No source");
  const stackStatusDetail = stackEvidenceItems.length > 0
    ? (buildToolSummary.slice(0, 2).join(" / ") || "Learned from approved repository/doc signals")
    : hasRepositorySource
      ? "Refresh grounding after source sync or MCP indexing produces stack signals"
      : hasDocumentSource
        ? "Attach a repository source to learn executable stack details; approved documents still guide prompts"
        : "Attach an approved repository or document source before refreshing learning";
  const apiSurfaceValue = endpointTotal
    ? `${endpointTotal} endpoint${endpointTotal === 1 ? "" : "s"}`
    : hasRepositorySource
      ? "Not learned yet"
      : hasDocumentSource
        ? "Document-only"
        : "No source";
  const apiSurfaceDetail = endpointItems[0]
    ?? (hasRepositorySource
      ? "Sync approved sources and refresh grounding to discover API routes"
      : hasDocumentSource
        ? "Approved documents do not include concrete API route signals"
        : "Attach an approved repository or API document to discover endpoints");
  const runtimeStackItems = stackEvidenceItems.length > 0
    ? unique([...languageSummary, ...frameworkSummary, ...buildToolSummary])
    : [
        hasRepositorySource
          ? "Repository attached; executable stack not learned yet"
          : hasDocumentSource
            ? "Document knowledge attached; no executable stack source"
            : "No repository or document source attached",
        stackStatusDetail,
      ];

  if (collection) {
    const layers = [
      { key: "business", label: "Business Architecture", items: [`${capabilityName}${appSuffix}`, "Outcomes, value streams, policies, owners"] },
      { key: "application", label: "Application Architecture", items: [...(sharedApplications.length ? sharedApplications : []), ...(repos.length > 0 ? repos : ["Child applications / bounded contexts"])] },
      { key: "data", label: "Data Architecture", items: [`${docCount || docs.length || 0} doc/source signals`, "Approved knowledge, memory, citations, artifacts"] },
      { key: "technology", label: "Technology Architecture", items: [...runtimeStackItems.slice(0, 5), "MCP workspaces, branches, AST index, local tools"] },
      { key: "governance", label: "Governance", items: ["Locked governance/verifier/security agents", "Budgets, approvals, receipts, audit ledger"] },
    ];
    return {
      kind: "TOGAF_CAPABILITY_COLLECTION",
      title: `${capabilityName} TOGAF capability map`,
      view: "togaf",
      description: "Collection capabilities are shown as TOGAF-style business, application, data, technology, and governance layers so portfolio owners can see how child capabilities are governed.",
      layers,
      codeGraphMermaid,
      repositoryProfiles,
      mermaid: [
        "flowchart TB",
        `  B[Business Architecture<br/>${escapeMermaid(capabilityName)}${capability.appId ? `<br/>App ID: ${escapeMermaid(capability.appId)}` : ""}]`,
        "  A[Application Architecture<br/>Child capabilities / applications]",
        "  D[Data Architecture<br/>Knowledge, memory, artifacts, citations]",
        "  T[Technology Architecture<br/>MCP workspaces, AST index, Context Fabric]",
        "  G[Governance<br/>Approvals, budgets, audit receipts]",
        "  B --> A --> D --> T --> G",
      ].join("\n"),
    };
  }

  const agentItems = agents.length > 0 ? agents : ["Product Owner", "Architect", "Developer", "QA", "Governance"];
  const layers = [
    {
      key: "product_api",
      label: "Product / API",
      items: [
        `${capabilityName}${appSuffix}`,
        `Criticality: ${capability.criticality ?? input.criticality ?? "MEDIUM"}`,
        ...(endpointItems.length ? endpointItems.slice(0, 4) : [apiSurfaceDetail]),
      ],
    },
    { key: "runtime_stack", label: "Runtime Stack", items: runtimeStackItems },
    { key: "domain_model", label: "Domain Model", items: domainSummary.length ? domainSummary : ["No domain model signal learned yet"] },
    { key: "contract", label: "Request / Response Contract", items: contractSummary.length ? contractSummary : ["No request/response contract signal learned yet"] },
    { key: "codebase", label: "Repository Intelligence", items: [...(repos.length ? repos : [hasDocumentSource ? "Document-only source context" : "No repository source attached"]), `${docCount || docs.length || 0} document/source signals`, `${localCount} local files`, `${endpointTotal} endpoints detected`] },
    { key: "delivery", label: "Governed Delivery", items: [...agentItems.slice(0, 6), "Workbench stage artifacts", "Approvals, budgets, receipts, audit trail"] },
  ];
  return {
    kind: "APPLICATION_CAPABILITY_ARCHITECTURE",
    title: `${capabilityName} application capability architecture`,
    view: "application",
    description: buildApplicationArchitectureDescription(capabilityName, frameworkSummary, endpointItems, domainSummary),
    highlights: [
      { key: "stack", label: stackEvidenceItems.length ? "Primary stack" : "Stack status", value: stackStatusValue, detail: stackStatusDetail },
      { key: "api", label: "API surface", value: apiSurfaceValue, detail: apiSurfaceDetail },
      { key: "domain", label: "Domain rules", value: countDomainOperators(docCorpus) ? `${countDomainOperators(docCorpus)} operators` : "Detected model", detail: domainSummary[0] ?? "No domain rule signal learned yet" },
      { key: "source", label: "Source", value: repos.length ? `${repos.length} repo${repos.length === 1 ? "" : "s"}` : "No repo", detail: repos[0] ?? "Attach a repo to ground the graph" },
    ],
    layers,
    codeGraphMermaid,
    repositoryProfiles,
    mermaid: [
      "flowchart LR",
      "  S[Story / Workflow Input]",
      `  C[Capability<br/>${escapeMermaid(capabilityName)}${capability.appId ? `<br/>App ID: ${escapeMermaid(capability.appId)}` : ""}]`,
      "  A[Agent Team<br/>PO / Architect / Developer / QA / Governance]",
      "  K[Grounding<br/>Repos / Docs / Memory / Code Symbols]",
      `  P[Platform Inventory<br/>${endpointTotal} endpoints / ${escapeMermaid(stackEvidenceItems[0] ?? stackStatusValue.toLowerCase())}]`,
      "  X[Context Fabric + MCP<br/>Budget / Model / Tools / AST]",
      "  E[Evidence<br/>Artifacts / Citations / Receipts]",
      "  S --> C --> A",
      "  K --> A",
      "  P --> A",
      "  A --> X --> E",
    ].join("\n"),
  };
}

function buildApplicationArchitectureDescription(
  capabilityName: string,
  frameworks: string[],
  endpoints: string[],
  domainItems: string[],
): string {
  const bits = [
    `${capabilityName} is shown as an application system, not only as agent delivery plumbing.`,
    frameworks[0] ? `Detected stack: ${frameworks[0]}.` : "",
    endpoints[0] ? `Primary API signal: ${endpoints[0]}.` : "",
    domainItems[0] ? `Domain signal: ${domainItems[0]}.` : "",
  ];
  return bits.filter(Boolean).join(" ");
}

function inferLanguagesFromCorpus(corpus: string): string[] {
  const languages = new Set<string>();
  if (/java\s*17|\.java|spring boot|maven|pom\.xml|\bJava\b/i.test(corpus)) languages.add(/java\s*17/i.test(corpus) ? "Java 17+" : "Java");
  if (/\bTypeScript\b|\.tsx?\b|React|Vite/i.test(corpus)) languages.add("TypeScript");
  if (/\bPython\b|FastAPI|Flask|Django/i.test(corpus)) languages.add("Python");
  if (/\bSQL\b|\.sql\b/i.test(corpus)) languages.add("SQL");
  return Array.from(languages);
}

function extractEndpointMentions(corpus: string): string[] {
  const endpoints = new Set<string>();
  const basePath = corpus.match(/Base path:\s*`?([^`\n]+)`?/i)?.[1]?.trim();
  for (const match of corpus.matchAll(/\b(GET|POST|PUT|DELETE|PATCH|ANY)\s+`?(\/[^\s`),.;]+)`?/gi)) {
    const method = match[1].toUpperCase();
    let path = match[2].replace(/[),.;]+$/, "");
    if (basePath && !path.startsWith(basePath) && path !== "/" && path.split("/").length <= 2) {
      path = `${basePath.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
    }
    endpoints.add(`${method} ${path}`);
  }
  if (basePath && endpoints.size === 0) endpoints.add(`Base path: ${basePath}`);
  return Array.from(endpoints);
}

function inferDomainArchitectureItems(corpus: string, capabilityName: string): string[] {
  const items = new Set<string>();
  if (/evaluates JSON rules|rule language|rule engine/i.test(corpus) || /rule/i.test(capabilityName)) {
    items.add("Evaluates JSON rules against arbitrary input data");
  }
  const groupOps = ["all", "any", "not"].filter(op => new RegExp(`\`${op}\`|\\b${op}\\b`, "i").test(corpus));
  if (groupOps.length) items.add(`Group operators: ${groupOps.join(", ")}`);
  const conditionOps = RULE_OPERATOR_NAMES.filter(op => new RegExp(`\`${op}\`|\\b${op}\\b`, "i").test(corpus));
  if (conditionOps.length) items.add(`Condition operators: ${conditionOps.slice(0, 12).join(", ")}${conditionOps.length > 12 ? "..." : ""}`);
  if (/dot[\s-]?separated path|field.*a\.b\.c|field path/i.test(corpus)) items.add("Dot-path field lookup into data payloads");
  if (/numeric comparisons|date\/time comparisons|ISO.?8601/i.test(corpus)) items.add("Numeric and ISO-8601 date/time comparisons");
  return Array.from(items);
}

function inferContractArchitectureItems(corpus: string): string[] {
  const items = new Set<string>();
  if (/"data"\s*:|Request Schema[\s\S]{0,500}\bdata\b/i.test(corpus)) items.add("Request body includes data object");
  if (/"rule"\s*:|Request Schema[\s\S]{0,500}\brule\b/i.test(corpus)) items.add("Request body includes rule definition");
  if (/"result"\s*:|Response Schema[\s\S]{0,300}\bresult\b/i.test(corpus)) items.add("Response returns result boolean");
  if (/400 Bad Request/i.test(corpus)) items.add("400 for structurally invalid rules");
  if (/422 Unprocessable Entity/i.test(corpus)) items.add("422 for invalid request fields");
  return Array.from(items);
}

const RULE_OPERATOR_NAMES = ["eq", "ne", "lt", "lte", "gt", "gte", "between", "in", "contains", "regex", "exists", "not_exists", "isNull", "isNotNull"];

function countDomainOperators(corpus: string): number {
  return ["all", "any", "not", ...RULE_OPERATOR_NAMES]
    .filter(op => new RegExp(`\`${op}\`|\\b${op}\\b`, "i").test(corpus)).length;
}

function buildInferredApplicationGraphMermaid(
  capabilityName: string,
  endpoints: string[],
  frameworks: string[],
  domainItems: string[],
): string {
  const endpoint = endpoints.find(item => /^(GET|POST|PUT|DELETE|PATCH|ANY)\s+\//i.test(item)) ?? "API endpoint";
  const stack = frameworks.slice(0, 3).join(" / ") || "Runtime";
  const domain = domainItems[0] ?? "Domain logic";
  return [
    "flowchart LR",
    `  Story["Story / WorkItem"] --> API["${escapeMermaid(endpoint)}"]`,
    `  API --> App["${escapeMermaid(capabilityName)}"]`,
    `  App --> Runtime["${escapeMermaid(stack)}"]`,
    `  Runtime --> Domain["${escapeMermaid(domain)}"]`,
    "  Domain --> Evidence[\"Stage artifacts / receipts / approvals\"]",
  ].join("\n");
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function buildPortfolioCodeGraphMermaid(capabilityName: string, profiles: RepositoryProfile[]): string {
  const nodes = profiles.slice(0, 8).map((profile, index) => {
    const tech = profile.frameworks[0] ?? profile.languages[0]?.language ?? "unknown";
    return `  R${index + 1}["${escapeMermaid(`${profile.repoName} / ${tech} / ${profile.endpointCount} endpoints`)}"]`;
  });
  const edges = profiles.slice(0, 8).map((_, index) => `  C --> R${index + 1}`);
  return [
    "flowchart TB",
    `  C["${escapeMermaid(capabilityName)} collection"]`,
    ...nodes,
    ...edges,
  ].join("\n");
}

function isCollectionCapabilityType(value?: string | null): boolean {
  const type = (value ?? "").trim().toUpperCase();
  return ["COLLECTION", "CAPABILITY_COLLECTION", "PORTFOLIO", "DOMAIN_COLLECTION"].includes(type);
}

function escapeMermaid(value: string): string {
  return value.replace(/[<>{}[\]|"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

async function learningWorkerSnapshot(capabilityId: string) {
  const [
    repositories,
    knowledgeSources,
    activeKnowledge,
    pendingLearning,
    materializedLearning,
    rejectedLearning,
    codeSymbols,
    distilledMemory,
    bootstrapRuns,
  ] = await Promise.all([
    prisma.capabilityRepository.count({ where: { capabilityId, status: "ACTIVE" } }),
    prisma.capabilityKnowledgeSource.count({ where: { capabilityId, status: "ACTIVE" } }),
    prisma.capabilityKnowledgeArtifact.count({ where: { capabilityId, status: "ACTIVE" } }),
    prisma.capabilityLearningCandidate.count({ where: { capabilityId, status: "PENDING" } }),
    prisma.capabilityLearningCandidate.count({ where: { capabilityId, status: "MATERIALIZED" } }),
    prisma.capabilityLearningCandidate.count({ where: { capabilityId, status: "REJECTED" } }),
    prisma.capabilityCodeSymbol.count({ where: { capabilityId } }),
    prisma.distilledMemory.count({ where: { scopeType: "CAPABILITY", scopeId: capabilityId, status: "ACTIVE" } }),
    prisma.capabilityBootstrapRun.count({ where: { capabilityId } }),
  ]);

  return {
    repositories: { active: repositories },
    knowledgeSources: { active: knowledgeSources },
    knowledge: { active: activeKnowledge },
    learning: {
      pending: pendingLearning,
      materialized: materializedLearning,
      rejected: rejectedLearning,
    },
    codeSymbols: { total: codeSymbols },
    distilledMemory: { active: distilledMemory },
    bootstrapRuns: { total: bootstrapRuns },
  };
}

function formatCandidateContent(title: string, docs: DiscoveryDoc[]): string {
  const parts = [`# ${title}`];
  let chars = parts[0].length;
  for (const doc of docs) {
    const snippet = doc.content.trim().slice(0, 5_000);
    const next = `\n\n## Source: ${doc.title}\n${snippet}`;
    if (chars + next.length > 24_000) break;
    parts.push(next);
    chars += next.length;
  }
  return parts.join("");
}

function buildOperatingModel(
  capability: { name: string; appId?: string | null; capabilityType?: string | null },
  targetWorkflowPattern: string | undefined,
  generatedAgents: Array<{
    id: string;
    key?: string;
    roleType: string;
    bindingRole?: string;
    label?: string;
    name: string;
    baseTemplateId?: string | null;
    bindingId?: string;
    locked?: boolean;
    activationRequired?: boolean;
    learnsFromGit?: boolean;
    grounding?: string;
  }>,
  candidateGroups: number,
  architectureDiagram?: CapabilityArchitectureDiagram,
  repositoryProfiles: RepositoryProfile[] = [],
  collectionModel: { childCapabilityIds?: string[]; sharedApplications?: string[] } = {},
) {
  const capabilityName = capability.name;
  const pattern = (targetWorkflowPattern?.trim() || "governed_delivery").toLowerCase();
  const starterWorkflow = pattern.includes("support")
    ? "Intake -> Product Owner triage -> Developer fix plan -> QA proof -> Human approval -> Handoff"
    : pattern.includes("security")
      ? "Intake -> Architect scope -> Security review -> Developer remediation -> QA verification -> Human approval"
      : "Intake -> Architect plan -> Developer implementation -> QA proof -> Security review -> DevOps release note -> Human approval";
  return {
    name: `${capabilityName} operating model`,
    appId: capability.appId ?? null,
    capabilityType: capability.capabilityType ?? null,
    targetWorkflowPattern: pattern,
    starterWorkflow,
    architectureDiagram,
    repositoryProfiles,
    childCapabilityIds: collectionModel.childCapabilityIds ?? [],
    sharedApplications: collectionModel.sharedApplications ?? [],
    draftAgents: generatedAgents.map(agent => ({
      id: agent.id,
      key: agent.key,
      roleType: agent.roleType,
      bindingRole: agent.bindingRole ?? agent.roleType,
      label: agent.label ?? agent.roleType,
      name: agent.name,
      bindingId: agent.bindingId,
      locked: agent.locked === true,
      activationRequired: agent.activationRequired === true,
      learnsFromGit: agent.learnsFromGit === true,
      grounding: agent.grounding,
      activation: agent.activationRequired ? "required during review" : "requires human review",
    })),
    suggestedTools: [
      { name: "repo.search", reason: "Locate code and docs without full-file prompt payloads.", status: "suggested" },
      { name: "workbench.create_artifact", reason: "Capture architecture, implementation, QA, and release evidence as versioned artifacts.", status: "suggested" },
      { name: "approval.request", reason: "Pause after major artifact production before downstream promotion.", status: "suggested" },
    ],
    artifactContracts: [
      "architecture_decision",
      "implementation_plan",
      "code_patch",
      "qa_proof",
      "security_review",
      "release_note",
      "final_handoff",
    ],
    approvalGates: [
      "Activate generated agents",
      "Locked Governance / Verifier / Security gates must stay enabled",
      "Materialize learned knowledge",
      "Promote major artifacts",
      "Approve budget/tool pauses",
    ],
    learningReview: {
      candidateGroups,
      runtimeVisibleAfterApproval: true,
    },
  };
}

function deterministicSymbolSummary(symbol: {
  symbolName: string;
  symbolType: string;
  language?: string;
  filePath: string;
  startLine?: number;
}): string {
  const location = `${symbol.filePath}${symbol.startLine ? `:${symbol.startLine}` : ""}`;
  return `${symbol.symbolType} ${symbol.symbolName} in ${symbol.language ?? "source"} at ${location}. Deterministic summary generated from symbol metadata; enable ENABLE_LLM_SYMBOL_SUMMARIES=1 for richer summaries.`;
}

async function ensureDefaultGovernanceLimits(capabilityId: string): Promise<string | undefined> {
  const baseUrl = (process.env.AUDIT_GOV_URL ?? process.env.AUDIT_GOVERNANCE_URL ?? "http://localhost:8500").replace(/\/$/, "");
  const tokensMax = env.CAPABILITY_DEFAULT_DAILY_TOKENS;
  const costMaxUsd = env.CAPABILITY_DEFAULT_DAILY_COST_USD;
  const maxCalls = env.CAPABILITY_DEFAULT_RATE_LIMIT_PER_MINUTE;
  // audit-gov requires the service bearer on writes — without it these POSTs 401.
  // Mirrors src/lib/audit-gov-emit.ts. (The token must also be passed to this
  // service at boot; see bin/bare-metal.sh agent-runtime.)
  const serviceToken = process.env.AUDIT_GOV_SERVICE_TOKEN ?? "";
  const headers: Record<string, string> = serviceToken
    ? { "content-type": "application/json", authorization: `Bearer ${serviceToken}` }
    : { "content-type": "application/json" };
  try {
    const [budgetRes, rateRes] = await Promise.all([
      fetch(`${baseUrl}/api/v1/governance/budgets`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          scope_type: "capability",
          scope_id: capabilityId,
          period: "day",
          tokens_max: Number.isFinite(tokensMax) && tokensMax > 0 ? Math.floor(tokensMax) : null,
          cost_max_usd: Number.isFinite(costMaxUsd) && costMaxUsd >= 0 ? costMaxUsd : null,
        }),
        signal: AbortSignal.timeout(AGENT_GOVERNANCE_LIMITS_TIMEOUT_MS),
      }),
      fetch(`${baseUrl}/api/v1/governance/rate-limits`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          scope_type: "capability",
          scope_id: capabilityId,
          period_seconds: 60,
          max_calls: Number.isFinite(maxCalls) && maxCalls > 0 ? Math.floor(maxCalls) : 30,
        }),
        signal: AbortSignal.timeout(AGENT_GOVERNANCE_LIMITS_TIMEOUT_MS),
      }),
    ]);
    if (!budgetRes.ok || !rateRes.ok) {
      return `Default governance budget/rate-limit returned HTTP ${budgetRes.status}/${rateRes.status}`;
    }
  } catch (err) {
    return `Default governance budget/rate-limit was not created: ${(err as Error).message}`;
  }
  return undefined;
}

function extractMarkdownTitle(md: string): string | undefined {
  const found = md.match(/^#\s+(.+)$/m);
  return found?.[1]?.trim().slice(0, 200);
}

function isApprovedSource(approved: Array<{ sourceRef: string | null; sourceType: string | null }>, sourceRef: string): boolean {
  const expected = normalizedSourceValue(sourceRef).toLowerCase();
  if (!expected) return false;
  return approved.some(item => {
    const actual = normalizedSourceValue(item.sourceRef).toLowerCase();
    if (!actual) return false;
    return actual === expected || actual.includes(expected) || expected.includes(actual);
  });
}

type CapabilityRepositorySourceInput = {
  repoName: string;
  repoUrl: string;
  defaultBranch?: string | null;
  repositoryType?: string | null;
  pollIntervalSec?: number | null;
};

type CapabilityKnowledgeSourceInput = {
  url: string;
  artifactType?: string | null;
  title?: string | null;
  pollIntervalSec?: number | null;
};

async function persistCapabilityRepositorySource(
  capabilityId: string,
  input: CapabilityRepositorySourceInput,
) {
  const repoUrl = normalizedSourceValue(input.repoUrl);
  const defaultBranch = normalizedRepositoryBranch(input.defaultBranch);
  const repositoryType = normalizedRepositoryType(input.repositoryType);
  const sourceKey = capabilityRepositorySourceKey({ capabilityId, repoUrl, defaultBranch, repositoryType });
  if (!sourceKey) throw new Error("Repository URL is required.");

  return prisma.$transaction(async (tx) => {
    await assertActiveCapabilityForWrite(tx, capabilityId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sourceKey}))`;
    const existing = await findActiveRepositorySource(tx, { capabilityId, repoUrl, defaultBranch, repositoryType });
    if (!existing) {
      return tx.capabilityRepository.create({
        data: {
          capabilityId,
          repoName: input.repoName,
          repoUrl,
          defaultBranch,
          repositoryType,
          pollIntervalSec: input.pollIntervalSec === undefined ? null : input.pollIntervalSec,
          status: "ACTIVE",
        },
      });
    }

    const next: Prisma.CapabilityRepositoryUpdateInput = {};
    if (input.repoName && input.repoName !== existing.repoName) next.repoName = input.repoName;
    if (existing.repoUrl !== repoUrl) next.repoUrl = repoUrl;
    if ((existing.defaultBranch ?? "main") !== defaultBranch) next.defaultBranch = defaultBranch;
    if ((existing.repositoryType ?? "GITHUB") !== repositoryType) next.repositoryType = repositoryType;
    if (input.pollIntervalSec !== undefined && existing.pollIntervalSec !== input.pollIntervalSec) {
      next.pollIntervalSec = input.pollIntervalSec;
    }
    if (Object.keys(next).length === 0) return existing;
    return tx.capabilityRepository.update({ where: { id: existing.id }, data: next });
  });
}

async function persistCapabilityKnowledgeSource(
  capabilityId: string,
  input: CapabilityKnowledgeSourceInput,
) {
  const url = normalizedSourceValue(input.url);
  const artifactType = normalizedKnowledgeArtifactType(input.artifactType);
  const sourceKey = capabilityKnowledgeSourceKey({ capabilityId, url, artifactType });
  if (!sourceKey) throw new Error("Knowledge source URL is required.");

  return prisma.$transaction(async (tx) => {
    await assertActiveCapabilityForWrite(tx, capabilityId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sourceKey}))`;
    const existing = await findActiveKnowledgeSource(tx, { capabilityId, url, artifactType });
    if (!existing) {
      return tx.capabilityKnowledgeSource.create({
        data: {
          capabilityId,
          url,
          artifactType,
          title: input.title ?? undefined,
          pollIntervalSec: input.pollIntervalSec === undefined ? 600 : input.pollIntervalSec,
          status: "ACTIVE",
        },
      });
    }

    const next: Prisma.CapabilityKnowledgeSourceUpdateInput = {};
    if (existing.url !== url) next.url = url;
    if (existing.artifactType !== artifactType) next.artifactType = artifactType;
    if (input.title !== undefined && existing.title !== input.title) next.title = input.title;
    if (input.pollIntervalSec !== undefined && existing.pollIntervalSec !== input.pollIntervalSec) {
      next.pollIntervalSec = input.pollIntervalSec;
    }
    if (Object.keys(next).length === 0) return existing;
    return tx.capabilityKnowledgeSource.update({ where: { id: existing.id }, data: next });
  });
}

type CapabilityKnowledgeArtifactWriteInput = {
  artifactType: string;
  title: string;
  content: string;
  sourceType?: string | null;
  sourceRef?: string | null;
  confidence?: number | null;
};

async function persistCapabilityCodeSymbol(input: Prisma.CapabilityCodeSymbolUncheckedCreateInput) {
  const symbolKey = capabilityCodeSymbolKey({
    repositoryId: input.repositoryId,
    symbolHash: input.symbolHash,
  });
  if (!symbolKey) throw new Error("Capability code symbol identity is incomplete.");

  return prisma.$transaction(async (tx) => {
    await assertActiveCapabilityForWrite(tx, String(input.capabilityId ?? ""), "Cannot record code symbols for an archived capability.");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${symbolKey}))`;
    const existing = await tx.capabilityCodeSymbol.findFirst({
      where: {
        repositoryId: input.repositoryId,
        symbolHash: input.symbolHash,
      },
      select: { id: true },
    });
    if (existing) return { symbol: existing, created: false };

    const symbol = await tx.capabilityCodeSymbol.create({ data: input });
    return { symbol, created: true };
  });
}

async function persistCapabilityLearningCandidate(input: Prisma.CapabilityLearningCandidateUncheckedCreateInput) {
  const capabilityId = normalizedLearningCandidateIdentityValue(input.capabilityId);
  const groupKey = normalizedLearningCandidateIdentityValue(input.groupKey);
  const artifactType = normalizedLearningCandidateIdentityValue(input.artifactType);
  const title = normalizedLearningCandidateIdentityValue(input.title);
  const content = String(input.content ?? "");
  const sourceType = normalizedLearningCandidateIdentityValue(input.sourceType as string | null | undefined);
  const sourceRef = normalizedLearningCandidateIdentityValue(input.sourceRef as string | null | undefined);
  const candidateKey = capabilityLearningCandidateKey({
    capabilityId,
    groupKey,
    artifactType,
    title,
    content,
    sourceType,
    sourceRef,
  });
  if (!candidateKey) throw new Error("Capability learning candidate identity is incomplete.");

  return prisma.$transaction(async (tx) => {
    await assertActiveCapabilityForWrite(tx, capabilityId, "Cannot record learning candidate for an archived capability.");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${candidateKey}))`;
    const existingRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM "CapabilityLearningCandidate"
      WHERE "capabilityId" = ${capabilityId}
        AND status <> 'SUPERSEDED'
        AND lower(btrim("groupKey")) = lower(btrim(${groupKey}))
        AND lower(btrim("artifactType")) = lower(btrim(${artifactType}))
        AND lower(btrim(title)) = lower(btrim(${title}))
        AND lower(btrim(coalesce("sourceType", ''))) = lower(btrim(${sourceType}))
        AND lower(btrim(coalesce("sourceRef", ''))) = lower(btrim(${sourceRef}))
        AND content = ${content}
      ORDER BY
        CASE status
          WHEN 'MATERIALIZED' THEN 0
          WHEN 'REJECTED' THEN 1
          WHEN 'PENDING' THEN 2
          ELSE 3
        END,
        "updatedAt" DESC,
        "createdAt" DESC
      LIMIT 1
    `);
    const existingId = existingRows[0]?.id;
    if (!existingId) {
      return tx.capabilityLearningCandidate.create({
        data: {
          ...input,
          capabilityId,
          groupKey,
          artifactType,
          title,
          content,
          sourceType,
          sourceRef,
        },
      });
    }

    const existing = await tx.capabilityLearningCandidate.findUniqueOrThrow({ where: { id: existingId } });
    if (existing.status !== "PENDING") return existing;

    const next: Prisma.CapabilityLearningCandidateUncheckedUpdateInput = {};
    if (input.bootstrapRunId !== undefined && !existing.bootstrapRunId) {
      next.bootstrapRunId = input.bootstrapRunId;
    }
    if (input.groupTitle !== undefined && existing.groupTitle !== input.groupTitle) next.groupTitle = input.groupTitle;
    if (input.confidence !== undefined && String(existing.confidence ?? "") !== String(input.confidence ?? "")) {
      next.confidence = input.confidence;
    }
    if (Object.keys(next).length === 0) return existing;
    return tx.capabilityLearningCandidate.update({ where: { id: existing.id }, data: next });
  });
}

async function materializeBootstrapLearningCandidate(
  capabilityId: string,
  candidate: {
    id: string;
    artifactType: string;
    title: string;
    content: string;
    sourceType: string | null;
    sourceRef: string | null;
    confidence: Prisma.Decimal | number | string | null;
  },
  userId?: string,
) {
  const artifactInput: CapabilityKnowledgeArtifactWriteInput = {
    artifactType: candidate.artifactType,
    title: candidate.title,
    content: candidate.content,
    sourceType: `BOOTSTRAP_${candidate.sourceType ?? "DISCOVERY"}`,
    sourceRef: candidate.sourceRef ?? undefined,
    confidence: candidate.confidence ? Number(candidate.confidence) : 0.8,
  };

  const materialized = await prisma.$transaction(async (tx) => {
    await assertActiveCapabilityForWrite(tx, capabilityId, "Cannot materialize learning for an archived capability.");
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; materializedArtifactId: string | null }>>(Prisma.sql`
      SELECT id, status, "materializedArtifactId"
      FROM "CapabilityLearningCandidate"
      WHERE id = ${candidate.id}
        AND "capabilityId" = ${capabilityId}
      LIMIT 1
      FOR UPDATE
    `);
    const current = rows[0];
    if (!current) throw new NotFoundError("Capability learning candidate not found");
    if (current.status !== "PENDING") return null;

    const { artifact, contentHash } = await persistKnowledgeArtifactWithClient(tx, capabilityId, artifactInput, {
      assumeCapabilityLocked: true,
    });
    await tx.capabilityLearningCandidate.update({
      where: { id: candidate.id },
      data: {
        status: "MATERIALIZED",
        materializedArtifactId: artifact.id,
        reviewedBy: userId,
        reviewedAt: new Date(),
      },
    });
    return { artifact, contentHash };
  });

  if (!materialized) return null;
  await ensureKnowledgeEmbedding({
    artifactId: materialized.artifact.id,
    title: artifactInput.title,
    content: artifactInput.content,
    contentHash: materialized.contentHash,
  });
  return materialized.artifact;
}

async function persistCapabilityAgentTemplate(input: Prisma.AgentTemplateUncheckedCreateInput) {
  const capabilityId = String(input.capabilityId ?? "").trim();
  const name = normalizedAgentTemplateName(input.name);
  const templateKey = capabilityAgentTemplateKey({ capabilityId, name });
  if (!templateKey) throw new Error("Capability and agent template name are required.");

  return prisma.$transaction(async (tx) => {
    await assertActiveCapabilityForWrite(tx, capabilityId, "Cannot persist agent template for an archived capability.");
    if (input.defaultToolPolicyId) {
      await assertActiveToolPolicyReference(tx, {
        policyId: input.defaultToolPolicyId,
        capabilityId,
        context: "agent template default tool policy",
      });
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${templateKey}))`;
    const existingRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM "AgentTemplate"
      WHERE "capabilityId" = ${capabilityId}
        AND status <> 'ARCHIVED'
        AND lower(btrim(name)) = lower(btrim(${name}))
      ORDER BY "updatedAt" DESC, "createdAt" DESC
      LIMIT 1
    `);
    const existingId = existingRows[0]?.id;
    if (!existingId) {
      return tx.agentTemplate.create({
        data: {
          ...input,
          name,
          capabilityId,
        },
      });
    }

    const existing = await tx.agentTemplate.findUniqueOrThrow({ where: { id: existingId } });
    if (input.defaultToolPolicyId) {
      await assertActiveToolPolicyReference(tx, {
        policyId: input.defaultToolPolicyId,
        capabilityId,
        agentTemplateId: existing.id,
        context: "agent template default tool policy",
      });
    }
    const next: Prisma.AgentTemplateUncheckedUpdateInput = {};
    if (existing.name !== name) next.name = name;
    if (input.roleType !== undefined && existing.roleType !== input.roleType) next.roleType = input.roleType;
    if (input.description !== undefined && !existing.description && input.description !== existing.description) {
      next.description = input.description;
    }
    if (input.basePromptProfileId !== undefined && input.basePromptProfileId && existing.basePromptProfileId !== input.basePromptProfileId) {
      next.basePromptProfileId = input.basePromptProfileId;
    }
    if (input.defaultToolPolicyId !== undefined && input.defaultToolPolicyId && existing.defaultToolPolicyId !== input.defaultToolPolicyId) {
      next.defaultToolPolicyId = input.defaultToolPolicyId;
    }
    if (input.baseTemplateId !== undefined && input.baseTemplateId && existing.baseTemplateId !== input.baseTemplateId) {
      next.baseTemplateId = input.baseTemplateId;
    }
    if (input.lockedReason !== undefined && input.lockedReason && existing.lockedReason !== input.lockedReason) {
      next.lockedReason = input.lockedReason;
    }
    if (input.status !== undefined && existing.status !== "ACTIVE" && existing.status !== input.status) {
      next.status = input.status;
    }
    if (Object.keys(next).length === 0) return existing;
    return tx.agentTemplate.update({ where: { id: existing.id }, data: next });
  });
}

async function persistAgentCapabilityBinding(input: Prisma.AgentCapabilityBindingUncheckedCreateInput) {
  const bindingKey = capabilityAgentBindingKey({
    capabilityId: input.capabilityId,
    agentTemplateId: input.agentTemplateId,
  });
  if (!bindingKey) throw new Error("Capability and agent template are required for binding.");

  return prisma.$transaction(async (tx) => {
    await assertActiveCapabilityForWrite(tx, String(input.capabilityId ?? ""), "Cannot persist agent binding for an archived capability.");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${bindingKey}))`;
    const existing = await tx.agentCapabilityBinding.findFirst({
      where: {
        capabilityId: input.capabilityId,
        agentTemplateId: input.agentTemplateId,
        status: { not: "ARCHIVED" },
      },
      orderBy: { updatedAt: "desc" },
    });
    await assertAgentBindingPolicyReferences(tx, input, existing?.id);
    if (!existing) return tx.agentCapabilityBinding.create({ data: input });

    const next: Prisma.AgentCapabilityBindingUpdateInput = {};
    if (input.bindingName && input.bindingName !== existing.bindingName) next.bindingName = input.bindingName;
    if (input.roleInCapability !== undefined && input.roleInCapability !== existing.roleInCapability) {
      next.roleInCapability = input.roleInCapability;
    }
    if (input.promptProfileId !== undefined && input.promptProfileId !== existing.promptProfileId) {
      next.promptProfileId = input.promptProfileId;
    }
    if (input.toolPolicyId !== undefined && input.toolPolicyId !== existing.toolPolicyId) {
      next.toolPolicyId = input.toolPolicyId;
    }
    if (input.memoryScopePolicyId !== undefined && input.memoryScopePolicyId !== existing.memoryScopePolicyId) {
      next.memoryScopePolicyId = input.memoryScopePolicyId;
    }
    if (input.status !== undefined && input.status !== existing.status) next.status = input.status;
    if (Object.keys(next).length === 0) return existing;
    return tx.agentCapabilityBinding.update({ where: { id: existing.id }, data: next });
  });
}

async function ensureCodeSymbolEmbedding(input: {
  symbolId: string;
  symbolName: string | null;
  summary?: string | null;
  embedder: ReturnType<typeof getEmbeddingProvider>;
}): Promise<boolean> {
  const symbolId = normalizedCodeEmbeddingValue(input.symbolId);
  const embeddingKey = capabilityCodeEmbeddingKey({ symbolId });
  if (!embeddingKey) throw new Error("Capability code embedding identity is incomplete.");

  const probe = await prisma.$queryRawUnsafe<Array<{ capabilityStatus: string; hasEmbedding: boolean }>>(
    `SELECT c.status AS "capabilityStatus",
            EXISTS(
              SELECT 1 FROM "CapabilityCodeEmbedding" e
              WHERE e."symbolId" = s.id AND e.embedding IS NOT NULL
            ) AS "hasEmbedding"
     FROM "CapabilityCodeSymbol" s
     JOIN "Capability" c ON c.id = s."capabilityId"
     WHERE s.id = $1`,
    symbolId,
  );
  if (!probe[0] || probe[0].capabilityStatus === "ARCHIVED" || probe[0].hasEmbedding) return false;

  const embedTarget = `${input.symbolName ?? ""}\n${input.summary ?? ""}`.trim() || "symbol";
  const embedded = await input.embedder.embed({ text: embedTarget });
  assertDimMatches(embedded.dim, `${embedded.provider}:${embedded.model}`);
  const embeddingModel = `${embedded.provider}:${embedded.model}:${embedded.dim}`;
  const vectorId = JSON.stringify(embedded.vector);
  const vectorLiteral = toVectorLiteral(embedded.vector);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${embeddingKey}))`;
    const activeRows = await tx.$queryRaw<Array<{ capabilityStatus: string }>>(Prisma.sql`
      SELECT c.status AS "capabilityStatus"
      FROM "CapabilityCodeSymbol" s
      JOIN "Capability" c ON c.id = s."capabilityId"
      WHERE s.id = ${symbolId}
      FOR UPDATE OF c
    `);
    if (!activeRows[0] || activeRows[0].capabilityStatus === "ARCHIVED") return false;

    const existingRows = await tx.$queryRaw<Array<{ id: string; hasEmbedding: boolean }>>(Prisma.sql`
      SELECT id, embedding IS NOT NULL AS "hasEmbedding"
      FROM "CapabilityCodeEmbedding"
      WHERE "symbolId" = ${symbolId}
      ORDER BY "createdAt" DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `);
    const existing = existingRows[0];
    if (existing?.hasEmbedding) return false;

    const row = existing
      ? await tx.capabilityCodeEmbedding.update({
          where: { id: existing.id },
          data: {
            embeddingModel,
            vectorId,
            summary: input.summary ?? null,
          },
        })
      : await tx.capabilityCodeEmbedding.create({
          data: {
            symbolId,
            embeddingModel,
            vectorId,
            summary: input.summary ?? null,
          },
        });

    const updated = await tx.$executeRawUnsafe(
      `UPDATE "CapabilityCodeEmbedding" target
       SET embedding = $1::vector
       WHERE target.id = $2
         AND EXISTS (
           SELECT 1
           FROM "CapabilityCodeSymbol" s
           JOIN "Capability" c ON c.id = s."capabilityId"
           WHERE s.id = target."symbolId"
             AND c.status <> 'ARCHIVED'
         )`,
      vectorLiteral,
      row.id,
    );
    return updated > 0;
  });
}

async function persistKnowledgeArtifact(
  capabilityId: string,
  input: CapabilityKnowledgeArtifactWriteInput,
) {
  return prisma.$transaction((tx) => persistKnowledgeArtifactWithClient(tx, capabilityId, input));
}

async function persistKnowledgeArtifactWithClient(
  client: CapabilityDbClient,
  capabilityId: string,
  input: CapabilityKnowledgeArtifactWriteInput,
  options: { assumeCapabilityLocked?: boolean; archivedMessage?: string } = {},
) {
  if (!options.assumeCapabilityLocked) {
    await assertActiveCapabilityForWrite(client, capabilityId, options.archivedMessage);
  }

  const contentHash = sha256(input.content);
  const artifactType = input.artifactType.trim() || input.artifactType;
  const title = input.title.trim() || input.title;
  const sourceType = input.sourceType?.trim() || null;
  const sourceRef = input.sourceRef?.trim() || null;
  const sourceKey = sourceBackedKnowledgeArtifactKey({
    capabilityId,
    artifactType,
    title,
    sourceType,
    sourceRef,
  });

  if (sourceKey) {
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sourceKey}))`;
  }

  const existingRows = sourceKey
    ? await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM "CapabilityKnowledgeArtifact"
        WHERE status = 'ACTIVE'
          AND "capabilityId" = ${capabilityId}
          AND lower(btrim("artifactType")) = lower(${artifactType})
          AND lower(btrim("title")) = lower(${title})
          AND lower(COALESCE(NULLIF(btrim("sourceType"), ''), '')) = lower(${sourceType ?? ""})
          AND lower(btrim("sourceRef")) = lower(${sourceRef ?? ""})
        ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
        LIMIT 1
      `)
    : [];
  const existing = existingRows[0]
    ? await client.capabilityKnowledgeArtifact.findUnique({ where: { id: existingRows[0].id } })
    : null;

  if (!existing) {
    const artifact = await client.capabilityKnowledgeArtifact.create({
      data: {
        capabilityId,
        artifactType,
        title,
        content: input.content,
        sourceType,
        sourceRef,
        confidence: input.confidence ?? undefined,
        contentHash,
        status: "ACTIVE",
      },
    });
    return { artifact, contentHash };
  }

  const confidenceChanged = String(existing.confidence ?? "") !== String(input.confidence ?? "");
  const contentChanged = existing.contentHash !== contentHash || existing.content !== input.content;
  const metadataChanged = existing.sourceType !== sourceType || existing.sourceRef !== sourceRef || confidenceChanged;
  if (!contentChanged && !metadataChanged) return { artifact: existing, contentHash };

  const artifact = await client.capabilityKnowledgeArtifact.update({
    where: { id: existing.id },
    data: {
      content: input.content,
      sourceType,
      sourceRef,
      confidence: input.confidence ?? undefined,
      contentHash,
      ...(contentChanged ? { version: { increment: 1 } } : {}),
    },
  });
  if (contentChanged) {
    await client.$executeRaw`UPDATE "CapabilityKnowledgeArtifact" SET embedding = NULL WHERE id = ${artifact.id}`;
  }

  return { artifact, contentHash };
}

async function assertActiveCapabilityForWrite(
  client: CapabilityDbClient,
  capabilityId: string,
  message = "Capability is archived and cannot be modified.",
): Promise<void> {
  const rows = await client.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    SELECT status
    FROM "Capability"
    WHERE id = ${capabilityId}
    FOR UPDATE
  `);
  const capability = rows[0];
  if (!capability) throw new NotFoundError("Capability not found");
  if (capability.status === "ARCHIVED") throw new ForbiddenError(message);
}

async function assertActiveToolPolicyReference(
  client: CapabilityDbClient,
  input: {
    policyId: string;
    capabilityId: string;
    agentTemplateId?: string | null;
    agentBindingId?: string | null;
    context: string;
  },
): Promise<void> {
  const rows = await client.$queryRaw<Array<{ status: string; scopeType: string | null; scopeId: string | null }>>(Prisma.sql`
    SELECT status, "scopeType" AS "scopeType", "scopeId" AS "scopeId"
    FROM "ToolPolicy"
    WHERE id = ${input.policyId}
    FOR UPDATE
  `);
  const policy = rows[0];
  if (!policy) throw new NotFoundError("Tool policy not found");
  if (policy.status !== "ACTIVE") {
    throw new ConflictError(`Tool policy is ${policy.status} and cannot be used as ${input.context}.`);
  }

  const scopeType = policy.scopeType?.trim().toUpperCase();
  if (!scopeType || !policy.scopeId) return;

  if (scopeType === "CAPABILITY") {
    if (policy.scopeId !== input.capabilityId) {
      throw new ForbiddenError(`Tool policy scope belongs to another capability and cannot be used as ${input.context}.`);
    }
    return;
  }

  if (scopeType === "AGENT_TEMPLATE") {
    if (!input.agentTemplateId || policy.scopeId !== input.agentTemplateId) {
      throw new ForbiddenError(`Tool policy scope belongs to another agent template and cannot be used as ${input.context}.`);
    }
    return;
  }

  if (scopeType === "AGENT_BINDING") {
    if (!input.agentBindingId || policy.scopeId !== input.agentBindingId) {
      throw new ForbiddenError(`Tool policy scope belongs to another agent binding and cannot be used as ${input.context}.`);
    }
  }
}

async function assertAgentBindingPolicyReferences(
  client: CapabilityDbClient,
  input: Prisma.AgentCapabilityBindingUncheckedCreateInput,
  existingBindingId?: string,
): Promise<void> {
  const capabilityId = String(input.capabilityId ?? "");
  const agentTemplateId = String(input.agentTemplateId ?? "");
  if (input.toolPolicyId) {
    await assertActiveToolPolicyReference(client, {
      policyId: input.toolPolicyId,
      capabilityId,
      agentTemplateId,
      agentBindingId: existingBindingId,
      context: "agent binding tool policy",
    });
  }
  if (input.memoryScopePolicyId) {
    await assertActiveToolPolicyReference(client, {
      policyId: input.memoryScopePolicyId,
      capabilityId,
      agentTemplateId,
      agentBindingId: existingBindingId,
      context: "agent binding memory scope policy",
    });
  }
}

async function ensureKnowledgeEmbedding(input: {
  artifactId: string;
  title: string;
  content: string;
  contentHash: string;
}) {
  try {
    const embeddedRows = await prisma.$queryRaw<Array<{ hasEmbedding: boolean }>>`
      SELECT embedding IS NOT NULL AS "hasEmbedding"
      FROM "CapabilityKnowledgeArtifact"
      WHERE id = ${input.artifactId}
      LIMIT 1
    `;
    if (embeddedRows[0]?.hasEmbedding) return;

    const reused = await prisma.$executeRawUnsafe(
      `UPDATE "CapabilityKnowledgeArtifact" target
       SET embedding = source.embedding
       FROM (
         SELECT embedding FROM "CapabilityKnowledgeArtifact"
         WHERE "contentHash" = $1 AND id <> $2 AND embedding IS NOT NULL
         ORDER BY "createdAt" DESC
         LIMIT 1
       ) source
       WHERE target.id = $2
         AND target.status = 'ACTIVE'
         AND target.embedding IS NULL
         AND EXISTS (
           SELECT 1
           FROM "Capability" c
           WHERE c.id = target."capabilityId"
             AND c.status <> 'ARCHIVED'
         )`,
      input.contentHash,
      input.artifactId,
    );
    if (reused > 0) return;

    const embedder = getEmbeddingProvider();
    const embedTarget = `${input.title}\n${input.content}`.slice(0, 8_000);
    const embedded = await embedder.embed({ text: embedTarget });
    assertDimMatches(embedded.dim, `${embedded.provider}:${embedded.model}`);
    await prisma.$executeRawUnsafe(
      `UPDATE "CapabilityKnowledgeArtifact" target
       SET embedding = $1::vector
       WHERE target.id = $2
         AND target.status = 'ACTIVE'
         AND EXISTS (
           SELECT 1
           FROM "Capability" c
           WHERE c.id = target."capabilityId"
             AND c.status <> 'ARCHIVED'
         )`,
      toVectorLiteral(embedded.vector),
      input.artifactId,
    );
  } catch (err) {
    // Fail-loud: the artifact stays persisted with a NULL vector, so it is
    // INVISIBLE to semantic retrieval (silently degrades to keyword/recency).
    // Surfaced on grounding-status as embeddingCoverage.degraded with a
    // /embeddings/reembed fixCommand; common root cause is the default model
    // alias resolving to a provider with no embeddings endpoint.
    // eslint-disable-next-line no-console
    console.warn(
      `[knowledge] EMBEDDING FAILED artifact=${input.artifactId} — left unembedded, ` +
        `semantic retrieval degraded (run the grounding-status fixCommand to backfill): ${(err as Error).message}`,
    );
  }
}

async function learningSourceState(capabilityId: string): Promise<{
  activeSourceCount: number;
  activeRepositoryCount: number;
  activeKnowledgeSourceCount: number;
  sourceFingerprint: string;
  sources: Array<{ kind: string; ref: string; branch?: string | null; label?: string | null }>;
}> {
  const [repositories, knowledgeSources] = await Promise.all([
    prisma.capabilityRepository.findMany({
      where: { capabilityId, status: "ACTIVE" },
      select: { repoName: true, repoUrl: true, defaultBranch: true, repositoryType: true },
      orderBy: [{ repoUrl: "asc" }, { defaultBranch: "asc" }],
    }),
    prisma.capabilityKnowledgeSource.findMany({
      where: { capabilityId, status: "ACTIVE" },
      select: { url: true, artifactType: true, title: true },
      orderBy: [{ url: "asc" }],
    }),
  ]);
  const sources = [
    ...repositories.map(repo => ({
      kind: String(repo.repositoryType ?? "GITHUB"),
      ref: repo.repoUrl,
      branch: repo.defaultBranch ?? "main",
      label: repo.repoName,
    })),
    ...knowledgeSources.map(source => ({
      kind: `URL:${source.artifactType}`,
      ref: source.url,
      branch: null,
      label: source.title,
    })),
  ];
  return {
    activeSourceCount: sources.length,
    activeRepositoryCount: repositories.length,
    activeKnowledgeSourceCount: knowledgeSources.length,
    sourceFingerprint: sha256(JSON.stringify(sources)),
    sources,
  };
}

function stackFromRepositoryProfiles(profiles: RepositoryProfileSummary[]): string[] {
  const items = new Set<string>();
  for (const profile of profiles) {
    for (const language of profile.languages ?? []) if (language.language) items.add(language.language);
    for (const framework of profile.frameworks ?? []) items.add(framework);
    for (const buildTool of profile.buildTools ?? []) items.add(buildTool);
  }
  return Array.from(items).slice(0, 12);
}

function stackFromCapabilityWorldModel(worldModel: { primaryLanguage?: string | null; buildSystem?: string | null } | null | undefined): string[] {
  const items = new Set<string>();
  if (worldModel?.primaryLanguage) items.add(worldModel.primaryLanguage);
  if (worldModel?.buildSystem) items.add(worldModel.buildSystem);
  return Array.from(items).slice(0, 12);
}

function learningDiagnostics(
  sourceState: Awaited<ReturnType<typeof learningSourceState>>,
  extra: Record<string, unknown> = {},
): Prisma.InputJsonValue {
  return {
    sources: sourceState.sources,
    activeRepositoryCount: sourceState.activeRepositoryCount,
    activeKnowledgeSourceCount: sourceState.activeKnowledgeSourceCount,
    ...extra,
  } as Prisma.InputJsonValue;
}

async function withActiveCapabilityLearningStatusWrite<T>(
  capabilityId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    const [capability] = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status
      FROM "Capability"
      WHERE id = ${capabilityId}
      FOR UPDATE
    `;
    if (!capability) throw new NotFoundError("Capability not found");
    if (capability.status === "ARCHIVED") return null;
    return write(tx);
  });
}

async function recordLearningAttempt(
  capabilityId: string,
  input: { message?: string; diagnostics?: Record<string, unknown> } = {},
): Promise<{ claimed: boolean; status: CapabilityLearningGroundingStatus; activeRepositoryCount: number }> {
  const sourceState = await learningSourceState(capabilityId);
  const status: CapabilityLearningGroundingStatus = sourceState.activeRepositoryCount > 0 ? "RUNNING" : "NOT_CONFIGURED";
  const message = status === "NOT_CONFIGURED"
    ? missingRepositoryMessage(sourceState)
    : learningMessageForStatus(status, input.message);
  const diagnostics = learningDiagnostics(sourceState, input.diagnostics ?? {});

  if (status === "RUNNING") {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - Math.max(CAPABILITY_LEARNING_RUN_STALE_MS, 60_000));
    const claim = await withActiveCapabilityLearningStatusWrite(capabilityId, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "CapabilityLearningStatus" ("id", "capabilityId", "status", "createdAt", "updatedAt")
        VALUES (${uuidv4()}, ${capabilityId}, 'NOT_CONFIGURED', ${now}, ${now})
        ON CONFLICT ("capabilityId") DO NOTHING
      `;
      return tx.capabilityLearningStatus.updateMany({
        where: {
          capabilityId,
          OR: [
            { status: { not: "RUNNING" } },
            { lastAttemptAt: null },
            { lastAttemptAt: { lt: staleBefore } },
          ],
        },
        data: {
          status,
          message,
          lastAttemptAt: now,
          lastFailureCode: null,
          lastFailureMessage: null,
          activeSourceCount: sourceState.activeSourceCount,
          sourceFingerprint: sourceState.sourceFingerprint,
          diagnostics,
        },
      });
    });
    if (!claim) throw new ConflictError("Capability was archived while the learning worker was starting.");
    return { claimed: claim.count > 0, status, activeRepositoryCount: sourceState.activeRepositoryCount };
  }

  const wrote = await withActiveCapabilityLearningStatusWrite(
    capabilityId,
    async (tx) => tx.capabilityLearningStatus.upsert({
      where: { capabilityId },
      create: {
        capabilityId,
        status,
        message,
        lastAttemptAt: new Date(),
        activeSourceCount: sourceState.activeSourceCount,
        sourceFingerprint: sourceState.sourceFingerprint,
        diagnostics,
      },
      update: {
        status,
        message,
        lastAttemptAt: new Date(),
        lastFailureCode: null,
        lastFailureMessage: null,
        activeSourceCount: sourceState.activeSourceCount,
        sourceFingerprint: sourceState.sourceFingerprint,
        diagnostics,
      },
    }),
  );
  if (!wrote) throw new ConflictError("Capability was archived while the learning worker was starting.");
  return { claimed: true, status, activeRepositoryCount: sourceState.activeRepositoryCount };
}

async function recordRepositoryLearningStatus(capabilityId: string, result: RepositoryRefreshResult) {
  if (result.refreshed > 0) {
    const sourceState = await learningSourceState(capabilityId);
    const stack = stackFromRepositoryProfiles(result.profiles);
    await withActiveCapabilityLearningStatusWrite(capabilityId, async (tx) => tx.capabilityLearningStatus.upsert({
      where: { capabilityId },
      create: {
        capabilityId,
        status: "LEARNED",
        message: learningMessageForStatus("LEARNED"),
        lastAttemptAt: new Date(),
        lastSuccessAt: new Date(),
        activeSourceCount: sourceState.activeSourceCount,
        learnedSourceCount: result.refreshed,
        sourceFingerprint: sourceState.sourceFingerprint,
        repoProfileVersion: 1,
        lastGoodStack: stack as Prisma.InputJsonValue,
        lastRepoProfiles: result.profiles as Prisma.InputJsonValue,
        diagnostics: learningDiagnostics(sourceState, { warnings: result.warnings, artifacts: result.artifacts }),
      },
      update: {
        status: "LEARNED",
        message: learningMessageForStatus("LEARNED"),
        lastAttemptAt: new Date(),
        lastSuccessAt: new Date(),
        lastFailureCode: null,
        lastFailureMessage: null,
        activeSourceCount: sourceState.activeSourceCount,
        learnedSourceCount: result.refreshed,
        sourceFingerprint: sourceState.sourceFingerprint,
        repoProfileVersion: { increment: 1 },
        lastGoodStack: stack as Prisma.InputJsonValue,
        lastRepoProfiles: result.profiles as Prisma.InputJsonValue,
        diagnostics: learningDiagnostics(sourceState, { warnings: result.warnings, artifacts: result.artifacts }),
      },
    }));
    return;
  }

  if (result.warnings.length > 0) {
    await recordLearningFailure(capabilityId, "REPOSITORY_PROFILE_REFRESH_FAILED", result.warnings.join("; "), {
      warnings: result.warnings,
      artifacts: result.artifacts,
    });
    return;
  }

  const [sourceState, capability] = await Promise.all([
    learningSourceState(capabilityId),
    prisma.capability.findUnique({ where: { id: capabilityId }, include: { worldModel: true } }),
  ]);
  const lastGoodStack = stackFromCapabilityWorldModel(capability?.worldModel);
  const status: CapabilityLearningGroundingStatus = sourceState.activeRepositoryCount === 0
    ? "NOT_CONFIGURED"
    : sourceState.activeRepositoryCount > 0
    ? lastGoodStack.length > 0
      ? "STALE"
      : "BLOCKED"
    : "NOT_CONFIGURED";
  const detail = status === "NOT_CONFIGURED"
    ? missingRepositoryMessage(sourceState)
    : status === "BLOCKED"
      ? "No repository profile was produced from the approved repository sources."
      : undefined;
  await withActiveCapabilityLearningStatusWrite(capabilityId, async (tx) => tx.capabilityLearningStatus.upsert({
    where: { capabilityId },
    create: {
      capabilityId,
      status,
      message: learningMessageForStatus(status, detail),
      lastAttemptAt: new Date(),
      activeSourceCount: sourceState.activeSourceCount,
      sourceFingerprint: sourceState.sourceFingerprint,
      lastGoodStack: lastGoodStack as Prisma.InputJsonValue,
      diagnostics: learningDiagnostics(sourceState),
    },
    update: {
      status,
      message: learningMessageForStatus(status, detail),
      lastAttemptAt: new Date(),
      activeSourceCount: sourceState.activeSourceCount,
      sourceFingerprint: sourceState.sourceFingerprint,
      lastGoodStack: lastGoodStack as Prisma.InputJsonValue,
      diagnostics: learningDiagnostics(sourceState),
    },
  }));
}

async function recordLearningFailure(
  capabilityId: string,
  code: string,
  message: string,
  diagnostics: Record<string, unknown> = {},
) {
  const [sourceState, capability] = await Promise.all([
    learningSourceState(capabilityId),
    prisma.capability.findUnique({
      where: { id: capabilityId },
      include: { learningStatus: true, worldModel: true },
    }),
  ]);
  const existing = capability?.learningStatus;
  const lastGoodStack = Array.isArray(existing?.lastGoodStack) ? existing.lastGoodStack : [];
  const worldModelStack = stackFromCapabilityWorldModel(capability?.worldModel);
  const effectiveLastGoodStack = lastGoodStack.length > 0 ? lastGoodStack : worldModelStack;
  const status: CapabilityLearningGroundingStatus = sourceState.activeRepositoryCount === 0
    ? "NOT_CONFIGURED"
    : effectiveLastGoodStack.length > 0
      ? "STALE"
      : "BLOCKED";
  const detail = status === "NOT_CONFIGURED" ? missingRepositoryMessage(sourceState) : message;
  await withActiveCapabilityLearningStatusWrite(capabilityId, async (tx) => tx.capabilityLearningStatus.upsert({
    where: { capabilityId },
    create: {
      capabilityId,
      status,
      message: learningMessageForStatus(status, detail),
      lastAttemptAt: new Date(),
      lastFailureAt: new Date(),
      lastFailureCode: code,
      lastFailureMessage: message,
      activeSourceCount: sourceState.activeSourceCount,
      sourceFingerprint: sourceState.sourceFingerprint,
      lastGoodStack: effectiveLastGoodStack as Prisma.InputJsonValue,
      diagnostics: learningDiagnostics(sourceState, diagnostics),
    },
    update: {
      status,
      message: learningMessageForStatus(status, detail),
      lastAttemptAt: new Date(),
      lastFailureAt: new Date(),
      lastFailureCode: code,
      lastFailureMessage: message,
      activeSourceCount: sourceState.activeSourceCount,
      sourceFingerprint: sourceState.sourceFingerprint,
      lastGoodStack: effectiveLastGoodStack as Prisma.InputJsonValue,
      diagnostics: learningDiagnostics(sourceState, diagnostics),
    },
  }));
}

async function activeCapabilityLearningWorker(capabilityId: string) {
  const lock = await prisma.capabilityLearningWorkerLock.findUnique({
    where: { capabilityId },
    select: {
      operation: true,
      startedAt: true,
      expiresAt: true,
      updatedAt: true,
    },
  });
  if (!lock || lock.expiresAt.getTime() <= Date.now()) return null;
  return {
    operation: lock.operation,
    startedAt: lock.startedAt.toISOString(),
    expiresAt: lock.expiresAt.toISOString(),
    updatedAt: lock.updatedAt.toISOString(),
  };
}

function learningStatusIsStaleRunning(
  stored: { status?: string | null; lastAttemptAt?: Date | string | null } | null | undefined,
  activeLearningWorker: unknown,
): boolean {
  if (String(stored?.status ?? "").toUpperCase() !== "RUNNING") return false;
  if (activeLearningWorker) return false;
  const attemptAt = stored?.lastAttemptAt instanceof Date
    ? stored.lastAttemptAt.getTime()
    : Date.parse(String(stored?.lastAttemptAt ?? ""));
  if (!Number.isFinite(attemptAt)) return true;
  return Date.now() - attemptAt > Math.max(CAPABILITY_LEARNING_RUN_STALE_MS, 60_000);
}

// Idempotent reclaim of a stale RUNNING bootstrap run (staleness check =
// isBootstrapRunStale in capability-bootstrap-reaper.ts). updateMany guards
// against racing a worker that just completed. Returns the completedAt stamp on
// a successful claim, else null.
async function reapStaleBootstrapRun(runId: string): Promise<Date | null> {
  const completedAt = new Date();
  const claimed = await prisma.capabilityBootstrapRun.updateMany({
    where: { id: runId, status: "RUNNING" },
    data: { status: "FAILED", completedAt, errors: [BOOTSTRAP_REAP_ERROR] as unknown as Prisma.InputJsonValue },
  });
  return claimed.count === 1 ? completedAt : null;
}

// B (auto-grounding) — internally-derived knowledge groups safe to materialize
// without human review. Externally-sourced docs + anything else stay PENDING.
const SAFE_AUTO_MATERIALIZE_GROUPS = ["agent_team_grounding", "architecture_diagram", "platform_inventory"];

/**
 * B (auto-grounding) — make onboarding yield a usable, grounded team without the
 * separate manual review step. Opt-in via CAPABILITY_AUTO_GROUND.
 *   B1: activate the NON-locked generated agents + bindings. Locked gates
 *       (Verifier/Security/Governance, activationRequired:true) stay DRAFT for
 *       explicit human sign-off — we deliberately do NOT call reviewBootstrapRun,
 *       which force-activates them.
 *   B2: materialize the internally-derived, low-risk knowledge candidates; external
 *       docs stay PENDING.
 * Fail-soft: any failure is logged, never aborts bootstrap. Returns a reviewNote to
 * surface on the run (what was auto-done + what still needs review).
 */
async function autoGroundCapability(
  capabilityId: string,
  runId: string,
  generatedAgents: Array<{ id: string; activationRequired: boolean; locked: boolean; label?: string; key?: string }>,
  userId?: string,
): Promise<{ activatedAgents: number; materializedGroups: string[]; reviewNote: string | null }> {
  const lockedGates = generatedAgents
    .filter(a => a.locked || a.activationRequired)
    .map(a => a.label ?? a.key ?? "gate");

  if (!isCapabilityAutoGroundEnabled()) {
    return {
      activatedAgents: 0,
      materializedGroups: [],
      reviewNote: `Onboarding created ${generatedAgents.length} agent(s) DRAFT and knowledge PENDING — run the bootstrap review to activate agents and materialize knowledge (set CAPABILITY_AUTO_GROUND=true to auto-activate non-locked agents at onboard).`,
    };
  }

  // B1 — activate the non-locked agents + their bindings.
  let activatedAgents = 0;
  const activateIds = generatedAgents
    .filter(a => a.activationRequired === false && a.locked === false && typeof a.id === "string")
    .map(a => a.id);
  if (activateIds.length > 0) {
    try {
      await prisma.agentTemplate.updateMany({
        where: { capabilityId, id: { in: activateIds }, status: { not: "ARCHIVED" } },
        data: { status: "ACTIVE" },
      });
      await prisma.agentCapabilityBinding.updateMany({
        where: { capabilityId, agentTemplateId: { in: activateIds }, status: { not: "ARCHIVED" } },
        data: { status: "ACTIVE" },
      });
      activatedAgents = activateIds.length;
    } catch (err) {
      console.warn(`[capability.autoGround] capabilityId=${capabilityId} agent activation failed: ${(err as Error).message}`);
    }
  }

  // B2 — materialize the internally-derived, low-risk knowledge candidates.
  const materializedGroups: string[] = [];
  try {
    const safeCandidates = await prisma.capabilityLearningCandidate.findMany({
      where: { bootstrapRunId: runId, status: "PENDING", groupKey: { in: SAFE_AUTO_MATERIALIZE_GROUPS } },
    });
    for (const candidate of safeCandidates) {
      try {
        await materializeBootstrapLearningCandidate(capabilityId, candidate, userId);
        if (!materializedGroups.includes(candidate.groupKey)) materializedGroups.push(candidate.groupKey);
      } catch (err) {
        console.warn(`[capability.autoGround] materialize ${candidate.groupKey} failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`[capability.autoGround] candidate scan failed: ${(err as Error).message}`);
  }

  const reviewNote = lockedGates.length > 0
    ? `Auto-grounding activated ${activatedAgents} non-locked agent(s)${materializedGroups.length ? ` and materialized ${materializedGroups.join(", ")}` : ""}. Locked gate(s) still need explicit review before activation: ${lockedGates.join(", ")}.`
    : `Auto-grounding activated ${activatedAgents} agent(s)${materializedGroups.length ? ` and materialized ${materializedGroups.join(", ")}` : ""}.`;
  return { activatedAgents, materializedGroups, reviewNote };
}

// D3 — a clone+index server-side can take minutes; agent-runtime fires this
// fire-and-forget so onboard never blocks on it.
const CENTRAL_CODE_GROUNDING_TIMEOUT_MS = 10 * 60_000;

/**
 * D3 — eager CENTRAL code grounding at onboard. Tells the (central) mcp-server to
 * clone the capability's primary repo + build the AST index server-side, so code
 * grounding doesn't wait for a lazy build on a laptop runtime's first workflow run.
 * Opt-in via GROUND_CODE_AT_ONBOARD. Posts DIRECTLY to MCP_SERVER_URL (a central
 * mcp-server), NOT the CF/laptop bridge. Fire-and-forget + fail-soft: never blocks
 * or aborts onboard. Brokered creds are optional — the materializer falls back to
 * the static GITHUB_TOKEN (fine for public repos / single-tenant).
 */
async function triggerCentralCodeGrounding(capabilityId: string): Promise<void> {
  if (!isGroundCodeAtOnboardEnabled()) return;
  const base = (process.env.MCP_SERVER_URL ?? "").replace(/\/+$/, "");
  if (!base || base === "mock") return;
  try {
    const cap = await prisma.capability.findUnique({
      where: { id: capabilityId },
      include: { repositories: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } } },
    });
    const repo = cap?.repositories.find(r =>
      r.repoUrl && !r.repoUrl.startsWith("local://") && String(r.repositoryType ?? "").toUpperCase() !== "LOCAL",
    );
    if (!repo) return;
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = process.env.MCP_BEARER_TOKEN ?? "";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/mcp/source/ground`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        capability_id: capabilityId,
        source_uri: repo.repoUrl,
        source_ref: repo.defaultBranch ?? "main",
      }),
      signal: AbortSignal.timeout(CENTRAL_CODE_GROUNDING_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[capability.centralCodeGrounding] capabilityId=${capabilityId} /mcp/source/ground HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[capability.centralCodeGrounding] capabilityId=${capabilityId} failed: ${(err as Error).message}`);
  }
}

async function buildCapabilityGroundingStatus(capabilityId: string) {
  const [capability, sourceState, activeLearningWorker] = await Promise.all([
    prisma.capability.findUnique({
      where: { id: capabilityId },
      include: { learningStatus: true, worldModel: true },
    }),
    learningSourceState(capabilityId),
    activeCapabilityLearningWorker(capabilityId),
  ]);
  if (!capability) throw new NotFoundError("Capability not found");
  const stored = capability.learningStatus;
  // A3 grounding-health — embedding coverage over ACTIVE knowledge artifacts. Rows
  // with a NULL vector are invisible to semantic retrieval (it silently degrades to
  // recency/FTS for them), so surface the gap on the status for operators/UI.
  const embeddingCoverageRows = await prisma.$queryRawUnsafe<Array<{ total: bigint; missing: bigint }>>(
    `SELECT count(*)::bigint AS total, count(*) FILTER (WHERE embedding IS NULL)::bigint AS missing
       FROM "CapabilityKnowledgeArtifact" WHERE "capabilityId" = $1 AND status = 'ACTIVE'`,
    capabilityId,
  ).catch(() => [] as Array<{ total: bigint; missing: bigint }>);
  const embeddingCoverage = {
    activeArtifacts: Number(embeddingCoverageRows[0]?.total ?? 0),
    missingEmbeddings: Number(embeddingCoverageRows[0]?.missing ?? 0),
    degraded: Number(embeddingCoverageRows[0]?.total ?? 0) > 0 && Number(embeddingCoverageRows[0]?.missing ?? 0) > 0,
  };
  const worldModelStack = stackFromCapabilityWorldModel(capability.worldModel);
  const storedStack = Array.isArray(stored?.lastGoodStack) ? stored.lastGoodStack.map(String).filter(Boolean) : [];
  const staleRunningWorker = learningStatusIsStaleRunning(stored, activeLearningWorker);
  const effectiveStored = staleRunningWorker && stored
    ? {
        ...stored,
        status: "BLOCKED",
        message: "The last learning worker stopped without completing and its lease expired. Retry repository grounding, or inspect agent-runtime logs if this repeats.",
      }
    : stored;
  if (capability.status === "ARCHIVED") {
    return {
      capabilityId,
      status: "ARCHIVED",
      preciseState: "ARCHIVED",
      message: learningMessageForStatus("ARCHIVED"),
      lastAttemptAt: stored?.lastAttemptAt ?? null,
      lastSuccessAt: stored?.lastSuccessAt ?? null,
      lastFailureAt: stored?.lastFailureAt ?? null,
      lastFailureCode: stored?.lastFailureCode ?? null,
      lastFailureMessage: stored?.lastFailureMessage ?? null,
      activeSourceCount: sourceState.activeSourceCount,
      activeRepositoryCount: sourceState.activeRepositoryCount,
      activeKnowledgeSourceCount: sourceState.activeKnowledgeSourceCount,
      learnedSourceCountAtLastAttempt: stored?.activeSourceCount ?? 0,
      learnedSourceCount: stored?.learnedSourceCount ?? 0,
      sourceFingerprint: stored?.sourceFingerprint ?? sourceState.sourceFingerprint,
      currentSourceFingerprint: sourceState.sourceFingerprint,
      sourceDrifted: false,
      repoProfileVersion: stored?.repoProfileVersion ?? 0,
      lastGoodStack: storedStack.length > 0 ? storedStack : worldModelStack,
      lastRepoProfiles: stored?.lastRepoProfiles ?? [],
      activeLearningWorker,
      diagnostics: stored?.diagnostics ?? learningDiagnostics(sourceState),
      embeddingCoverage,
      fixCommand: null,
    };
  }
  const derived = deriveCapabilityGroundingState({
    stored: effectiveStored,
    sourceState,
    storedStack,
    worldModelStack,
  });
  return {
    capabilityId,
    status: derived.status,
    preciseState: derived.preciseState,
    message: derived.message,
    lastAttemptAt: stored?.lastAttemptAt ?? null,
    lastSuccessAt: stored?.lastSuccessAt ?? null,
    lastFailureAt: stored?.lastFailureAt ?? null,
    lastFailureCode: staleRunningWorker ? "LEARNING_WORKER_STALE" : stored?.lastFailureCode ?? null,
    lastFailureMessage: staleRunningWorker
      ? "The learning worker lease expired before completion."
      : stored?.lastFailureMessage ?? null,
    activeSourceCount: sourceState.activeSourceCount,
    activeRepositoryCount: sourceState.activeRepositoryCount,
    activeKnowledgeSourceCount: sourceState.activeKnowledgeSourceCount,
    learnedSourceCountAtLastAttempt: stored?.activeSourceCount ?? 0,
    learnedSourceCount: stored?.learnedSourceCount ?? 0,
    sourceFingerprint: derived.sourceFingerprint,
    currentSourceFingerprint: derived.currentSourceFingerprint,
    sourceDrifted: derived.sourceDrifted,
    repoProfileVersion: stored?.repoProfileVersion ?? 0,
    lastGoodStack: storedStack.length > 0 ? storedStack : worldModelStack,
    lastRepoProfiles: stored?.lastRepoProfiles ?? [],
    activeLearningWorker,
    diagnostics: staleRunningWorker
      ? { ...jsonRecord(learningDiagnostics(sourceState)), staleRunningWorker: true }
      : stored?.diagnostics ?? learningDiagnostics(sourceState),
    embeddingCoverage,
    // A working remediation: BLOCKED/STALE re-runs grounding (and re-embeds when
    // embeddings are degraded, instead of the old hard-coded reembed:false that
    // never repaired the gap); a LEARNED-but-degraded capability now gets a
    // targeted /embeddings/reembed backfill command it previously lacked.
    fixCommand: buildGroundingFixCommand({
      capabilityId,
      status: derived.status,
      embeddingDegraded: embeddingCoverage.degraded,
    }),
  };
}

export async function refreshRepositoryProfileLearning(capabilityId: string, userId?: string): Promise<RepositoryRefreshResult> {
  const cap = await prisma.capability.findUnique({
    where: { id: capabilityId },
    include: {
      repositories: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } },
      bindings: { include: { agentTemplate: true }, orderBy: { createdAt: "asc" } },
      bootstrapRuns: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!cap) throw new NotFoundError("Capability not found");

  const profiles: RepositoryProfile[] = [];
  const warnings: string[] = [];
  for (const repo of cap.repositories) {
    const repoType = String(repo.repositoryType ?? "").toUpperCase();
    if (repoType === "LOCAL" || repo.repoUrl.startsWith("local://")) continue;
    try {
      const discovery = await discoverGitHubRepoWithProfile(repo.repoUrl, repo.defaultBranch ?? "main", userId);
      profiles.push(discovery.profile);
    } catch (err) {
      warnings.push(`Repository profile refresh skipped for ${repo.repoName}: ${(err as Error).message}`);
    }
  }

  if (profiles.length === 0) {
    return { refreshed: 0, artifacts: 0, profiles: [], warnings };
  }

  const primaryLanguage = pickPrimaryLanguage(profiles);
  const buildSystem = pickPrimaryBuildSystem(profiles);
  await upsertWorldModel({
    capabilityId,
    ...(primaryLanguage ? { primaryLanguage } : {}),
    ...(buildSystem ? { buildSystem } : {}),
  });

  const input: BootstrapInput = {
    name: cap.name,
    appId: cap.appId ?? undefined,
    parentCapabilityId: cap.parentCapabilityId ?? undefined,
    capabilityType: cap.capabilityType ?? undefined,
    businessUnitId: cap.businessUnitId ?? undefined,
    ownerTeamId: cap.ownerTeamId ?? undefined,
    criticality: cap.criticality ?? undefined,
    description: cap.description ?? undefined,
    repositories: cap.repositories.map(repo => ({
      repoName: repo.repoName,
      repoUrl: repo.repoUrl,
      defaultBranch: repo.defaultBranch ?? undefined,
      repositoryType: repo.repositoryType ?? undefined,
    })),
    documentLinks: [],
  };
  const generatedAgents = cap.bindings.map(binding => ({
    label: binding.agentTemplate?.name ?? binding.bindingName,
    roleType: String(binding.roleInCapability ?? binding.agentTemplate?.roleType ?? "AGENT"),
    locked: Boolean(binding.agentTemplate?.lockedReason),
    learnsFromGit: true,
  }));
  const architectureDiagram = buildCapabilityArchitectureDiagram(cap, input, generatedAgents, [], profiles);
  const artifactCandidates = [
    ...buildPlatformInventoryCandidates(profiles),
    buildArchitectureDiagramCandidate(cap.name, architectureDiagram),
  ];

  let artifactCount = 0;
  for (const candidate of artifactCandidates) {
    const { artifact, contentHash } = await persistKnowledgeArtifact(capabilityId, candidate);
    await ensureKnowledgeEmbedding({
      artifactId: artifact.id,
      title: candidate.title,
      content: candidate.content,
      contentHash,
    });
    if (candidate.artifactType === "ARCHITECTURE_DIAGRAM") {
      await prisma.capabilityKnowledgeArtifact.updateMany({
        where: {
          capabilityId,
          artifactType: candidate.artifactType,
          title: candidate.title,
          status: "ACTIVE",
          id: { not: artifact.id },
        },
        data: { status: "ARCHIVED" },
      });
    }
    artifactCount += 1;
  }

  const latestRun = cap.bootstrapRuns[0];
  if (latestRun) {
    const summary = jsonRecord(latestRun.sourceSummary);
    const operatingModel = jsonRecord(summary.operatingModel);
    await prisma.capabilityBootstrapRun.update({
      where: { id: latestRun.id },
      data: {
        sourceSummary: {
          ...summary,
          repositoryProfiles: profiles,
          repositoryProfilesRefreshedAt: new Date().toISOString(),
          operatingModel: {
            ...operatingModel,
            repositoryProfiles: profiles,
            architectureDiagram,
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // Drift-completeness: a repo change also stales the DISTILLED world model
  // (readmeSummary / architectureSlice / codeConventions / entrypoints), the
  // KNOWLEDGE embeddings, and the code index — not just the language/build facts
  // + inventory refreshed above. Re-run those so the row isn't stamped
  // "refreshed" while they stay stale. All best-effort: a failure adds a warning
  // and never fails the refresh (this runs fire-and-forget from the drift path).
  try {
    await distillAndUpsertWorldModel(capabilityId);
  } catch (err) {
    warnings.push(`World-model distillation refresh failed: ${(err as Error).message}`);
  }
  try {
    // Backfill knowledge artifacts left with a NULL vector (embedding landmine or
    // prior failures) so refreshed knowledge is vector-retrievable again.
    const re = await capabilityService.reembedCapability(capabilityId, { kinds: ["knowledge"] });
    if (re.knowledge.failed > 0) {
      warnings.push(`Knowledge re-embed left ${re.knowledge.failed} artifact(s) unembedded (embeddings provider degraded).`);
    }
  } catch (err) {
    warnings.push(`Knowledge re-embed backfill failed: ${(err as Error).message}`);
  }
  // Re-index the code centrally when central grounding is enabled (no-op
  // otherwise; the lazy per-workflow index rebuilds on the next run). Fire-and-
  // forget so the mcp clone+index doesn't block the refresh — mirrors bootstrap.
  void triggerCentralCodeGrounding(capabilityId);

  return {
    refreshed: profiles.length,
    artifacts: artifactCount,
    profiles: profiles.map(profile => ({
      repoName: profile.repoName,
      languages: profile.languages,
      frameworks: profile.frameworks,
      buildTools: profile.buildTools,
      endpointCount: profile.endpointCount,
    })),
    warnings,
  };
}

type CapabilityDbClient = typeof prisma | Prisma.TransactionClient;

async function lockCapabilityNaturalKey(client: CapabilityDbClient, input: CapabilityIdentityInput): Promise<void> {
  const key = capabilityNaturalKey(input);
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

async function assertNoActiveCapabilityDuplicate(
  client: CapabilityDbClient,
  input: CapabilityIdentityInput,
  excludeId?: string,
): Promise<void> {
  const appId = normalizedIdentityValue(input.appId);
  const name = normalizedIdentityValue(input.name);
  const excludeClause = excludeId ? Prisma.sql`AND id <> ${excludeId}` : Prisma.empty;
  const rows = appId
    ? await client.$queryRaw<Array<{ id: string; name: string; appId: string | null; capabilityType: string | null }>>(Prisma.sql`
        SELECT id, name, "appId", "capabilityType"
        FROM "Capability"
        WHERE status = 'ACTIVE'
          ${excludeClause}
          AND lower(btrim(COALESCE("appId", ''))) = lower(${appId})
        LIMIT 1
      `)
    : name
      ? await client.$queryRaw<Array<{ id: string; name: string; appId: string | null; capabilityType: string | null }>>(Prisma.sql`
          SELECT id, name, "appId", "capabilityType"
          FROM "Capability"
          WHERE status = 'ACTIVE'
            ${excludeClause}
            AND NULLIF(btrim(COALESCE("appId", '')), '') IS NULL
            AND lower(btrim(name)) = lower(${name})
            AND lower(COALESCE(NULLIF(btrim("capabilityType"), ''), 'default')) = lower(${normalizedCapabilityType(input.capabilityType)})
          LIMIT 1
        `)
      : [];
  const existing = rows[0];
  if (!existing) return;

  throw new ConflictError(capabilityDuplicateConflictMessage(existing));
}

async function rethrowCapabilityIdentityConflict(
  err: unknown,
  input: CapabilityIdentityInput,
  excludeId?: string,
): Promise<never> {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    throw err;
  }

  const where = capabilityDuplicateWhere(input, excludeId);
  const existing = where
    ? await prisma.capability.findFirst({
        where,
        select: { id: true, name: true, appId: true, capabilityType: true },
      })
    : null;
  if (existing) {
    throw new ConflictError(capabilityDuplicateConflictMessage(existing));
  }

  throw new ConflictError(
    "Active capability already exists for this identity. Refresh the capability list and open the existing capability.",
  );
}

async function findActiveRepositorySource(
  client: CapabilityDbClient,
  input: { capabilityId: string; repoUrl: string; defaultBranch?: string | null; repositoryType?: string | null },
  excludeId?: string,
) {
  const excludeClause = excludeId ? Prisma.sql`AND id <> ${excludeId}` : Prisma.empty;
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "CapabilityRepository"
    WHERE status = 'ACTIVE'
      ${excludeClause}
      AND "capabilityId" = ${input.capabilityId}
      AND lower(btrim("repoUrl")) = lower(${normalizedSourceValue(input.repoUrl)})
      AND lower(COALESCE(NULLIF(btrim("defaultBranch"), ''), 'main')) = lower(${normalizedRepositoryBranch(input.defaultBranch)})
      AND lower(COALESCE(NULLIF(btrim("repositoryType"), ''), 'GITHUB')) = lower(${normalizedRepositoryType(input.repositoryType)})
    ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    LIMIT 1
  `);
  return rows[0]
    ? client.capabilityRepository.findUnique({ where: { id: rows[0].id } })
    : null;
}

async function assertNoActiveRepositorySourceDuplicate(
  client: CapabilityDbClient,
  input: { capabilityId: string; repoUrl: string; defaultBranch?: string | null; repositoryType?: string | null },
  excludeId?: string,
) {
  const existing = await findActiveRepositorySource(client, input, excludeId);
  if (!existing) return;
  throw new ConflictError(`Active repository source already exists for ${existing.repoUrl} (${existing.defaultBranch ?? "main"}).`);
}

async function findActiveKnowledgeSource(
  client: CapabilityDbClient,
  input: { capabilityId: string; url: string; artifactType?: string | null },
  excludeId?: string,
) {
  const excludeClause = excludeId ? Prisma.sql`AND id <> ${excludeId}` : Prisma.empty;
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "CapabilityKnowledgeSource"
    WHERE status = 'ACTIVE'
      ${excludeClause}
      AND "capabilityId" = ${input.capabilityId}
      AND lower(btrim("url")) = lower(${normalizedSourceValue(input.url)})
      AND lower(COALESCE(NULLIF(btrim("artifactType"), ''), 'DOC')) = lower(${normalizedKnowledgeArtifactType(input.artifactType)})
    ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    LIMIT 1
  `);
  return rows[0]
    ? client.capabilityKnowledgeSource.findUnique({ where: { id: rows[0].id } })
    : null;
}

async function assertNoActiveKnowledgeSourceDuplicate(
  client: CapabilityDbClient,
  input: { capabilityId: string; url: string; artifactType?: string | null },
  excludeId?: string,
) {
  const existing = await findActiveKnowledgeSource(client, input, excludeId);
  if (!existing) return;
  throw new ConflictError(`Active knowledge source already exists for ${existing.url} (${existing.artifactType}).`);
}

async function assertCodeExtractionApproved(
  capabilityId: string,
  repo: { repoName: string; repoUrl: string; repositoryType: string | null },
): Promise<void> {
  const hasBootstrap = await prisma.capabilityBootstrapRun.count({ where: { capabilityId } });
  if (hasBootstrap === 0) return;

  const approved = await prisma.capabilityLearningCandidate.findMany({
    where: { capabilityId, status: "MATERIALIZED" },
    select: { sourceRef: true, sourceType: true },
  });

  const approvedForRepo = repo.repositoryType === "LOCAL" || repo.repoUrl.startsWith("local://")
    ? approved.some(item => item.sourceRef?.includes(LOCAL_BOOTSTRAP_REF) || item.sourceType === "LOCAL_FILE")
    : isApprovedSource(approved, repo.repoUrl);

  if (!approvedForRepo) {
    throw new ForbiddenError(`Code context for ${repo.repoName} requires approved bootstrap learning first.`);
  }
}
