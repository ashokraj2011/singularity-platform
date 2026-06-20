import dotenv from "dotenv";
import { z } from "zod";
import { assertProductionInvariant, assertProductionSecret } from "@agentandtools/shared";

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3004),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(8).default("dev-secret-change-in-prod"),
  AUTH_OPTIONAL: z.preprocess(
    (v) => v === undefined ? undefined : String(v).toLowerCase() === "true",
    z.boolean(),
  ).default(process.env.NODE_ENV !== "production"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  TOOL_SERVICE_URL: z.string().url().default("http://localhost:3002"),
  AGENT_RUNTIME_URL: z.string().url().default("http://localhost:3003"),
  CONTEXT_FABRIC_URL: z.string().url().default("http://localhost:8000"),
  CONTEXT_FABRIC_SERVICE_TOKEN: z.string().optional(),
  // Route compose-and-respond's LLM turn through CF's governed SINGLE-TURN
  // endpoint (/api/v1/execute-governed-single-turn). The assembled prompt is
  // sent verbatim (NOT re-assembled), so this adds the governed audit trail
  // without a composer <-> CF cycle. Default on; only opt out for incident
  // recovery while retiring a legacy /execute dependency.
  CONTEXT_FABRIC_GOVERNED_TURN: z.preprocess(
    (v) => v === undefined ? undefined : String(v).toLowerCase() === "true",
    z.boolean(),
  ).default(true),
  LEARNING_SERVICE_URL: z.string().url().optional(),
  LEARNING_SERVICE_TOKEN: z.string().optional(),
  LEARNING_CONTEXT_ENABLED: z.preprocess(
    (v) => v === undefined ? undefined : String(v).toLowerCase() !== "false",
    z.boolean(),
  ).default(true),
  WORKGRAPH_ARTIFACT_FETCH_URL: z.string().url().optional(),
  WORKGRAPH_ARTIFACT_FETCH_TOKEN: z.string().optional(),
  ARTIFACT_FETCH_MAX_BYTES: z.coerce.number().int().positive().max(256_000).default(64_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[env] Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// M35.1 — refuse to start in prod-class envs with a default JWT_SECRET.
assertProductionSecret({ name: "JWT_SECRET", value: parsed.data.JWT_SECRET });
assertProductionSecret({ name: "WORKGRAPH_ARTIFACT_FETCH_TOKEN", value: parsed.data.WORKGRAPH_ARTIFACT_FETCH_TOKEN, minLength: 32, nodeEnv: parsed.data.NODE_ENV });
assertProductionInvariant({
  name: "AUTH_OPTIONAL",
  ok: parsed.data.AUTH_OPTIONAL !== true,
  message: "set AUTH_OPTIONAL=false or omit it; production services must require IAM auth",
  nodeEnv: parsed.data.NODE_ENV,
});
assertProductionInvariant({
  name: "CONTEXT_FABRIC_SERVICE_TOKEN",
  ok: Boolean(parsed.data.CONTEXT_FABRIC_SERVICE_TOKEN),
  message: "set CONTEXT_FABRIC_SERVICE_TOKEN so prompt-composer can call Context Fabric execution endpoints",
  nodeEnv: parsed.data.NODE_ENV,
});

export const env = parsed.data;
