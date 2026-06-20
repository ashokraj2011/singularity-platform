import assert from "assert";
import { assertAgentSourceUrlAllowed } from "./agent-source-url-policy";

async function rejects(pattern: RegExp, fn: () => Promise<unknown>) {
  let rejected = false;
  try {
    await fn();
  } catch (err) {
    rejected = true;
    assert.match((err as Error).message, pattern);
  }
  assert.equal(rejected, true, `expected rejection matching ${pattern}`);
}

async function main() {
  const publicUrl = await assertAgentSourceUrlAllowed("https://provider.example/manifest.json", { resolveDns: false });
  assert.equal(publicUrl.hostname, "provider.example");

  await rejects(/absolute/, () => assertAgentSourceUrlAllowed("/relative/manifest.json", { resolveDns: false }));
  await rejects(/http or https/, () => assertAgentSourceUrlAllowed("file:///etc/passwd", { resolveDns: false }));
  await rejects(/embedded credentials/, () => assertAgentSourceUrlAllowed("https://embedded-user@example.com/manifest.json", { resolveDns: false }));
  await rejects(/private, local, or metadata/, () => assertAgentSourceUrlAllowed("http://localhost:8080/manifest.json", { resolveDns: false }));
  await rejects(/private, local, or metadata/, () => assertAgentSourceUrlAllowed("https://127.0.0.1/manifest.json", { resolveDns: false }));
  await rejects(/private, local, or metadata/, () => assertAgentSourceUrlAllowed("https://10.1.2.3/manifest.json", { resolveDns: false }));
  await rejects(/private, local, or metadata/, () => assertAgentSourceUrlAllowed("https://169.254.169.254/latest/meta-data", { resolveDns: false }));
  await rejects(/private, local, or metadata/, () => assertAgentSourceUrlAllowed("https://metadata.google.internal/computeMetadata/v1", { resolveDns: false }));

  const localOverride = await assertAgentSourceUrlAllowed("http://localhost:8080/manifest.json", { allowPrivateUrls: true, resolveDns: false });
  assert.equal(localOverride.hostname, "localhost");

  console.log("agent source URL policy contract tests passed");
}

main();
