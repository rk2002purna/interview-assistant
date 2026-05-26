-- Migration 0005: provider_keys, usage, idempotency_cache
--
-- Implements:
--   * provider_keys      (Requirement 4.2 - encrypted at rest with AES-256-GCM)
--   * usage              (Requirements 9.1, 9.5 - usage history with retention)
--   * idempotency_cache  (Requirements 7.6, 7.7 - 24h dedupe of AI requests)
--
-- The application role is named `app`. UPDATE/DELETE on `usage` are revoked
-- so that the retention window is enforced exclusively by application code
-- (scheduled retention sweeper). Provider keys are mutable (rotate/delete by
-- admins through the API), so UPDATE/DELETE on `provider_keys` remain granted
-- to the application role.

BEGIN;

-- ---------------------------------------------------------------------------
-- provider_keys
-- ---------------------------------------------------------------------------
-- One row per upstream AI provider. The ciphertext, nonce, and auth_tag
-- columns store an AES-256-GCM envelope of the plaintext provider API key
-- whose subkey is derived (HKDF-SHA256) from the server-held master secret.
-- `last4` is stored to support the masked Admin_Dashboard listing (R4.3).
-- `version` is a monotonically increasing rotation counter (R4.4).
CREATE TABLE IF NOT EXISTS provider_keys (
    provider    text PRIMARY KEY
                CHECK (provider IN ('gemini', 'groq', 'deepseek', 'cerebras')),
    ciphertext  bytea       NOT NULL,
    nonce       bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    auth_tag    bytea       NOT NULL CHECK (octet_length(auth_tag) = 16),
    last4       text        NOT NULL CHECK (length(last4) = 4),
    version     integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- usage
-- ---------------------------------------------------------------------------
-- One row per AI_Operation (text / vision / audio). Linked to the active
-- Interview_Session at the time of the call. Tokens / image counts are
-- nullable because not every provider returns the full set of fields, and
-- different operation types use different subsets.
CREATE TABLE IF NOT EXISTS usage (
    id                    uuid        PRIMARY KEY,
    user_id               uuid        NOT NULL REFERENCES users (id),
    session_id            uuid        NOT NULL REFERENCES interview_sessions (id),
    ts                    timestamptz NOT NULL DEFAULT now(),
    operation_type        text        NOT NULL
                          CHECK (operation_type IN ('text', 'vision', 'audio')),
    model_id              text        NOT NULL CHECK (length(model_id) BETWEEN 1 AND 100),
    input_tokens          integer     NULL CHECK (input_tokens IS NULL OR input_tokens >= 0),
    input_image_count     integer     NULL CHECK (input_image_count IS NULL OR input_image_count >= 0),
    output_tokens         integer     NULL CHECK (output_tokens IS NULL OR output_tokens >= 0),
    status                text        NOT NULL CHECK (status IN ('success', 'failed')),
    upstream_http_status  integer     NULL CHECK (upstream_http_status IS NULL
                                                   OR (upstream_http_status BETWEEN 100 AND 599)),
    idempotency_key       uuid        NULL
);

-- Index for per-user reverse-chronological history (Requirement 9.2).
CREATE INDEX IF NOT EXISTS usage_user_id_ts_desc_idx
    ON usage (user_id, ts DESC);

-- Index for admin aggregation across the time dimension (Requirement 9.6).
CREATE INDEX IF NOT EXISTS usage_ts_idx
    ON usage (ts);

-- ---------------------------------------------------------------------------
-- idempotency_cache
-- ---------------------------------------------------------------------------
-- Stores the canonical request hash and original response body for any
-- AI request that arrived with an Idempotency-Key. Composite primary key
-- on (user_id, idempotency_key) per the design (Requirement 7.6).
-- TTL is enforced by the application via `expires_at`; an hourly cleanup
-- job deletes rows where `expires_at < now()`.
CREATE TABLE IF NOT EXISTS idempotency_cache (
    user_id          uuid        NOT NULL REFERENCES users (id),
    idempotency_key  uuid        NOT NULL,
    request_hash     bytea       NOT NULL CHECK (octet_length(request_hash) = 32),
    response_body    jsonb       NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    PRIMARY KEY (user_id, idempotency_key),
    CHECK (expires_at > created_at)
);

-- Index supporting the hourly TTL cleanup pass.
CREATE INDEX IF NOT EXISTS idempotency_cache_expires_at_idx
    ON idempotency_cache (expires_at);

-- ---------------------------------------------------------------------------
-- Privilege restrictions on `usage`
-- ---------------------------------------------------------------------------
-- The application role only ever needs to INSERT and SELECT from `usage`.
-- Retention is enforced by a scheduled sweeper that runs as a privileged
-- maintenance role; revoking UPDATE/DELETE here ensures no application
-- code path can mutate or remove usage rows during the retention window.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
        EXECUTE 'REVOKE UPDATE, DELETE ON usage FROM app';
        EXECUTE 'GRANT SELECT, INSERT ON usage TO app';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON provider_keys TO app';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_cache TO app';
    END IF;
END
$$;

COMMIT;
