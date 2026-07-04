import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const pollWorker = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/poll-worker.ts"), "utf8");
const envSource = fs.readFileSync(path.join(process.cwd(), "src/config/env.ts"), "utf8");

assert.match(
  envSource,
  /POLL_WORKER_GIT_NETWORK_TIMEOUT_SEC: boundedInt\([\s\S]*?60,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.POLL_WORKER_GIT_NETWORK_TIMEOUT_SEC/,
  "poll worker Git network timeout should be bounded in agent-runtime env config",
);
assert.match(
  envSource,
  /POLL_WORKER_GIT_LOCAL_TIMEOUT_SEC: boundedInt\([\s\S]*?30,[\s\S]*?1,[\s\S]*?AGENT_RUNTIME_LIMITS\.POLL_WORKER_GIT_LOCAL_TIMEOUT_SEC/,
  "poll worker Git local timeout should be bounded in agent-runtime env config",
);
assert.match(
  pollWorker,
  /const GIT_NETWORK_TIMEOUT_MS = env\.POLL_WORKER_GIT_NETWORK_TIMEOUT_SEC \* 1000;/,
  "poll worker Git clone/fetch timeout must come from bounded env config",
);
assert.match(
  pollWorker,
  /const GIT_LOCAL_TIMEOUT_MS = env\.POLL_WORKER_GIT_LOCAL_TIMEOUT_SEC \* 1000;/,
  "poll worker Git reset timeout must come from bounded env config",
);
assert.doesNotMatch(
  pollWorker,
  /timeout: (?:60_000|30_000)/,
  "poll worker Git commands must not hardcode timeout milliseconds",
);

assert.match(
  pollWorker,
  /import \{ capabilityIsArchivedOrMissing \} from "\.\/capability-lifecycle";[\s\S]*?async function assertCapabilityPollable[\s\S]*?capabilityIsArchivedOrMissing\(capabilityId\)/,
  "poll worker should share an early archived-capability check before expensive sync work",
);

assert.match(
  pollWorker,
  /FROM "CapabilityRepository" r[\s\S]*?JOIN "Capability" c ON c\.id = r\."capabilityId"[\s\S]*?AND c\.status <> 'ARCHIVED'[\s\S]*?const result = await pollOneRepo\(r\);[\s\S]*?if \(result\.skippedArchived\) continue;[\s\S]*?UPDATE "CapabilityRepository"[\s\S]*?c\.status <> 'ARCHIVED'/,
  "scheduled repository polling should exclude archived capabilities and guard final poll metadata writes",
);

assert.match(
  pollWorker,
  /FROM "CapabilityKnowledgeSource" s[\s\S]*?JOIN "Capability" c ON c\.id = s\."capabilityId"[\s\S]*?AND c\.status <> 'ARCHIVED'[\s\S]*?const result = await pollOneSource\(s\);[\s\S]*?if \(result\.skippedArchived\) continue;[\s\S]*?UPDATE "CapabilityKnowledgeSource"[\s\S]*?c\.status <> 'ARCHIVED'/,
  "scheduled knowledge-source polling should exclude archived capabilities and guard final poll metadata writes",
);

assert.match(
  pollWorker,
  /export async function syncRepositoryNow[\s\S]*?await assertCapabilityPollable\(capabilityId, "sync repository sources"\)[\s\S]*?if \(result\.skippedArchived\) throw new ForbiddenError\("Cannot sync repository sources for an archived capability\."\);/,
  "manual repository sync should surface archived races as forbidden instead of a generic failure",
);
assert.doesNotMatch(
  pollWorker,
  /return \{ repoId: repo\.id, repoName: repo\.repoName, \.\.\.result \};/,
  "manual repository sync must not leak internal worker-only flags into public responses",
);

assert.match(
  pollWorker,
  /export async function syncKnowledgeSourceNow[\s\S]*?await assertCapabilityPollable\(capabilityId, "sync knowledge sources"\)[\s\S]*?if \(result\.skippedArchived\) throw new ForbiddenError\("Cannot sync knowledge sources for an archived capability\."\);/,
  "manual knowledge-source sync should surface archived races as forbidden instead of a generic failure",
);
assert.doesNotMatch(
  pollWorker,
  /return \{ sourceId: source\.id, url: source\.url, \.\.\.result \};/,
  "manual knowledge-source sync must not leak internal worker-only flags into public responses",
);

assert.match(
  pollWorker,
  /async function pollOneSource[\s\S]*?if \(await capabilityIsArchivedOrMissing\(s\.capabilityId\)\)[\s\S]*?skippedArchived: true[\s\S]*?const res = await fetch\(s\.url[\s\S]*?capabilityService\.addKnowledge\(s\.capabilityId,\s*\{[\s\S]*?sourceType: "URL_POLL"[\s\S]*?sourceRef: s\.url/,
  "URL polling must skip archived capabilities before fetch and write through addKnowledge with URL_POLL source identity",
);
assert.doesNotMatch(
  pollWorker,
  /capabilityKnowledgeArtifact\.updateMany\(\s*\{[\s\S]*sourceRef:\s*s\.url[\s\S]*status:\s*"ARCHIVED"/,
  "URL polling must not archive the active source-backed artifact before retry-safe writes",
);
assert.match(
  pollWorker,
  /const title = s\.title\?\.trim\(\) \|\| s\.url;/,
  "URL polling must use stable source metadata for artifact title/identity",
);
assert.doesNotMatch(
  pollWorker,
  /extractTitle\(text\)/,
  "URL polling must not derive source-backed artifact identity from mutable fetched headings",
);

console.log("poll worker source idempotency contract tests passed");
