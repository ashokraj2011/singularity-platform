-- Decay-loop delivery subscription (operator step; run once against the claim-registry DB).
--
-- Registers workgraph-api as a subscriber to the two lifecycle events that must
-- re-flag dependent workflow templates. The dispatcher (src/lib/dispatcher.ts) reads
-- this row, signs each delivery with `secret`, and POSTs to `targetUrl`. The SAME secret
-- must appear in workgraph-api's WORKGRAPH_INCOMING_EVENT_SECRETS under key "claim-registry"
-- (see src/modules/claims/README.md on the workgraph side).
--
--   * Replace <shared-secret> with a strong random value shared with workgraph-api.
--   * Replace the targetUrl host if workgraph-api is not reachable as `workgraph-api:8080`.
--   * `eventTypes` may use globs (e.g. 'claim.*'); exact names are used here on purpose.

INSERT INTO event_subscriptions (id, name, "eventTypes", "targetUrl", secret, active)
VALUES (
  gen_random_uuid(),
  'workgraph-claim-review',
  ARRAY['claim.decay.threshold_crossed', 'claim.falsified'],
  'http://workgraph-api:8080/api/events/incoming',
  '<shared-secret>',
  true
)
ON CONFLICT (name) DO UPDATE
  SET "eventTypes" = EXCLUDED."eventTypes",
      "targetUrl"  = EXCLUDED."targetUrl",
      secret       = EXCLUDED.secret,
      active       = EXCLUDED.active;
