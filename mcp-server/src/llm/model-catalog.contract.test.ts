import assert from "node:assert/strict";

async function main() {
  process.env.MCP_LLM_PROVIDER_CONFIG_JSON = JSON.stringify({
    defaultProvider: "mock",
    defaultModel: "mock-fast",
    allowedProviders: ["mock"],
    providers: {
      mock: {
        enabled: true,
        baseUrl: "",
        credentialEnv: "",
        defaultModel: "mock-fast",
        supportsTools: true,
        costTier: "free",
      },
    },
  });
  process.env.MCP_LLM_MODEL_CATALOG_JSON = JSON.stringify([
    {
      id: "mock-fast",
      label: "Mock free",
      provider: "mock",
      model: "mock-fast",
      default: true,
      supportsTools: true,
      costTier: "free",
    },
    {
      id: "mock-standard",
      label: "Mock standard",
      provider: "mock",
      model: "mock-standard",
      supportsTools: true,
      costTier: "standard",
    },
  ]);

  const { modelCatalogResponse } = await import("./model-catalog");
  const body = modelCatalogResponse();

  assert.equal(body.source, "env-json");
  assert.equal(body.defaultModelAlias, "mock-fast");
  assert.deepEqual(body.warnings, []);
  assert.equal(body.models.length, 2);
  assert.equal(body.models[0].costTier, "free");
  assert.equal(body.models[1].costTier, "standard");
  assert.equal(body.providers.find((provider) => provider.name === "mock")?.source, "env-json");
  assert.equal(body.providers.find((provider) => provider.name === "mock")?.ready, true);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
