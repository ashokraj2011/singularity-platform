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

    const minted = await fetch(`${base}/mcp/tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subject: "contract-user",
        client: "contract-test",
        origin: "laptop",
        scopes: ["tools:list", "tools:call"],
        ttlSeconds: 300,
      }),
    });
    assert.equal(minted.status, 201);
    const tokenBody = await minted.json() as { token: string; jti: string };

    const sessionAuthenticated = await fetch(`${base}/llm/models`, {
      headers: { authorization: `Bearer ${tokenBody.token}` },
    });
    assert.equal(sessionAuthenticated.status, 200);

    const scopedTools = await fetch(`${base}/mcp/tools/list`, {
      headers: { authorization: `Bearer ${tokenBody.token}` },
    });
    assert.equal(scopedTools.status, 200);

    const narrowMint = await fetch(`${base}/mcp/tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ subject: "contract-user", client: "scope-test", scopes: ["events:read"], ttlSeconds: 300 }),
    });
    assert.equal(narrowMint.status, 201);
    const narrowBody = await narrowMint.json() as { token: string; jti: string };
    const missingScope = await fetch(`${base}/mcp/tools/list`, {
      headers: { authorization: `Bearer ${narrowBody.token}` },
    });
    assert.equal(missingScope.status, 401);

    const revoked = await fetch(`${base}/mcp/tokens/${tokenBody.jti}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.MCP_BEARER_TOKEN}` },
    });
    assert.equal(revoked.status, 200);

    const sessionAfterRevoke = await fetch(`${base}/llm/models`, {
      headers: { authorization: `Bearer ${tokenBody.token}` },
    });
    assert.equal(sessionAfterRevoke.status, 401);
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
