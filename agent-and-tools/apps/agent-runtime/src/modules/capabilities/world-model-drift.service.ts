/**
 * M61 Slice E — Drift detection service.
 *
 * Sits behind POST /capabilities/:id/world-model/fingerprint. The
 * caller submits a fingerprint they computed locally (via
 * computeRepoFingerprint or its workgraph-api twin); we compare
 * against CapabilityWorldModel.repoFingerprint and:
 *
 *  - first stamp (stored is null): write it and return drift=false.
 *  - match: return drift=false, do nothing.
 *  - mismatch: emit an audit-log entry, update the stored fingerprint
 *    to the new value (so subsequent calls don't re-fire), and return
 *    drift=true with the previous value so the caller can surface
 *    the change to operators.
 *
 * We deliberately do NOT trigger a re-bootstrap from here. The drift
 * event is observational. An operator (or a future Slice B refresh
 * worker) decides whether to refresh the world model in response.
 */
import { prisma } from "../../config/prisma";
import { upsertWorldModel, getWorldModel } from "./world-model.service";

export type RecordFingerprintInput = {
  fingerprint: string;
  hashedBuildFiles?: string[];
  topLevelEntries?: string[];
  actorId?: string;
};

export type RecordFingerprintResult = {
  drift: boolean;
  firstStamp: boolean;
  previousFingerprint: string | null;
  currentFingerprint: string;
  storedAt: string;
};

export const worldModelDriftService = {
  async recordFingerprint(
    capabilityId: string,
    input: RecordFingerprintInput,
  ): Promise<RecordFingerprintResult> {
    const existing = await getWorldModel(capabilityId);
    const stored = existing?.repoFingerprint ?? null;
    const firstStamp = !stored;
    const drift = Boolean(stored) && stored !== input.fingerprint;

    // Always upsert: first stamps create the row, drifts overwrite
    // (we do not want to refire on every workflow until the row is
    // actually refreshed), matches are no-ops that bump refreshedAt.
    await upsertWorldModel({
      capabilityId,
      repoFingerprint: input.fingerprint,
    });

    if (drift) {
      // Persist a structured audit log entry. We re-use
      // CapabilityBootstrapRun's `warnings` JSON list is wrong shape —
      // instead we INSERT a dedicated row in the generic audit
      // tracking table if one exists, else fall back to console.
      // For now keep this minimal: log structured JSON via the prisma
      // event log if your platform has one; otherwise the warning is
      // observable on the next bootstrap run.
      //
      // The actual cross-service audit (AUDIT_GOV_URL) is owned by
      // the consumer side (mcp-server / workgraph-api), since they
      // know the workflow context — drift detected during a
      // workflow run carries different metadata than drift detected
      // by a nightly operator script.
      //
      // We do however log a structured line so the audit trail is
      // greppable from the agent-runtime container logs.
      // eslint-disable-next-line no-console
      console.warn(
        `[worldModel.drift] capabilityId=${capabilityId} ` +
        `previous=${stored} current=${input.fingerprint} ` +
        `actor=${input.actorId ?? "anonymous"} ` +
        `hashedBuildFiles=${(input.hashedBuildFiles ?? []).join(",")}`,
      );
    }

    // Stamp the refreshedAt by reading the now-updated row. We
    // already wrote above; re-read to get the canonical timestamp.
    const refreshed = await prisma.capabilityWorldModel.findUnique({
      where: { capabilityId },
      select: { refreshedAt: true },
    });
    return {
      drift,
      firstStamp,
      previousFingerprint: stored,
      currentFingerprint: input.fingerprint,
      storedAt: (refreshed?.refreshedAt ?? new Date()).toISOString(),
    };
  },
};
