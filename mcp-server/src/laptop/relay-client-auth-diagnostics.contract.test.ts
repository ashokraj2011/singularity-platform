import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const relayClientSource = fs.readFileSync(path.join(process.cwd(), "src/laptop/relay-client.ts"), "utf8");
const diagnosticSource = fs.readFileSync(path.join(process.cwd(), "src/laptop/runtime-token-diagnostic.ts"), "utf8");

assert.match(
  relayClientSource,
  /private loggedTokenDiagnostic = false;[\s\S]*?private loggedAuthFailureHint = false;/,
  "relay client should log token diagnostics once and auth rejection hints once",
);

assert.match(
  relayClientSource,
  /start\(\): void \{[\s\S]*?this\.logRuntimeTokenDiagnostic\(\);[\s\S]*?void this\.connect\(\);/,
  "relay client should describe the runtime token identity before connecting",
);

assert.match(
  relayClientSource,
  /Unexpected server response:[\s\S]*?401\|403[\s\S]*?this\.logBridgeAuthFailureHint\(err\.message\)/,
  "relay client should turn bridge 401/403 handshakes into an actionable auth hint",
);

assert.match(
  relayClientSource,
  /tokenKind:[\s\S]*?tokenSubject:[\s\S]*?tokenRuntimeId:[\s\S]*?tokenTenantId:[\s\S]*?helloRuntimeId:/,
  "token diagnostics must show only redacted identity fields needed to debug routing",
);

assert.match(
  relayClientSource,
  /runtime token identity \(redacted\)/,
  "token diagnostics should clearly mark identity output as redacted",
);

assert.match(
  relayClientSource,
  /bridge rejected the runtime token; check JWT_SECRET, token expiry, kind=runtime\/device, sub=user id, and runtime_id/,
  "bridge auth failures should explain the likely token/JWT_SECRET causes",
);

assert.match(
  relayClientSource,
  /import \{ runtimeTokenDiagnostic \} from "\.\/runtime-token-diagnostic";/,
  "relay client should use the bounded runtime-token diagnostic parser",
);

assert.match(
  diagnosticSource,
  /RUNTIME_TOKEN_MAX_BYTES = 16 \* 1024[\s\S]*?decodeJwtObject\(parts\[0\][\s\S]*?decodeJwtObject\(parts\[1\][\s\S]*?stringClaim\(payload\.runtime_id, 128\)/,
  "runtime token diagnostics should bound token size and decode object claims without logging the token value",
);

console.log("mcp runtime bridge auth diagnostics contract passed");
