import assert from "node:assert/strict";
import { fetchGitHubFile, fetchGitHubTree } from "./source-discover";

type FetchCall = { url: string; init?: RequestInit };

const originalFetch = globalThis.fetch;
const envKeys = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "MCP_GIT_TOKEN",
  "MCP_GIT_TOKEN_ENV",
  "SINGULARITY_RUNTIME_SHARED",
  "SINGULARITY_RUNTIME_TOKEN",
  "SINGULARITY_DEVICE_TOKEN",
  "MCP_GIT_BROKER_ENFORCE",
  "CUSTOM_GITHUB_TOKEN",
] as const;
const originalEnv = new Map<string, string | undefined>(
  envKeys.map((key) => [key, process.env[key]]),
);

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function disableSharedRuntimeGitBrokerEnforcement(): void {
  process.env.SINGULARITY_RUNTIME_SHARED = "false";
  process.env.MCP_GIT_BROKER_ENFORCE = "false";
  delete process.env.SINGULARITY_RUNTIME_TOKEN;
  delete process.env.SINGULARITY_DEVICE_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.MCP_GIT_TOKEN;
  delete process.env.MCP_GIT_TOKEN_ENV;
}

function installFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

async function main(): Promise<void> {
  disableSharedRuntimeGitBrokerEnforcement();
  process.env.GITHUB_TOKEN = "github-token-for-contract-test";

  let calls = installFetchMock((url, init) => {
    assert.equal(url, "https://api.github.com/repos/acme/rules/contents/src/main/pom.xml?ref=main");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer github-token-for-contract-test");
    return new Response(JSON.stringify({
      type: "file",
      encoding: "base64",
      content: Buffer.from("<project />", "utf8").toString("base64"),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(await fetchGitHubFile("https://github.com/acme/rules.git", "main", "src/main/pom.xml"), "<project />");
  assert.equal(calls.length, 1);

  process.env.SINGULARITY_RUNTIME_SHARED = "true";
  process.env.MCP_GIT_BROKER_ENFORCE = "true";
  delete process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = "ghp-shared-runtime-global-token";
  calls = installFetchMock((url, init) => {
    assert.equal(url, "https://api.github.com/repos/acme/rules/git/trees/main?recursive=1");
    assert.equal((init?.headers as Record<string, string>).authorization, undefined);
    return new Response(JSON.stringify({ tree: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual(await fetchGitHubTree("https://github.com/acme/rules", "main"), []);
  assert.equal(calls.length, 1);

  process.env.MCP_GIT_TOKEN_ENV = "CUSTOM_GITHUB_TOKEN";
  process.env.CUSTOM_GITHUB_TOKEN = "github_pat_custom_shared_runtime_global_token";
  calls = installFetchMock((url, init) => {
    assert.equal(url, "https://api.github.com/repos/acme/rules/git/trees/main?recursive=1");
    assert.equal((init?.headers as Record<string, string>).authorization, undefined);
    return new Response(JSON.stringify({ tree: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual(await fetchGitHubTree("https://github.com/acme/rules", "main"), []);
  assert.equal(calls.length, 1);

  disableSharedRuntimeGitBrokerEnforcement();
  process.env.GITHUB_TOKEN = "github-token-for-contract-test";

  calls = installFetchMock(() => new Response("not found", { status: 404 }));
  assert.equal(await fetchGitHubFile("https://github.com/acme/rules", "main", "missing.md"), "");
  assert.equal(calls.length, 1);

  calls = installFetchMock((url, init) => {
    if (calls.length === 1) {
      assert.equal(url, "https://api.github.com/repos/acme/rules/contents/big.txt?ref=main");
      assert.equal((init?.headers as Record<string, string>).accept, "application/vnd.github+json");
      return new Response(JSON.stringify({
        type: "file",
        content: "",
        encoding: "none",
        download_url: "https://raw.githubusercontent.com/acme/rules/main/big.txt",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    assert.equal(url, "https://api.github.com/repos/acme/rules/contents/big.txt?ref=main");
    assert.equal((init?.headers as Record<string, string>).accept, "application/vnd.github.raw");
    return new Response("large file through api host", { status: 200 });
  });
  assert.equal(await fetchGitHubFile("https://github.com/acme/rules", "main", "big.txt"), "large file through api host");
  assert.equal(calls.length, 2);

  installFetchMock(() => new Response("forbidden", {
    status: 403,
    headers: {
      "x-ratelimit-resource": "core",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1783019999",
    },
  }));
  await assert.rejects(
    () => fetchGitHubFile("https://github.com/acme/rules", "main", "README.md"),
    /GitHub file lookup forbidden or rate limited \(resource=core remaining=0 reset=1783019999\)/,
  );

  installFetchMock(() => new Response("boom", { status: 500 }));
  await assert.rejects(
    () => fetchGitHubFile("https://github.com/acme/rules", "main", "README.md"),
    /GitHub file lookup failed \(500\)/,
  );

  installFetchMock(() => new Response("Internal Server Error", { status: 200 }));
  await assert.rejects(
    () => fetchGitHubFile("https://github.com/acme/rules", "main", "README.md"),
    /GitHub file lookup returned invalid JSON \(200\)/,
  );

  calls = installFetchMock((url, init) => {
    assert.equal(url, "https://api.github.com/repos/acme/rules/git/trees/main?recursive=1");
    assert.equal((init?.headers as Record<string, string>).accept, "application/vnd.github+json");
    return new Response(JSON.stringify({
      tree: [
        { path: "pom.xml", type: "blob", size: 1200 },
        { path: "src", type: "tree" },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual(await fetchGitHubTree("https://github.com/acme/rules", "main"), [
    { path: "pom.xml", type: "blob", size: 1200 },
    { path: "src", type: "tree", size: 0 },
  ]);
  assert.equal(calls.length, 1);

  installFetchMock(() => new Response("<html>nope</html>", { status: 200 }));
  await assert.rejects(
    () => fetchGitHubTree("https://github.com/acme/rules", "main"),
    /GitHub tree lookup returned invalid JSON \(200\)/,
  );
}

void main()
  .finally(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  })
  .then(() => {
    console.log("mcp source discovery contract tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
