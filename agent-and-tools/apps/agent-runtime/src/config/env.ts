import dotenv from "dotenv";
import { z } from "zod";
import { assertProductionInvariant, assertProductionSecret } from "@agentandtools/shared";
import { trustedManifestKeyStrengthIssues } from "../modules/agents/agent-provider-manifest";

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3003),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(8).default("dev-secret-change-in-prod"),
  IAM_SERVICE_URL: z.string().url().optional(),
  IAM_BASE_URL: z.string().url().optional(),
  IAM_SERVICE_TOKEN: z.string().optional(),
  IAM_SERVICE_TOKEN_TENANT_IDS: z.string().default(""),
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
  PROVIDER_MANIFEST_SIGNATURE_MODE: z.enum(["auto", "disabled", "required"]).default("auto"),
  PROVIDER_MANIFEST_TRUSTED_KEYS: z.string().optional(),
  PROVIDER_MANIFEST_MAX_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 60 * 60),
  AGENT_SOURCE_ALLOW_PRIVATE_URLS: z.preprocess(
    (v) => v === undefined ? undefined : String(v).toLowerCase() === "true",
    z.boolean(),
  ).default(false),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[env] Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// M35.1 — refuse to start in prod-class envs with a default JWT_SECRET.
assertProductionSecret({ name: "JWT_SECRET", value: parsed.data.JWT_SECRET });
assertProductionInvariant({
  name: "AUTH_OPTIONAL",
  ok: parsed.data.AUTH_OPTIONAL !== true,
  message: "set AUTH_OPTIONAL=false or omit it; production services must require IAM auth",
  nodeEnv: parsed.data.NODE_ENV,
});
assertProductionInvariant({
  name: "PROVIDER_MANIFEST_SIGNATURE_MODE",
  ok: parsed.data.PROVIDER_MANIFEST_SIGNATURE_MODE === "required",
  message: "provider manifests must be signed in production-class environments; set PROVIDER_MANIFEST_SIGNATURE_MODE=required",
  nodeEnv: parsed.data.NODE_ENV,
});
const manifestKeyStrengthIssues = trustedManifestKeyStrengthIssues(parsed.data.PROVIDER_MANIFEST_TRUSTED_KEYS);
assertProductionInvariant({
  name: "PROVIDER_MANIFEST_TRUSTED_KEYS",
  ok: manifestKeyStrengthIssues.length === 0,
  message: manifestKeyStrengthIssues[0] ?? "provider manifest trusted keys must be strong",
  nodeEnv: parsed.data.NODE_ENV,
});
assertProductionInvariant({
  name: "AGENT_SOURCE_ALLOW_PRIVATE_URLS",
  ok: parsed.data.AGENT_SOURCE_ALLOW_PRIVATE_URLS !== true,
  message: "private/local agent source URLs must stay disabled in production-class environments",
  nodeEnv: parsed.data.NODE_ENV,
});
assertProductionInvariant({
  name: "IAM_SERVICE_TOKEN",
  ok: Boolean(parsed.data.IAM_SERVICE_TOKEN)
    || (Boolean(process.env.IAM_BOOTSTRAP_USERNAME) && Boolean(process.env.IAM_BOOTSTRAP_PASSWORD)),
  message: "set IAM_SERVICE_TOKEN or IAM_BOOTSTRAP_USERNAME/IAM_BOOTSTRAP_PASSWORD so agent-runtime can authenticate service-to-service calls to IAM and Prompt Composer",
  nodeEnv: parsed.data.NODE_ENV,
});

export const env = parsed.data;
