import { PrismaClient } from "@prisma/client";
import { env } from "./env";

export const prisma = new PrismaClient({
  log: env.LOG_LEVEL === "debug" ? ["query", "error", "warn"] : ["error", "warn"],
});
