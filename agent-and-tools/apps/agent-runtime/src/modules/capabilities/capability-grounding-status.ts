export type CapabilityLearningGroundingStatus = "NOT_CONFIGURED" | "RUNNING" | "LEARNED" | "STALE" | "BLOCKED" | "ARCHIVED";

export type CapabilityGroundingSourceState = {
  activeSourceCount: number;
  activeRepositoryCount: number;
  activeKnowledgeSourceCount: number;
  sourceFingerprint: string;
};

export type CapabilityGroundingStoredState = {
  status?: string | null;
  message?: string | null;
  lastSuccessAt?: unknown;
  sourceFingerprint?: string | null;
};

export function learningMessageForStatus(status: CapabilityLearningGroundingStatus, detail?: string): string {
  if (detail) return detail;
  switch (status) {
    case "LEARNED": return "Repository profile learned successfully.";
    case "STALE": return "Using the last successful repository profile; latest refresh failed.";
    case "BLOCKED": return "Repository profile refresh is blocked.";
    case "ARCHIVED": return "Capability is archived; repository grounding is read-only.";
    case "RUNNING": return "Learning refresh is running.";
    case "NOT_CONFIGURED":
    default: return "Attach an active repository source to learn repository grounding for this capability.";
  }
}

export function missingRepositoryMessage(sourceState: Pick<CapabilityGroundingSourceState, "activeKnowledgeSourceCount">): string {
  return sourceState.activeKnowledgeSourceCount > 0
    ? "Document/link knowledge is configured, but repository grounding requires at least one active repository source."
    : "Attach an active repository source to learn repository grounding for this capability.";
}

export function deriveCapabilityGroundingState(input: {
  stored?: CapabilityGroundingStoredState | null;
  sourceState: CapabilityGroundingSourceState;
  storedStack: string[];
  worldModelStack: string[];
}): {
  status: CapabilityLearningGroundingStatus;
  preciseState: CapabilityLearningGroundingStatus;
  message: string;
  sourceDrifted: boolean;
  sourceFingerprint: string;
  currentSourceFingerprint: string;
} {
  const { stored, sourceState, storedStack, worldModelStack } = input;
  const storedFingerprint = stored?.sourceFingerprint ?? null;
  const sourceDrifted = Boolean(storedFingerprint && storedFingerprint !== sourceState.sourceFingerprint);
  const rawStatus = normalizeGroundingStatus(
    stored?.status
      ? String(stored.status)
      : sourceState.activeRepositoryCount === 0
        ? "NOT_CONFIGURED"
        : worldModelStack.length > 0
          ? "LEARNED"
          : "BLOCKED",
  );
  const status = rawStatus === "ARCHIVED"
    ? "ARCHIVED"
    : sourceState.activeRepositoryCount === 0 && !stored?.lastSuccessAt
    ? "NOT_CONFIGURED"
    : sourceDrifted && rawStatus === "LEARNED"
      ? "STALE"
      : rawStatus === "BLOCKED" && (storedStack.length > 0 || worldModelStack.length > 0)
        ? "STALE"
        : rawStatus;
  const message = rawStatus === status
    ? stored?.message ?? (status === "NOT_CONFIGURED" ? missingRepositoryMessage(sourceState) : learningMessageForStatus(status))
    : sourceDrifted && status === "STALE"
      ? "Attached sources changed after the last successful repository grounding; refresh to learn the current source set."
      : learningMessageForStatus(status);

  return {
    status,
    preciseState: status,
    message,
    sourceDrifted,
    sourceFingerprint: storedFingerprint ?? sourceState.sourceFingerprint,
    currentSourceFingerprint: sourceState.sourceFingerprint,
  };
}

export function shouldRecordGroundingAttempt(input: {
  dryRun?: boolean;
  refreshRepositoryProfiles?: boolean;
}): boolean {
  return input.dryRun !== true && input.refreshRepositoryProfiles !== false;
}

/**
 * The operator remediation ("fix") command for a capability's grounding status.
 * Pure so it is unit-testable and never drifts from the runtime routes.
 *
 *  - BLOCKED / STALE → re-run repository grounding. Also re-embed the knowledge
 *    corpus WHEN embeddings are degraded — NULL-vector rows are invisible to
 *    semantic retrieval, so the previous hard-coded `reembed:false` left the
 *    surfaced degradation UNrepaired even after the operator ran the "fix".
 *  - Otherwise (e.g. LEARNED) but embeddings degraded → a targeted backfill of the
 *    NULL-vector knowledge artifacts via /embeddings/reembed. Previously NO fix was
 *    surfaced for this silent-degradation case — the status flagged `degraded` with
 *    no actionable remedy.
 *  - Fully grounded, embeddings intact → null.
 *
 * The default provider's embeddings API is the common cause of `embeddingDegraded`
 * (the shipped model alias resolves to a provider with no embeddings endpoint);
 * once a working provider is configured, the returned command backfills the gaps.
 */
export function buildGroundingFixCommand(input: {
  capabilityId: string;
  status: CapabilityLearningGroundingStatus;
  embeddingDegraded: boolean;
  platformBaseUrl?: string;
}): string | null {
  const base = (input.platformBaseUrl ?? "http://localhost:5180").replace(/\/+$/, "");
  const headers = "-H 'authorization: Bearer <token>' -H 'content-type: application/json'";
  const endpoint = (path: string) => `${base}/api/runtime/capabilities/${input.capabilityId}${path}`;
  if (input.status === "BLOCKED" || input.status === "STALE") {
    const body = JSON.stringify({
      syncApprovedSources: false,
      refreshRepositoryProfiles: true,
      reembed: input.embeddingDegraded,
    });
    return `curl -X POST ${endpoint("/learning-worker/run")} ${headers} -d '${body}'`;
  }
  if (input.embeddingDegraded) {
    const body = JSON.stringify({ kinds: ["knowledge"] });
    return `curl -X POST ${endpoint("/embeddings/reembed")} ${headers} -d '${body}'`;
  }
  return null;
}

function normalizeGroundingStatus(value: string): CapabilityLearningGroundingStatus {
  const upper = value.toUpperCase();
  if (upper === "RUNNING" || upper === "LEARNED" || upper === "STALE" || upper === "BLOCKED" || upper === "NOT_CONFIGURED" || upper === "ARCHIVED") {
    return upper;
  }
  return "BLOCKED";
}
