// M29 — composer's Prisma client lives at apps/prompt-composer/generated/
// (set by `output` in prisma/schema.prisma) so workspace-shared node_modules
// can't clobber it with agent-runtime's narrower client.
import { PrismaClient } from "../../generated/prisma-client";
import { env } from "./env";

export const prisma = new PrismaClient({
  log: env.LOG_LEVEL === "debug" ? ["query", "error", "warn"] : ["error", "warn"],
});
