import { boundedEnvInteger } from "./env";

export function contextFabricSingleTurnConfig() {
  const timeoutSec = boundedEnvInteger("CONTEXT_FABRIC_SINGLE_TURN_TIMEOUT_SEC", {
    defaultValue: 70,
    min: 1,
    max: 300,
  });
  return {
    timeoutSec,
    timeoutMs: timeoutSec * 1000,
  };
}
