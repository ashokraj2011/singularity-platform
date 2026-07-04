import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const page = fs.readFileSync(path.join(process.cwd(), "src/app/capabilities/[id]/page.tsx"), "utf8");

assert.match(
  page,
  /import \{ ApiError, apiPath,/,
  "capability detail should import ApiError for typed learning-worker conflict handling",
);

assert.match(
  page,
  /useSWR\([\s\S]*?`cap-grounding-\$\{id\}`[\s\S]*?refreshInterval: latest => isLearningWorkerBusy\(asOptionalObject\(latest\)\) \? 2500 : 0/,
  "capability detail should poll grounding status while the server reports an active learning worker",
);

assert.match(
  page,
  /const groundingStatusObject = asOptionalObject\(groundingStatus\) \?\? asOptionalObject\(c\.learningStatus\);[\s\S]*?const groundingRunning = isGroundingRunning\(groundingStatusObject\);[\s\S]*?const serverLearningBusy = isLearningWorkerBusy\(groundingStatusObject\);[\s\S]*?const learningBusy = localLearningAction \|\| serverLearningBusy;/,
  "capability detail should merge local action state with server-side active learning-worker state",
);

assert.match(
  page,
  /const learningActionInFlightRef = useRef\(false\);[\s\S]*?async function refreshLearning\(\) \{[\s\S]*?if \(learningActionInFlightRef\.current \|\| serverLearningBusy\) return;[\s\S]*?learningActionInFlightRef\.current = true;[\s\S]*?finally \{[\s\S]*?learningActionInFlightRef\.current = false;[\s\S]*?setLearningAction\(null\);/,
  "repository grounding refresh should use a ref latch and server lock state so rapid clicks cannot overlap before React disables the button",
);

assert.match(
  page,
  /async function syncApprovedLearningSources\(\) \{[\s\S]*?if \(learningActionInFlightRef\.current \|\| serverLearningBusy\) return;[\s\S]*?learningActionInFlightRef\.current = true;[\s\S]*?finally \{[\s\S]*?learningActionInFlightRef\.current = false;[\s\S]*?setLearningAction\(null\);/,
  "approved source sync should share the learning-action ref latch and server lock state with repository grounding refresh",
);

assert.match(
  page,
  /const learningBusyTitle = learningWorkerBusyTitle\(groundingStatusObject\);[\s\S]*?disabled=\{learningBusy\}[\s\S]*?serverLearningBusy[\s\S]*?learningBusyTitle[\s\S]*?disabled=\{learningBusy\}[\s\S]*?serverLearningBusy[\s\S]*?learningBusyTitle/,
  "top-level learning actions should be disabled with operation-aware copy while a server-side worker is running",
);

assert.match(
  page,
  /<CapabilityGroundingStatusPanel[\s\S]*?status=\{groundingStatusObject\}[\s\S]*?refreshing=\{learningAction === "grounding"\}/,
  "grounding status panel should consume the normalized server grounding object",
);

assert.match(
  page,
  /const serverRunning = raw === "RUNNING";[\s\S]*?const serverLearningBusy = isLearningWorkerBusy\(status\);[\s\S]*?const activeWorker = asOptionalObject\(status\?\.activeLearningWorker\);[\s\S]*?const refreshDisabled = refreshing \|\| serverLearningBusy;[\s\S]*?disabled=\{refreshDisabled\}[\s\S]*?Worker running\.\.\./,
  "grounding status panel refresh button should stay disabled and labelled while any server-side learning worker is running",
);

assert.match(
  page,
  /function isGroundingRunning\(status\?: Record<string, unknown>\): boolean \{[\s\S]*?status\?\.status \?\? status\?\.preciseState[\s\S]*?=== "RUNNING";/,
  "running-state checks should use one normalized helper for status and preciseState",
);

assert.match(
  page,
  /function isLearningWorkerBusy\(status\?: Record<string, unknown>\): boolean \{[\s\S]*?isGroundingRunning\(status\)[\s\S]*?asOptionalObject\(status\?\.activeLearningWorker\)[\s\S]*?expiresAtMs > Date\.now\(\);/,
  "busy-state checks should use the active learning-worker lock exposed by the status endpoint",
);

assert.match(
  page,
  /catch \(err\) \{[\s\S]*?if \(isLearningWorkerAlreadyRunningError\(err\)\) \{[\s\S]*?await mutateGroundingStatus\(\);[\s\S]*?setRefreshError\(null\);[\s\S]*?A learning refresh is already running for this capability[\s\S]*?return;[\s\S]*?async function syncApprovedLearningSources\(\)[\s\S]*?catch \(err\) \{[\s\S]*?if \(isLearningWorkerAlreadyRunningError\(err\)\) \{[\s\S]*?await mutateGroundingStatus\(\);/,
  "already-running conflicts from both grounding and sync should refresh status and show friendly polling copy instead of a raw 409",
);

assert.match(
  page,
  /function isLearningWorkerAlreadyRunningError\(err: unknown\): boolean \{[\s\S]*?err instanceof ApiError[\s\S]*?err\.status === 409[\s\S]*?\(repository grounding refresh\|approved source sync\) is already running/i,
  "already-running conflict detection should be status- and operation-aware",
);

console.log("capability grounding running UX contract tests passed");
