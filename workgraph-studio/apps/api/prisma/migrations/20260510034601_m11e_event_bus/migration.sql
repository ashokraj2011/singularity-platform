-- M11.e — event bus: publisher outbox + subscriber registry + per-delivery state.
-- Postgres LISTEN/NOTIFY drives the dispatcher; rows are the durable record.

CREATE TABLE "event_outbox" (
  "id"            TEXT         PRIMARY KEY,
  "eventName"     TEXT         NOT NULL,
  "sourceService" TEXT         NOT NULL,
  "traceId"       TEXT,
  "subjectKind"   TEXT         NOT NULL,
  "subjectId"     TEXT         NOT NULL,
  "envelope"      JSONB        NOT NULL,
  "status"        TEXT         NOT NULL DEFAULT 'pending',
  "attempts"      INTEGER      NOT NULL DEFAULT 0,
  "emittedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "lastError"     TEXT
);
CREATE INDEX "event_outbox_status_emittedAt_idx" ON "event_outbox"("status", "emittedAt");
CREATE INDEX "event_outbox_eventName_idx"        ON "event_outbox"("eventName");
CREATE INDEX "event_outbox_traceId_idx"          ON "event_outbox"("traceId");

CREATE TABLE "event_subscriptions" (
  "id"            TEXT         PRIMARY KEY,
  "subscriberId"  TEXT         NOT NULL,
  "eventPattern"  TEXT         NOT NULL,
  "targetUrl"     TEXT         NOT NULL,
  "secret"        TEXT,
  "isActive"      BOOLEAN      NOT NULL DEFAULT true,
  "metadata"      JSONB,
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL
);
CREATE INDEX "event_subscriptions_isActive_eventPattern_idx"
  ON "event_subscriptions"("isActive", "eventPattern");

CREATE TABLE "event_deliveries" (
  "id"              TEXT         PRIMARY KEY,
  "outboxId"        TEXT         NOT NULL REFERENCES "event_outbox"("id")        ON DELETE CASCADE,
  "subscriptionId"  TEXT         NOT NULL REFERENCES "event_subscriptions"("id") ON DELETE CASCADE,
  "status"          TEXT         NOT NULL DEFAULT 'queued',
  "attempts"        INTEGER      NOT NULL DEFAULT 0,
  "lastAttemptAt"   TIMESTAMP(3),
  "lastError"       TEXT,
  "deliveredAt"     TIMESTAMP(3),
  "responseStatus"  INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "event_deliveries_outboxId_subscriptionId_key"
  ON "event_deliveries"("outboxId", "subscriptionId");
CREATE INDEX "event_deliveries_status_createdAt_idx"
  ON "event_deliveries"("status", "createdAt");
