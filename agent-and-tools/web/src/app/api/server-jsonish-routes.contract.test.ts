import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const helper = read("src/app/api/_json.ts");
const adoption = read("src/app/api/adoption/health/route.ts");
const startPreview = read("src/app/api/start/preview/route.ts");
const startShared = read("src/app/api/start/_shared.ts");
const startLaunch = read("src/app/api/start/launch/route.ts");
const onboardingState = read("src/app/api/onboarding/state/route.ts");
const llmSettings = read("src/app/api/llm-settings/route.ts");
const llmModels = read("src/app/api/llm-settings/models/route.ts");
const gitHistory = read("src/app/api/git-history/explain/route.ts");
const promptComposer = read("src/app/api/prompt-workbench/_shared/composer.ts");
const promptPreview = read("src/app/api/prompt-workbench/preview/route.ts");
const promptCompare = read("src/app/api/prompt-workbench/compare/route.ts");
const promptRespond = read("src/app/api/prompt-workbench/respond/route.ts");
const eventHorizonActions = read("src/app/api/event-horizon/actions/route.ts");
const workgraphProxy = read("src/app/api/workgraph/[...path]/route.ts");
const composerProxy = read("src/app/api/composer/[...path]/route.ts");
const runtimeInfrastructure = read("src/app/api/runtime-infrastructure/route.ts");

assert.match(
  helper,
  /export async function readJsonish\(res: Response, maxText = 700\)[\s\S]*?try \{[\s\S]*?JSON\.parse\(raw\)[\s\S]*?catch/,
  "readJsonish should parse JSON when possible and preserve plaintext safely",
);

assert.match(
  helper,
  /export async function readRequestJson\(req: Request, maxText = 700\)[\s\S]*?const raw = await req\.text\(\);[\s\S]*?parseError/,
  "readRequestJson should parse request JSON safely and preserve malformed request text",
);

assert.match(
  helper,
  /export function jsonishMessage\(value: unknown, fallback: string, maxText = 700\)/,
  "jsonishMessage should centralize message extraction from parsed-or-plaintext bodies",
);

for (const [label, source] of [
  ["adoption health", adoption],
  ["start shared", startShared],
  ["start launch", startLaunch],
  ["llm settings", llmSettings],
  ["llm models", llmModels],
  ["git history", gitHistory],
  ["prompt workbench composer", promptComposer],
  ["event horizon actions", eventHorizonActions],
  ["workgraph proxy", workgraphProxy],
  ["composer proxy", composerProxy],
  ["runtime infrastructure", runtimeInfrastructure],
] as const) {
  assert.match(source, /readJsonish/, `${label} should use readJsonish for upstream bodies`);
}

for (const [label, source] of [
  ["start preview", startPreview],
  ["start launch", startLaunch],
  ["onboarding state", onboardingState],
  ["llm model writes", llmModels],
  ["git history explain", gitHistory],
  ["prompt preview", promptPreview],
  ["prompt compare", promptCompare],
  ["prompt respond", promptRespond],
] as const) {
  assert.match(source, /readRequestJson/, `${label} should use readRequestJson for request bodies`);
  assert.doesNotMatch(source, /await (req|request)\.json\(\)/, `${label} should not call req.json()/request.json() directly`);
  assert.match(source, /parseError[\s\S]*?Request body must be valid JSON/, `${label} should return a clear 400 for malformed JSON`);
}

assert.doesNotMatch(
  gitHistory,
  /const parsed = text \? JSON\.parse\(text\)/,
  "git history runtime dispatch should not directly parse Context Fabric responses",
);

assert.doesNotMatch(
  gitHistory,
  /\.json\(\)\.catch/,
  "git history should use readJsonish for IAM and runtime bridge response bodies",
);

assert.match(
  llmModels,
  /code: "LLM_GATEWAY_REQUEST_FAILED"[\s\S]*?message: jsonishMessage\(responseBody\.data/,
  "LLM model writes should return structured JSON when the gateway returns plaintext errors",
);

assert.match(
  promptComposer,
  /details: envelope\?\.error\?\.details \?\? \(responseBody\.parseError \? \{ body: responseBody\.text, parseError: responseBody\.parseError \} : payload\)/,
  "Prompt Workbench composer errors should preserve plaintext/invalid-JSON upstream details safely",
);

assert.doesNotMatch(
  eventHorizonActions,
  /JSON\.parse\(text\)|await r\.json\(\)/,
  "Event Horizon action catalog should not directly parse upstream JSON",
);

assert.match(
  workgraphProxy,
  /import \{ readJsonish \} from "\.\.\/\.\.\/_json";/,
  "Workgraph proxy should use the shared jsonish helper for IAM/service-token upstream responses",
);

assert.match(
  workgraphProxy,
  /async function readJsonObject\(res: Response\): Promise<Record<string, unknown>> \{[\s\S]*?const body = await readJsonish\(res\);[\s\S]*?body\.data as Record<string, unknown>/,
  "Workgraph proxy service-token minting should parse JSON-or-text IAM responses through readJsonish",
);

assert.doesNotMatch(
  workgraphProxy,
  /async function readJsonObject[\s\S]*?await res\.text\(\)[\s\S]*?JSON\.parse\(text\)/,
  "Workgraph proxy should not hand-parse IAM response text while minting service tokens",
);

assert.doesNotMatch(
  runtimeInfrastructure,
  /JSON\.parse\(text\)|await res\.text\(\)/,
  "Runtime infrastructure health probes should not hand-parse upstream response text",
);

console.log("server jsonish route contract tests passed");
