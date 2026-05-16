import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3003),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(8).default("dev-secret-change-in-prod"),
  IAM_SERVICE_URL: z.string().url().optional(),
  IAM_BASE_URL: z.string().url().optional(),
  AUTH_OPTIONAL: z.preprocess(
    (v) => v === undefined ? undefined : String(v).toLowerCase() === "true",
    z.boolean(),
  ).default(process.env.NODE_ENV !== "production"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // M33 — agent-runtime no longer chooses a real LLM provider; that
  // decision is made by the central llm-gateway when prompt-composer
  // composes the request. These two fields are informational defaults
  // stamped on the `agentExecution` row when the caller hasn't provided
  // a model_alias yet.
  AGENT_RUN_FALLBACK_PROVIDER: z.string().default("stub"),
  AGENT_RUN_FALLBACK_MODEL: z.string().default("stub-model"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[env] Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
