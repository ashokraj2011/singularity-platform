/**
 * M22 — pre-flight governance checks against the audit-governance-service.
 *
 * Unlike the fire-and-forget emitter, these calls are AWAITED and gate the
 * agent loop. A failure to reach audit-gov defaults to ALLOW (fail-open) so
 * a brownout in audit-gov doesn't stall every tenant — but the failure is
 * logged at warn level.
 */
import { log } from "../shared/log";

const AUDIT_GOV_URL = process.env.AUDIT_GOV_URL ?? "http://host.docker.internal:8500";
const TIMEOUT_MS    = 3_000;

export interface CheckResult {
  allowed: boolean;
  reason?: string;
  // Per-period remaining for budgets, or null when no budget exists for the key.
  budgets?: Array<{ period: string; remaining_tokens: number; remaining_cost: number }>;
  // Number of calls remaining in the current rate-limit window, or null when no rate-limit configured.
  rate_limits?: Array<{ name: string; remaining: number; window_seconds: number }>;
}

async function getJson<T>(path: string, qs: Record<string, string | undefined>): Promise<T | null> {
  if (!AUDIT_GOV_URL) return null;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(qs)) if (v) params.set(k, v);
  const url = `${AUDIT_GOV_URL.replace(/\/$/, "")}${path}?${params}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      log.warn(`audit-gov ${path} → ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log.warn(`audit-gov ${path} failed: ${(err as Error).message}`);
    return null;
  }
}

function pickScope(capabilityId?: string, tenantId?: string): { scope_type: string; scope_id: string } | null {
  // Capability scope wins when both are set (most-specific-first).
  if (capabilityId) return { scope_type: "capability", scope_id: capabilityId };
  if (tenantId)     return { scope_type: "tenant",     scope_id: tenantId     };
  return null;
}

export async function checkBudget(
  capabilityId?: string,
  tenantId?: string,
  tokensEstimated?: number,
): Promise<CheckResult> {
  const scope = pickScope(capabilityId, tenantId);
  if (!scope) return { allowed: true };
  const data = await getJson<{ allowed: boolean; reason?: string; budgets?: Array<{ period: string; remaining_tokens: number; remaining_cost: number }> }>(
    "/api/v1/governance/budgets/check",
    {
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
      tokens_estimated: tokensEstimated ? String(Math.max(0, Math.floor(tokensEstimated))) : undefined,
    },
  );
  // Fail-open if audit-gov is unreachable.
  if (data == null) return { allowed: true };
  return { allowed: data.allowed, reason: data.reason, budgets: data.budgets ?? [] };
}

export async function checkRateLimit(
  capabilityId?: string,
  tenantId?: string,
): Promise<CheckResult> {
  const scope = pickScope(capabilityId, tenantId);
  if (!scope) return { allowed: true };
  const data = await getJson<{ allowed: boolean; reason?: string; rate_limits?: Array<{ name: string; remaining: number; window_seconds: number }> }>(
    "/api/v1/governance/rate-limits/check",
    { scope_type: scope.scope_type, scope_id: scope.scope_id },
  );
  if (data == null) return { allowed: true };
  return { allowed: data.allowed, reason: data.reason, rate_limits: data.rate_limits ?? [] };
}
