import { CorrelationIds } from "./store";
import { emitAuditEvent } from "../lib/audit-gov-emit";
import { events } from "../events/bus";

export type RePlanTrigger =
  | "verification_failure"
  | "conflict_detected"
  | "dependency_stale"
  | "approval_rejected"
  | "test_failure"
  | "loop_repetition";

export interface RePlanMeta {
  trigger: RePlanTrigger;
  step_index: number;
  convergence_depth: number;
  verifier_name?: string;
  conflicted_paths?: string[];
}

export function emitRePlan(correlation: CorrelationIds, meta: RePlanMeta): void {
  emitAuditEvent({
    trace_id: correlation.traceId,
    source_service: "mcp-server",
    kind: "agent_loop.replan",
    subject_type: "AgentRun",
    subject_id: correlation.runId,
    capability_id: correlation.capabilityId,
    severity: meta.convergence_depth >= 3 ? "warn" : "info",
    payload: { ...meta } as Record<string, unknown>,
  });
  events.publish({
    kind: "run.event",
    correlation,
    payload: { type: "replan", ...meta },
  });
}
