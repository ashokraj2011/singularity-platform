import assert from "assert";
import fs from "fs";
import path from "path";
import { assertEventTargetUrlAllowed } from "./eventbus/target-url-policy";

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

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

async function main() {
  const publicUrl = await assertEventTargetUrlAllowed("https://93.184.216.34/webhook");
  assert.equal(publicUrl.protocol, "https:");

  await rejects(/absolute/, () => assertEventTargetUrlAllowed("/webhook"));
  await rejects(/http or https/, () => assertEventTargetUrlAllowed("file:///etc/passwd"));
  await rejects(/embedded credentials/, () => assertEventTargetUrlAllowed("https://embedded-user@example.com/webhook"));
  await rejects(/private, local, or metadata/, () => assertEventTargetUrlAllowed("http://localhost:3002/webhook"));
  await rejects(/private, local, or metadata/, () => assertEventTargetUrlAllowed("http://127.0.0.1:3002/webhook"));
  await rejects(/private, local, or metadata/, () => assertEventTargetUrlAllowed("http://10.0.0.5/webhook"));
  await rejects(/private, local, or metadata/, () => assertEventTargetUrlAllowed("http://169.254.169.254/latest/meta-data"));
  await rejects(/private, local, or metadata/, () => assertEventTargetUrlAllowed("http://metadata.google.internal/computeMetadata/v1"));

  const routes = readRepoFile("src/lib/eventbus/routes.ts");
  assert.match(routes, /eventSubscriptionsRouter\.use\(requireAuth\)/);
  assert.match(routes, /assertEventTargetUrlAllowed\(body\.targetUrl\)/);

  const dispatcher = readRepoFile("src/lib/eventbus/dispatcher.ts");
  assert.match(dispatcher, /const safeUrl = await assertEventTargetUrlAllowed\(targetUrl\)/);
  assert.match(dispatcher, /fetch\(safeUrl,/);

  console.log("tool-service event target URL policy contracts passed");
}

void main();
