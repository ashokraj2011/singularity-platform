-- P1-7 inbound-event idempotency.
-- One claim row per (triggerId, dedupeValue) makes event -> WorkItem creation
-- race-safe: concurrent/retried deliveries resolving to the same dedupe value
-- collide on the unique index, so only ONE WorkItem is created for the event.
-- Windowed via claimedAt (the app treats rows older than its window as expired,
-- so a genuine later recurrence is not permanently suppressed).

CREATE TABLE "work_item_event_dedup" (
    "id" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "dedupeValue" TEXT NOT NULL,
    "workItemId" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_event_dedup_pkey" PRIMARY KEY ("id")
);

-- The load-bearing race guard: a second concurrent/retried delivery for the same
-- (trigger, dedupeValue) fails this unique constraint instead of creating a dup.
CREATE UNIQUE INDEX "work_item_event_dedup_triggerId_dedupeValue_key" ON "work_item_event_dedup"("triggerId", "dedupeValue");

-- For the expiry sweep of stale claim rows.
CREATE INDEX "work_item_event_dedup_claimedAt_idx" ON "work_item_event_dedup"("claimedAt");
