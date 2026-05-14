// M30 — composer uses TWO Prisma clients:
//   • `prisma`        — composer-OWNED tables on `singularity_composer`
//                       (PromptAssembly, PromptProfile, CapabilityCompiledContext, …)
//   • `runtimeReader` — agent-runtime READ-ONLY models on `singularity`
//                       (AgentTemplate, Capability, DistilledMemory, …)
// Each client generates to a per-service output path so the workspace-shared
// node_modules can't cause client clobber.
import { PrismaClient } from "../../generated/prisma-client";
import { PrismaClient as RuntimeReaderClient } from "../../generated/runtime-reader-client";
import { env } from "./env";

const logLevels: ("query" | "error" | "warn")[] =
  env.LOG_LEVEL === "debug" ? ["query", "error", "warn"] : ["error", "warn"];

export const prisma = new PrismaClient({ log: logLevels });

// Read-only client against agent-runtime's DB. Reuses DATABASE_URL if
// DATABASE_URL_RUNTIME_READ is unset (back-compat for local dev that hasn't
// split DBs yet — the runtime-reader's models are still present in shared DB).
const runtimeReadUrl = process.env.DATABASE_URL_RUNTIME_READ || process.env.DATABASE_URL;
export const runtimeReader = new RuntimeReaderClient({
  log: logLevels,
  ...(runtimeReadUrl ? { datasources: { db: { url: runtimeReadUrl } } } : {}),
});
