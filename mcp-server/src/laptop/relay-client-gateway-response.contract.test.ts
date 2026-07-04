import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const relayClientSource = fs.readFileSync(path.join(process.cwd(), "src/laptop/relay-client.ts"), "utf8");

assert.match(
  relayClientSource,
  /import \{ readUpstreamJsonBody, upstreamSnippet \} from "\.\.\/lib\/upstream-json";/,
  "laptop relay should use the shared upstream JSON parser for local gateway responses",
);

assert.match(
  relayClientSource,
  /async function runModelViaLocalGateway\(body: unknown\): Promise<unknown> \{[\s\S]*?readUpstreamJsonBody\(res\)[\s\S]*?local gateway returned invalid JSON[\s\S]*?local gateway returned empty JSON response[\s\S]*?return parsed\.data;/,
  "model-run relay should reject malformed or empty 2xx local gateway responses clearly",
);

assert.doesNotMatch(
  relayClientSource,
  /runModelViaLocalGateway[\s\S]*?return res\.json\(\);/,
  "model-run relay should not call res.json() directly",
);

console.log("mcp laptop relay local gateway response contract passed");
