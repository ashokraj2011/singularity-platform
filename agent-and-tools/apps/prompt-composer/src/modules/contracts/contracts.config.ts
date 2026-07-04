import { boundedIntEnv } from "../../shared/env-bounds";

export function contractsConfig() {
  const modelCatalogTimeoutSec = boundedIntEnv("CONTRACT_MODEL_CATALOG_TIMEOUT_SEC", 10, 1, 300);
  return {
    modelCatalogTimeoutSec,
    modelCatalogTimeoutMs: modelCatalogTimeoutSec * 1000,
  };
}
