import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const page = fs.readFileSync(path.join(process.cwd(), "src/app/capabilities/[id]/page.tsx"), "utf8");

assert.match(
  page,
  /const \[refreshResult, setRefreshResult\] = useState<Record<string, unknown> \| null>\(null\);/,
  "capability detail should retain the structured learning-worker response, not only a flat message",
);

assert.match(
  page,
  /const workerResult = asObject\(worker\);[\s\S]*?setRefreshResult\(workerResult\);[\s\S]*?const notes = \[\.\.\.asStringArray\(workerResult\.warnings\), \.\.\.asStringArray\(workerResult\.nextActions\)\]/,
  "sync and grounding actions should normalize worker diagnostics before reducing them to user-facing notes",
);

assert.match(
  page,
  /<LearningWorkerResultPanel title="Last learning action" result=\{refreshResult\} \/>/,
  "top-level capability sync/grounding actions should render structured diagnostics",
);

assert.match(
  page,
  /<LearningWorkerResultPanel title="Last approved-source sync" result=\{syncResult\} \/>/,
  "bootstrap approved-source sync should use the same structured diagnostics panel instead of raw JSON only",
);

assert.match(
  page,
  /function LearningWorkerResultPanel\(\{ title, result \}: \{ title: string; result: Record<string, unknown> \| null \}\)[\s\S]*?Skipped duplicate source work[\s\S]*?Warnings[\s\S]*?Next actions[\s\S]*?Raw result/,
  "learning result panel should expose duplicate skips, warnings, next actions, and raw details",
);

assert.match(
  page,
  /function sumEmbedded\(value: Record<string, unknown> \| null\): number[\s\S]*?\["knowledge", "memory", "code"\]\.reduce/,
  "learning result panel should summarize re-embedding counts across knowledge, memory, and code",
);

assert.match(
  page,
  /const stored = normalizeStoredArchitectureDiagram\(fromBootstrap\);[\s\S]*?return mergeStoredArchitectureDiagram\(inferred, stored\);/,
  "capability detail should preserve structured bootstrap architecture data instead of discarding it after title/mermaid",
);

assert.match(
  page,
  /function normalizeStoredArchitectureDiagram\(value: unknown\): StoredArchitectureDiagram \| undefined[\s\S]*?normalizeArchitectureLayers\(raw\.layers\)[\s\S]*?normalizeArchitectureHighlights\(raw\.highlights\)/,
  "stored architecture diagrams should normalize provider/bootstrap layers and highlights defensively",
);

assert.match(
  page,
  /function mergeStoredArchitectureDiagram\([\s\S]*?highlights: mergeArchitectureHighlights\(inferred\.highlights, stored\.highlights\),[\s\S]*?layers: mergeArchitectureLayers\(inferred\.layers, stored\.layers\),/,
  "stored architecture layers/highlights should be merged through placeholder-aware guards instead of blindly overriding inferred state",
);

assert.match(
  page,
  /function isPlaceholderArchitectureHighlight\(highlight: ArchitectureHighlight\): boolean \{[\s\S]*?\^\(stack\|api\)\$[\s\S]*?\^\(pending\|stack pending\|api pending\)\$/,
  "legacy bootstrap highlights like Primary stack: Pending should not override safer inferred architecture state",
);

assert.match(
  page,
  /function isPlaceholderArchitectureLayer\(layer: ArchitectureLayer\): boolean \{[\s\S]*?\^\(runtime_stack\|contract\|domain_model\)\$[\s\S]*?layer\.items\.every\(item => \/\\bpending\\b\/i\.test\(item\)\);/,
  "legacy stored layers made only of pending placeholders should not override clearer inferred guidance",
);

assert.match(
  page,
  /const apiSurfaceValue = endpointCount[\s\S]*?"Not learned yet"[\s\S]*?"Document-only"[\s\S]*?"No source"[\s\S]*?\{ key: "api", label: "API surface", value: apiSurfaceValue, detail: apiSurfaceDetail \}/,
  "API surface fallback should explain whether endpoints are not learned, document-only, or missing sources instead of generic Pending",
);

assert.match(
  page,
  /const stackStatusLabel = learnedStackItems\.length > 0 \? "Primary stack" : "Stack status"[\s\S]*?const primaryStack = learnedStackItems\[0\][\s\S]*?"Not learned yet"[\s\S]*?"Document-only"[\s\S]*?"No source"/,
  "stack fallback should render as an explicit status, not as a fake Primary stack value",
);

assert.match(
  page,
  /const runtimeStackItems = learnedStackItems\.length[\s\S]*?"Repository attached; executable stack not learned yet"[\s\S]*?"Document knowledge attached; no executable stack source"[\s\S]*?"No repository or document source attached"/,
  "runtime stack layer should show setup/learning hints when executable stack evidence is absent",
);

assert.match(
  page,
  /\{ key: "stack", label: stackStatusLabel, value: primaryStack, detail: primaryStackDetail \}[\s\S]*?mermaid: buildApplicationMermaid\(name, endpointItems, learnedStackItems, domainItems\)[\s\S]*?codeGraphMermaid: buildApplicationMermaid\(name, endpointItems, learnedStackItems, domainItems\)/,
  "architecture highlights and graph should only use learned stack evidence for runtime labels",
);

assert.match(
  page,
  /function isLearnedStackSignal\(item: string\): boolean \{[\s\S]*?!\/\\b\(pending\|not learned\|needs grounding\|document-only\|no source\|no repository\)\\b\/i\.test\(item\)/,
  "stack signal filter should keep pending/status copy out of learned stack evidence",
);

assert.doesNotMatch(
  page,
  /"Request\/response contract pending"|"Domain model discovery pending"/,
  "capability detail should avoid generic pending labels in architecture fallback layers",
);

console.log("capability learning result panel contract tests passed");
