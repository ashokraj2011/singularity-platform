import assert from "node:assert/strict";
import http from "node:http";

async function main(): Promise<void> {
  process.env.MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "test-bearer-token-12345";
  process.env.LLM_GATEWAY_URL = process.env.LLM_GATEWAY_URL ?? "mock";
  process.env.MCP_SANDBOX_ROOT = process.env.MCP_SANDBOX_ROOT ?? process.cwd();

  const { app } = await import("../app");
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    const unauthenticated = await fetch(`${base}/llm/models`);
    assert.equal(unauthenticated.status, 401);

    const authenticated = await fetch(`${base}/llm/models`, {
      headers: { authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
    });
    assert.equal(authenticated.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  console.log("mcp http auth contract tests passed");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
