import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.match(
  service,
  /const reusedLearningCandidateIds: string\[\] = \[\];[\s\S]*?const persisted = await persistCapabilityLearningCandidate\([\s\S]*?persisted\.bootstrapRunId && persisted\.bootstrapRunId !== run\.id[\s\S]*?reusedLearningCandidateIds\.push\(persisted\.id\)/,
  "bootstrap discovery must record reused learning candidates instead of hiding them from the current run",
);

assert.match(
  service,
  /reusedLearningCandidateIds: Array\.from\(new Set\(reusedLearningCandidateIds\)\)/,
  "bootstrap run sourceSummary must expose reused learning candidate ids",
);

assert.match(
  service,
  /jsonStringArray\(jsonRecord\(run\.sourceSummary\)\.reusedLearningCandidateIds\)[\s\S]*?capabilityLearningCandidate\.findMany\([\s\S]*?id: \{ in: reusedLearningCandidateIds \}[\s\S]*?candidates: Array\.from\(candidatesById\.values\(\)\)\.sort\(compareLearningCandidatesForReview\)/,
  "getBootstrapRun must merge reused candidates into the response without changing historical ownership",
);

assert.match(
  service,
  /if \(input\.bootstrapRunId !== undefined && !existing\.bootstrapRunId\) \{[\s\S]*?next\.bootstrapRunId = input\.bootstrapRunId/,
  "existing candidate bootstrapRunId may only be filled when empty",
);

assert.doesNotMatch(
  service,
  /existing\.bootstrapRunId !== input\.bootstrapRunId/,
  "candidate persistence must not move existing candidates between bootstrap runs",
);

console.log("capability learning candidate run reuse contract tests passed");
