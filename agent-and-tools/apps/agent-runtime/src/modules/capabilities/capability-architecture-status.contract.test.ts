import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const service = fs.readFileSync(path.join(process.cwd(), "src/modules/capabilities/capability.service.ts"), "utf8");

assert.match(
  service,
  /const stackStatusValue = stackEvidenceItems\[0\][\s\S]*?"Not learned yet"[\s\S]*?"Document-only"[\s\S]*?"No source"/,
  "bootstrap architecture should distinguish unlearned repository, document-only, and missing-source stack states",
);

assert.match(
  service,
  /const runtimeStackItems = stackEvidenceItems\.length > 0[\s\S]*?"Repository attached; executable stack not learned yet"[\s\S]*?"Document knowledge attached; no executable stack source"[\s\S]*?"No repository or document source attached"/,
  "runtime stack layers should use explicit operator guidance when executable stack evidence is absent",
);

assert.match(
  service,
  /const apiSurfaceValue = endpointTotal[\s\S]*?"Not learned yet"[\s\S]*?"Document-only"[\s\S]*?"No source"/,
  "bootstrap architecture should distinguish unlearned repository, document-only, and missing-source API states",
);

assert.match(
  service,
  /function normalizeArchitectureDiagram\(value: unknown\): CapabilityArchitectureDiagram \| null \{[\s\S]*?\.filter\(layer => layer\.items\.length > 0 && !isPlaceholderArchitectureLayer\(layer\)\)[\s\S]*?\.filter\(highlight => !isPlaceholderArchitectureHighlight\(highlight\)\)/,
  "stored bootstrap architecture should be normalized through placeholder guards before being returned by the API",
);

assert.match(
  service,
  /function isPlaceholderArchitectureHighlight\(highlight: \{ key: string; value: string \}\): boolean \{[\s\S]*?\^\(stack\|api\)\$[\s\S]*?\^\(pending\|stack pending\|api pending\)\$/,
  "legacy stored highlights like stack/API Pending should not be served as architecture evidence",
);

assert.match(
  service,
  /function isPlaceholderArchitectureLayer\(layer: \{ key: string; items: string\[\] \}\): boolean \{[\s\S]*?\^\(runtime_stack\|contract\|domain_model\)\$[\s\S]*?layer\.items\.every\(item => \/\\bpending\\b\/i\.test\(item\)\)/,
  "legacy stored layers made only of pending placeholders should not make a bootstrap diagram look authoritative",
);

assert.doesNotMatch(
  service,
  /value:\s*frameworkSummary\[0\]\s*\?\?\s*languageSummary\[0\]\s*\?\?\s*"Pending"/,
  "Primary stack highlights must not store generic Pending as architecture evidence",
);

assert.doesNotMatch(
  service,
  /"API surface pending discovery"|"Language discovery pending"|"Framework discovery pending"|"Build tooling pending"|"Request\/response contract pending"/,
  "architecture layers should avoid generic pending placeholders that read like broken data",
);

console.log("capability architecture status contract tests passed");
