# Singularity Trace Contract

`traceId` is the cross-service evidence spine. Every prompt assembly, Context
Fabric call, Agent Execution Runtime invocation, audit event, budget event, and workflow evidence
record for the same execution path must carry the same `traceId`.

Identifier ownership:

- `traceId`: correlation spine across services.
- `workflowInstanceId`: Workgraph run identity.
- `workflowNodeId`: Workgraph node identity inside a run.
- `cfCallId`: Context Fabric execution call id.
- `promptAssemblyId`: Prompt Composer assembly receipt id.
- `mcpInvocationId`: Agent Execution Runtime invocation id.
- `agentRunId`: Workgraph agent run row id, when a node creates one.

Rules:

- Do not substitute `workflowInstanceId` for `traceId` when an explicit
  `traceId` exists.
- Cached or reused content may share hashes, but run-owned receipt rows must
  remain tied to the current `traceId` and `workflowInstanceId`.
- Audit events use `traceId`; payloads may include child ids for joins.
- HTTP calls that cross service boundaries must propagate W3C `traceparent`
  for OpenTelemetry stitching and should also carry `x-singularity-trace-id`
  when an application-level `traceId` is already known. Workgraph's Context
  Fabric client injects both on `/execute`, governed execution, resume, and
  internal code-change lookups.

## Shared Types

- Agent-and-Tools exports `TraceContractIds` from `@agentandtools/shared`.
- Workgraph exports the same shape from `@workgraph/shared-types`.

These types are intentionally small: they define the correlation ids carried in
payloads, while each service keeps ownership of its own persistence schema.
