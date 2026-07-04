import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const source = read("src/components/PlatformTopologyMap.tsx");

assert.match(
  source,
  /import \{ asBoolean, asRow, asRowArray, asString \} from "@\/lib\/row";/,
  "Platform topology map should use shared row-normalization helpers",
);

assert.match(
  source,
  /async function fetchTopology\(\): Promise<Topology>[\s\S]*?return normalizeTopology\(parsed\);/,
  "topology fetcher should normalize parsed API data before rendering",
);

assert.match(
  source,
  /function normalizeTopology\(value: unknown\): Topology[\s\S]*?const nodes = uniqueById\([\s\S]*?asRowArray\(row\.nodes\)[\s\S]*?const nodeIds = new Set\(nodes\.map\(\(node\) => node\.id\)\);[\s\S]*?const edges = uniqueById\([\s\S]*?filter\(\(edge\) => nodeIds\.has\(edge\.source\) && nodeIds\.has\(edge\.target\)\)/,
  "topology normalizer should dedupe nodes and drop edges pointing at missing endpoints",
);

assert.match(
  source,
  /function normalizeTopologyNode\(value: unknown\): TopologyNode \| null[\s\S]*?const id = asString\(row\.id\)\.slice\(0, 120\);[\s\S]*?status,[\s\S]*?position: normalizePosition\(row\.position\)/,
  "node rows should normalize ids, status, booleans, bounded strings, and position",
);

assert.match(
  source,
  /function normalizeTopologyEdge\(value: unknown\): TopologyEdge \| null[\s\S]*?const source = asString\(row\.source\)\.slice\(0, 120\);[\s\S]*?const target = asString\(row\.target\)\.slice\(0, 120\);[\s\S]*?status: normalizeTopologyStatus\(row\.status, "unknown"\)/,
  "edge rows should normalize source, target, labels, protocol, and status",
);

assert.match(
  source,
  /function normalizeTopologySummary\(nodes: TopologyNode\[\], edges: TopologyEdge\[\]\): Topology\["summary"\][\s\S]*?nodeCount: nodes\.length,[\s\S]*?liveEdges: edges\.filter\(\(edge\) => edge\.status === "live"\)\.length,[\s\S]*?edgeCount: edges\.length/,
  "topology summary should be recomputed from normalized nodes and edges",
);

assert.match(
  source,
  /const mapNodes = nodes\.filter\(\(node\): node is TopologyNode & \{ position: \{ x: number; y: number \} \} => node\.position !== null\);/,
  "map nodes should only render after position validation",
);

assert.match(
  source,
  /if \(!source\?\.position \|\| !target\?\.position\) return null;/,
  "edge drawing should skip edges whose endpoints do not have validated positions",
);

assert.doesNotMatch(
  source,
  /return parsed as Topology|parsed as Topology|data\?\.edges\.map\(\(edge\)/,
  "Platform topology map should not cast the topology payload or render raw edges directly",
);

console.log("platform topology normalization contract tests passed");
