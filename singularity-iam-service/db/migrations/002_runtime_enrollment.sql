-- One-time browser-to-runtime enrollment handoff.
-- The plaintext SGR code is never stored; only its SHA-256 digest is persisted.
CREATE TABLE IF NOT EXISTS iam.runtime_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash TEXT NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
    tenant_id TEXT,
    runtime_name TEXT NOT NULL,
    runtime_scope TEXT NOT NULL DEFAULT 'user',
    scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
    allowed_frame_types JSONB NOT NULL DEFAULT '[]'::jsonb,
    capability_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    token_ttl_days INTEGER NOT NULL DEFAULT 90,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    used_device_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_enrollments_code_hash
    ON iam.runtime_enrollments(code_hash);
CREATE INDEX IF NOT EXISTS idx_runtime_enrollments_user
    ON iam.runtime_enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_runtime_enrollments_expires
    ON iam.runtime_enrollments(expires_at);
