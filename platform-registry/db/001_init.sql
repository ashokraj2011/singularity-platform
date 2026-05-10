-- M11.a — platform-registry schema
--
-- service_registrations  : every running service POSTs /register on startup,
--                          re-registers periodically. Last-write-wins on (service_name).
-- service_capabilities   : flat list of typed capabilities a service advertises
--                          (e.g. "lookup.capabilities", "tools.execute").
-- service_contracts      : pointers to OpenAPI specs / event schemas / workflow
--                          node contracts that a service publishes. The blob
--                          itself stays at the source URL — registry stores
--                          (kind, version, source_url, sha256, fetched_at).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS service_registrations (
  service_name    TEXT PRIMARY KEY,                    -- e.g. "workgraph-api"
  display_name    TEXT NOT NULL,
  version         TEXT NOT NULL,
  base_url        TEXT NOT NULL,                       -- public URL
  internal_url    TEXT,                                -- intra-cluster URL (optional)
  health_path     TEXT NOT NULL DEFAULT '/health',
  auth_mode       TEXT NOT NULL,                       -- 'none' | 'bearer-iam' | 'bearer-static' | 'mtls'
  owner_team      TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status     TEXT NOT NULL DEFAULT 'registered'   -- 'registered' | 'healthy' | 'unhealthy' | 'stale'
);

CREATE TABLE IF NOT EXISTS service_capabilities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name    TEXT NOT NULL REFERENCES service_registrations(service_name) ON DELETE CASCADE,
  capability_key  TEXT NOT NULL,                       -- e.g. "lookup.capabilities"
  description     TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_name, capability_key)
);

CREATE INDEX IF NOT EXISTS idx_service_capabilities_key
  ON service_capabilities(capability_key);

CREATE TABLE IF NOT EXISTS service_contracts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name    TEXT NOT NULL REFERENCES service_registrations(service_name) ON DELETE CASCADE,
  kind            TEXT NOT NULL,                       -- 'openapi' | 'tool-schema' | 'event-contract' | 'workflow-node-contract'
  contract_key    TEXT NOT NULL,                       -- e.g. "openapi", "event:agent.run.completed"
  version         TEXT NOT NULL,                       -- semver-ish
  source_url      TEXT NOT NULL,                       -- where the spec lives (registry stores pointer, not blob)
  sha256          TEXT,                                -- optional, computed at register time
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_name, kind, contract_key, version)
);

CREATE INDEX IF NOT EXISTS idx_service_contracts_kind
  ON service_contracts(kind, contract_key);
