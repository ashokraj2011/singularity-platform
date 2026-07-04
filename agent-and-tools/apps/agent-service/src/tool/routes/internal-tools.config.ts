import { boundedEnvInteger, boundedEnvNumber } from "../lib/env";

export function internalToolsConfig() {
  return {
    recencyBoostDays: boundedEnvInteger("EMBEDDING_RECENCY_DAYS", {
      defaultValue: 30,
      min: 1,
      max: 3650,
    }),
    recencyBoostMax: boundedEnvNumber("EMBEDDING_RECENCY_BOOST", {
      defaultValue: 0.2,
      min: 0,
      max: 1,
    }),
  };
}
