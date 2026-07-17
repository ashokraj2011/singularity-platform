CREATE UNIQUE INDEX IF NOT EXISTS "work_item_events_single_sla_breach"
  ON "work_item_events" ("workItemId")
  WHERE "eventType" = 'SLA_BREACHED';
