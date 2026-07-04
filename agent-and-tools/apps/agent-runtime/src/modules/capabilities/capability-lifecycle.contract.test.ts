import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const lifecycle = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability-lifecycle.ts"), "utf8");
const capabilityService = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");
const pollWorker = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/poll-worker.ts"), "utf8");
const agentService = fs.readFileSync(path.join(process.cwd(), "src/modules/agents/agent.service.ts"), "utf8");
const executionService = fs.readFileSync(path.join(process.cwd(), "src/modules/executions/execution.service.ts"), "utf8");
const memoryService = fs.readFileSync(path.join(process.cwd(), "src/modules/memory/memory.service.ts"), "utf8");
const pkg = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");

assert.match(
  lifecycle,
  /export const ARCHIVED_CAPABILITY_STATUS = "ARCHIVED";[\s\S]*?export function isArchivedCapability[\s\S]*?export function assertCapabilityNotArchived[\s\S]*?export async function requireActiveCapability[\s\S]*?throw new NotFoundError\("Capability not found"\)[\s\S]*?assertCapabilityNotArchived\(capability, message\)/,
  "capability lifecycle helper should own the canonical active/archive guard and not-found behavior",
);

assert.match(
  lifecycle,
  /export async function capabilityIsArchivedOrMissing[\s\S]*?return !capability \|\| isArchivedCapability\(capability\);/,
  "runtime poll paths should be able to fail closed when the capability row disappears",
);

assert.doesNotMatch(
  capabilityService,
  /function assertCapabilityNotArchived\(capability: \{ status: string \}\)/,
  "capability.service should import the lifecycle helper instead of redefining archived guards",
);

for (const [name, source] of [
  ["capability.service", capabilityService],
  ["agent.service", agentService],
] as const) {
  assert.match(
    source,
    /requireActiveCapability/,
    `${name} should use the shared lifecycle helper for archived capability write guards`,
  );
}

assert.match(
  executionService,
  /import \{ assertCapabilityNotArchived \} from "\.\.\/capabilities\/capability-lifecycle";[\s\S]*?assertExecutionCapabilityWritable[\s\S]*?FOR UPDATE[\s\S]*?assertCapabilityNotArchived\(capability, "Cannot create an execution for an archived capability\."\)/,
  "execution.service should use the shared lifecycle helper after locking the capability row for execution creation",
);

assert.match(
  memoryService,
  /import \{ assertCapabilityNotArchived \} from "\.\.\/capabilities\/capability-lifecycle";[\s\S]*?assertMemoryCapabilityWritable[\s\S]*?FOR UPDATE[\s\S]*?assertCapabilityNotArchived\(capability, archivedMessage\)/,
  "memory.service should use the shared lifecycle helper after locking the capability row for memory writes",
);

assert.match(
  pollWorker,
  /import \{ capabilityIsArchivedOrMissing \} from "\.\/capability-lifecycle";[\s\S]*?assertCapabilityPollable[\s\S]*?capabilityIsArchivedOrMissing\(capabilityId\)[\s\S]*?pollOneRepo[\s\S]*?capabilityIsArchivedOrMissing\(r\.capabilityId\)[\s\S]*?pollOneSource[\s\S]*?capabilityIsArchivedOrMissing\(s\.capabilityId\)/,
  "poll worker should share the lifecycle helper before expensive repo or URL work",
);

assert.match(
  capabilityService,
  /async reviewBootstrapRun[\s\S]*?await requireActiveCapability\(capabilityId\);[\s\S]*?async syncCapability[\s\S]*?await requireActiveCapability\(capabilityId\);[\s\S]*?async runLearningWorker[\s\S]*?await requireActiveCapability\(capabilityId\);/,
  "learning review, approved source sync, and worker runs should all use the shared active-capability guard",
);

assert.match(
  pkg,
  /capability-lifecycle\.contract\.test\.ts/,
  "agent-runtime contract suite should include capability lifecycle centralization checks",
);

console.log("capability lifecycle contract tests passed");
