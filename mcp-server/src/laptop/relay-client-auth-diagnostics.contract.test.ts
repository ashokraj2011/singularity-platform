import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const relayClientSource = fs.readFileSync(path.join(process.cwd(), "src/laptop/relay-client.ts"), "utf8");

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
  /function runtimeTokenDiagnostic\(token: string\): RuntimeTokenDiagnostic[\s\S]*?Buffer\.from\(parts\[1\] \?\? "", "base64url"\)[\s\S]*?kind: stringClaim\(payload\.kind\)[\s\S]*?expires_at: expiresAt/,
  "runtime token diagnostics should decode JWT claims without logging the token value",
);

console.log("mcp runtime bridge auth diagnostics contract passed");
