import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const source = read("src/components/workflows/WorkflowDesigner.tsx");

assert.match(
  source,
  /import \{ asRow, asString \} from "@\/lib\/row";/,
  "WorkflowDesigner should use shared row-normalization helpers",
);

assert.match(
  source,
  /useSWR<unknown>\(`\/workflow-templates\/\$\{workflowId\}`[\s\S]*?workgraphFetch<unknown>/,
  "workflow template fetch should enter the designer as unknown data",
);

assert.match(
  source,
  /useSWR<unknown>\(`\/workflow-templates\/\$\{workflowId\}\/design-graph`[\s\S]*?workgraphFetch<unknown>/,
  "design graph fetch should enter the designer as unknown data",
);

assert.match(
  source,
  /const template = useMemo\(\(\) => normalizeWorkflowTemplate\(templateData, workflowId\), \[templateData, workflowId\]\);[\s\S]*?const graph = useMemo\(\(\) => normalizeDesignGraph\(graphData\), \[graphData\]\);/,
  "workflow designer should normalize template and graph payloads before rendering",
);

assert.match(
  source,
  /function normalizeDesignGraph\(value: unknown\): DesignGraph[\s\S]*?const nodes = uniqueById\(unwrapWorkgraphItems<Record<string, unknown>>\(row\.nodes\)\.map\(normalizeDesignNode\)\);[\s\S]*?nodeIds\.has\(edge\.sourceNodeId\) && nodeIds\.has\(edge\.targetNodeId\)/,
  "design graph normalizer should dedupe nodes and drop edges with missing endpoints",
);

assert.match(
  source,
  /function normalizeDesignNode\(value: unknown, index: number\): DesignNode \| null[\s\S]*?config: normalizeConfig\(row\.config\)[\s\S]*?positionX: normalizePosition\(row\.positionX \?\? row\.position_x, 100 \+ index \* 220\)/,
  "design nodes should normalize labels, config, types, and positions before React Flow rendering",
);

assert.match(
  source,
  /function normalizeDesignEdge\(value: unknown\): DesignEdge \| null[\s\S]*?sourceNodeId = asString\(row\.sourceNodeId[\s\S]*?targetNodeId = asString\(row\.targetNodeId[\s\S]*?if \(!sourceNodeId \|\| !targetNodeId \|\| sourceNodeId === targetNodeId\) return null;/,
  "design edges should require distinct source and target node identifiers",
);

assert.match(
  source,
  /function normalizePosition\(value: unknown, fallback: number\): number[\s\S]*?Math\.min\(Math\.max\(Math\.round\(parsed\), -10_000\), 10_000\)/,
  "designer should clamp persisted graph positions before passing them to React Flow",
);

assert.doesNotMatch(
  source,
  /useSWR<WorkflowTemplate>|useSWR<DesignGraph>|workgraphFetch<WorkflowTemplate>|workgraphFetch<DesignGraph>|as WorkflowTemplate|as DesignGraph|graph\?\.nodes|graph\?\.edges/,
  "WorkflowDesigner should not cast template or design graph API responses directly to trusted client types",
);

console.log("workflow designer normalization contract tests passed");
