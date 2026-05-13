/**
 * M21.5 — pending-approval persistence in audit-governance-service.
 *
 * mcp-server's `audit/pending.ts` keeps a 24h in-memory map; it's lost on
 * restart. This module mirrors every savePending() write into the central
 * audit-gov `approvals` table (along with the full continuation_payload),
 * and on cache miss, takePending() reaches into audit-gov to /consume the
 * approval atomically (single-use).
 *
 * Failure mode: if audit-gov is unreachable on save, we degrade — the
 * in-memory map alone holds the envelope. Restart loses it. We log a warn
 * so the operator can investigate.
 */
import { log } from "../shared/log";
import type { PendingApproval } from "../audit/pending";

const AUDIT_GOV_URL = process.env.AUDIT_GOV_URL ?? "http://host.docker.internal:8500";
const TIMEOUT_MS = 5_000;

/** Persist the full LoopState envelope to audit-gov so mcp-server restart
 * doesn't drop in-flight approvals. Returns true on success. Awaited (not
 * fire-and-forget) so the caller knows whether durability is intact for
 * this approval. */
export async function persistApproval(env: PendingApproval, opts: {
  capability_id?: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  risk_level?: string;
  requested_by?: string;
}): Promise<boolean> {
  if (!AUDIT_GOV_URL) return false;
  try {
    const res = await fetch(`${AUDIT_GOV_URL.replace(/\/$/, "")}/api/v1/governance/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: env.continuation_token,
        trace_id: env.trace_id,
        capability_id: opts.capability_id,
        source_service: "mcp-server",
        tool_name: opts.tool_name,
        tool_args: opts.tool_args,
        risk_level: opts.risk_level,
        requested_by: opts.requested_by,
        expires_at: env.expires_at,
        continuation_payload: env as unknown as Record<string, unknown>,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(`audit-gov persistApproval ${env.continuation_token} → ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`audit-gov persistApproval ${env.continuation_token} failed: ${(err as Error).message}`);
    return false;
  }
}

export interface ConsumedApproval {
  id: string;
  decision: "approved" | "rejected";
  decided_by: string | null;
  decision_reason: string | null;
  payload: PendingApproval | null;
}

/** Atomic single-use claim — flips status pending→consumed in audit-gov and
 * returns the stored continuation_payload. Returns null on miss (not found,
 * not yet decided, already consumed, or expired). */
export async function consumeApproval(continuationToken: string): Promise<ConsumedApproval | null> {
  if (!AUDIT_GOV_URL) return null;
  try {
    const res = await fetch(
      `${AUDIT_GOV_URL.replace(/\/$/, "")}/api/v1/governance/approvals/${encodeURIComponent(continuationToken)}/consume`,
      { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (res.status === 404 || res.status === 409 || res.status === 410) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      log.info(`audit-gov consumeApproval ${continuationToken} → ${res.status}: ${detail}`);
      return null;
    }
    if (!res.ok) {
      log.warn(`audit-gov consumeApproval ${continuationToken} → ${res.status}`);
      return null;
    }
    const body = await res.json() as {
      id: string;
      decision: "approved" | "rejected";
      decided_by: string | null;
      decision_reason: string | null;
      continuation_payload: PendingApproval | null;
    };
    return {
      id: body.id,
      decision: body.decision,
      decided_by: body.decided_by,
      decision_reason: body.decision_reason,
      payload: body.continuation_payload ?? null,
    };
  } catch (err) {
    log.warn(`audit-gov consumeApproval ${continuationToken} failed: ${(err as Error).message}`);
    return null;
  }
}
