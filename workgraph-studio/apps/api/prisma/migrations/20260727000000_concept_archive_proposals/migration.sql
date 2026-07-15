-- Concept Archive + Universal Proposal Inbox.
-- This migration intentionally uses text states so the studio can evolve its
-- verbs without a destructive enum migration. Tenant columns are included on
-- every aggregate and event table for strict-RLS deployments.

CREATE TABLE IF NOT EXISTS "studios" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'CONCEPT_ARCHIVE',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "studios_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "studios_projectId_key" UNIQUE ("projectId"),
  CONSTRAINT "studios_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "specification_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "studios_tenantId_status_idx" ON "studios"("tenantId", "status");

CREATE TABLE IF NOT EXISTS "concept_archives" (
  "id" TEXT NOT NULL,
  "studioId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "axes" JSONB NOT NULL,
  "axesRevision" INTEGER NOT NULL DEFAULT 1,
  "fitnessConfig" JSONB NOT NULL DEFAULT '{}',
  "contentHash" TEXT,
  "frozenAt" TIMESTAMP(3),
  "createdById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "concept_archives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "concept_archives_studioId_fkey" FOREIGN KEY ("studioId") REFERENCES "studios"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "concept_archives_tenantId_studioId_status_idx" ON "concept_archives"("tenantId", "studioId", "status");

CREATE TABLE IF NOT EXISTS "concept_cards" (
  "id" TEXT NOT NULL,
  "archiveId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "body" JSONB NOT NULL DEFAULT '{}',
  "authorType" TEXT NOT NULL DEFAULT 'HUMAN',
  "authorId" TEXT,
  "agentRole" TEXT,
  "traceId" TEXT,
  "declaredCoords" JSONB NOT NULL,
  "confirmedCoords" JSONB,
  "coordsAxesRevision" INTEGER,
  "cellKey" TEXT,
  "status" TEXT NOT NULL DEFAULT 'STAGED',
  "fitness" JSONB NOT NULL DEFAULT '{}',
  "compositeScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "pinnedById" TEXT,
  "parentCardIds" JSONB NOT NULL DEFAULT '[]',
  "operator" TEXT NOT NULL DEFAULT 'SEED',
  "operatorNote" TEXT,
  "promotedRef" JSONB,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "concept_cards_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "concept_cards_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "concept_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "concept_cards_archiveId_status_createdAt_idx" ON "concept_cards"("archiveId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "concept_cards_archiveId_cellKey_idx" ON "concept_cards"("archiveId", "cellKey");
CREATE INDEX IF NOT EXISTS "concept_cards_authorId_idx" ON "concept_cards"("authorId");
CREATE INDEX IF NOT EXISTS "concept_cards_tenantId_idx" ON "concept_cards"("tenantId");

CREATE TABLE IF NOT EXISTS "archive_cell_states" (
  "id" TEXT NOT NULL,
  "archiveId" TEXT NOT NULL,
  "cellKey" TEXT NOT NULL,
  "axesRevision" INTEGER NOT NULL,
  "eliteCardId" TEXT,
  "killed" BOOLEAN NOT NULL DEFAULT false,
  "killReason" TEXT,
  "killClaimId" TEXT,
  "killedById" TEXT,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "archive_cell_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "archive_cell_states_archiveId_axesRevision_cellKey_key" UNIQUE ("archiveId", "axesRevision", "cellKey"),
  CONSTRAINT "archive_cell_states_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "concept_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "archive_cell_states_eliteCardId_fkey" FOREIGN KEY ("eliteCardId") REFERENCES "concept_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "archive_cell_states_archiveId_killed_idx" ON "archive_cell_states"("archiveId", "killed");

CREATE TABLE IF NOT EXISTS "archive_events" (
  "id" TEXT NOT NULL,
  "archiveId" TEXT NOT NULL,
  "cardId" TEXT,
  "cellKey" TEXT,
  "eventType" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "archive_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "archive_events_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "concept_archives"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "archive_events_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "concept_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "archive_events_archiveId_createdAt_idx" ON "archive_events"("archiveId", "createdAt");
CREATE INDEX IF NOT EXISTS "archive_events_cardId_createdAt_idx" ON "archive_events"("cardId", "createdAt");

CREATE TABLE IF NOT EXISTS "concept_card_votes" (
  "id" TEXT NOT NULL,
  "cardId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "direction" INTEGER NOT NULL DEFAULT 1,
  "tenantId" TEXT DEFAULT 'default',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "concept_card_votes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "concept_card_votes_cardId_userId_key" UNIQUE ("cardId", "userId"),
  CONSTRAINT "concept_card_votes_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "concept_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "concept_card_votes_tenantId_userId_idx" ON "concept_card_votes"("tenantId", "userId");

CREATE TABLE IF NOT EXISTS "studio_proposals" (
  "id" TEXT NOT NULL,
  "studioId" TEXT NOT NULL,
  "scopeType" TEXT NOT NULL,
  "scopeRef" JSONB NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "baseRevision" INTEGER,
  "authorType" TEXT NOT NULL DEFAULT 'AGENT',
  "authorId" TEXT,
  "agentRole" TEXT,
  "traceId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "decidedById" TEXT,
  "decisionNote" TEXT,
  "editedPayload" JSONB,
  "rebaseOfId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "tenantId" TEXT DEFAULT 'default',
  CONSTRAINT "studio_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "studio_proposals_studioId_fkey" FOREIGN KEY ("studioId") REFERENCES "studios"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "studio_proposals_studioId_status_createdAt_idx" ON "studio_proposals"("studioId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "studio_proposals_studioId_agentRole_status_idx" ON "studio_proposals"("studioId", "agentRole", "status");
CREATE INDEX IF NOT EXISTS "studio_proposals_tenantId_status_idx" ON "studio_proposals"("tenantId", "status");
