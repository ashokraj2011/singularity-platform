import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const serviceSource = readFileSync(path.resolve(__dirname, "compose.service.ts"), "utf8");

assert(
  !serviceSource.includes("trace_id:       input.workflowContext.instanceId"),
  "audit events must not use workflow instance id when a resolved trace id exists",
);
assert(
  !serviceSource.includes("trace_id: input.workflowContext.instanceId"),
  "Context Fabric calls must not use workflow instance id when a resolved trace id exists",
);
assert(
  !serviceSource.includes("body = `[artifact ${art.label}: stored at ${art.minioRef}"),
  "MinIO-only artifacts must not inject fake placeholder content",
);
assert(
  !serviceSource.includes("MinIO fetch is not implemented"),
  "MinIO-only artifacts must not leave fake/placeholder fetch behavior in the prompt path",
);
assert(
  serviceSource.includes("fetchArtifactContent"),
  "MinIO/document references must route through the governed artifact fetch path",
);
assert(
  !serviceSource.includes("data: { evidenceRefs: evidenceRefs as never }"),
  "cached PromptAssembly rows must not be mutated across workflow runs",
);
assert(
  serviceSource.includes("requiresApprovalForDiscoveredTool"),
  "dynamic tool discovery must preserve approval requirements",
);
assert(
  serviceSource.includes("trace_id:       resolvedTraceId ?? input.workflowContext.instanceId"),
  "prompt audit events should use the resolved trace id",
);
assert(
  serviceSource.includes("trace_id: resolvedTraceId ?? input.workflowContext.instanceId"),
  "Context Fabric execution should use the resolved trace id",
);

console.log("prompt composer hardening contract tests passed");
