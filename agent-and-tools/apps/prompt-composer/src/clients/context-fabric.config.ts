import { boundedIntEnv } from "../shared/env-bounds";

export function contextFabricClientConfig() {
  const timeoutSec = boundedIntEnv("CONTEXT_FABRIC_CLIENT_TIMEOUT_SEC", 240, 1, 900);
  return {
    timeoutSec,
    timeoutMs: timeoutSec * 1000,
  };
}
