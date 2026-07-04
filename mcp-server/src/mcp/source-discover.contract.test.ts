import assert from "node:assert/strict";
import { fetchGitHubFile, fetchGitHubTree } from "./source-discover";

type FetchCall = { url: string; init?: RequestInit };

const originalFetch = globalThis.fetch;

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
  })
  .then(() => {
    console.log("mcp source discovery contract tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
