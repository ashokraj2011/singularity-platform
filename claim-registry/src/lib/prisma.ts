import { PrismaClient } from '@prisma/client';

// Single client for the service. claim-registry owns its DB outright
// (DATABASE_URL_CLAIM_REGISTRY, port 5437); cross-service refs are opaque UUIDs.
export const prisma = new PrismaClient();
