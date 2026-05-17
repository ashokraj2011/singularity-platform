import dotenv from "dotenv";
import { z } from "zod";
import { assertProductionSecret } from "@agentandtools/shared";

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

export const env = parsed.data;
