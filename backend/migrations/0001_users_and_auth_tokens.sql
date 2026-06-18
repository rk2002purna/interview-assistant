-- Migration 0001: users, refresh_tokens, email_verifications, password_resets
--
-- Validates: Requirements 1.3, 1.8, 2.1, 2.4
--
-- Tables:
--   users                 - account record with single-role RBAC and lockout state
--   refresh_tokens        - hashed refresh tokens bound to a client_id
--   email_verifications   - one-shot tokens for email verification
--   password_resets       - one-shot tokens for password reset
--
-- The bootstrap-admin behavior in Requirement 2.4 is implemented as an
-- AFTER INSERT trigger on `users`. The trigger writes an `audit_log` row
-- with reason code `bootstrap_admin` and forces the inserted row's role
-- to `admin` when the deployment has zero admins.
--
-- Migration ordering note:
--
--   The trigger function references the `audit_log` table, which is
--   created by migration 0006. PostgreSQL parses PL/pgSQL function
--   bodies lazily (table references are resolved at execution time, not
--   at function creation time), so creating the trigger here is safe
--   even though `audit_log` does not yet exist when this migration
--   runs.
--
--   To keep this migration usable in test scenarios that run 0001 in
--   isolation, the trigger body itself guards the audit insert with a
--   `to_regclass('public.audit_log') IS NOT NULL` check. In production
--   all migrations 0001..0006 run in numeric order before any user is
--   inserted, so the audit row is always written.
--
--   Application role: `app` (matches the convention in 0006).

BEGIN;

-- The `gen_random_uuid()` function lives in pgcrypto on older Postgres
-- versions; on 13+ it is available unconditionally. Loading the
-- extension keeps this migration portable across managed providers
-- that ship without it pre-installed.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- citext gives us case-insensitive email uniqueness without forcing
-- callers to lowercase before every query.
CREATE EXTENSION IF NOT EXISTS citext;


-- ---------------------------------------------------------------------------
-- users (Requirements 1.3, 1.8, 2.1)
--
-- Column constraints:
--   * email          citext, RFC 5322-shaped (defense-in-depth regex), <=254 chars
--   * password_hash  NOT NULL (R1.8: never store plaintext, never NULL)
--   * role           exactly one of {'user','admin'} (R2.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email               citext      NOT NULL
        CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 3 AND 254)
        CONSTRAINT users_email_format CHECK (
            -- Pragmatic RFC 5322 shape: local@domain.tld with no whitespace
            -- and exactly one '@'. Strict RFC 5322 validation lives in the
            -- application layer; this is a defense-in-depth boundary check.
            email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
        ),
    password_hash       text        NOT NULL
        CONSTRAINT users_password_hash_nonempty CHECK (char_length(password_hash) > 0),
    role                text        NOT NULL DEFAULT 'user'
        CONSTRAINT users_role_allowed CHECK (role IN ('user', 'admin')),
    email_verified_at   timestamptz NULL,
    locked_until        timestamptz NULL,
    failed_login_count  integer     NOT NULL DEFAULT 0
        CONSTRAINT users_failed_login_count_nonneg CHECK (failed_login_count >= 0),
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive unique email. citext columns compare case-insensitively
-- by default, so a plain UNIQUE index does the right thing.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
    ON users (email);

-- Supporting index for lockout sweeps and admin filtering by status.
CREATE INDEX IF NOT EXISTS users_locked_until_idx
    ON users (locked_until)
    WHERE locked_until IS NOT NULL;


-- ---------------------------------------------------------------------------
-- refresh_tokens (Requirement 1.2, 1.6, 1.7, 13.5)
--
-- Refresh tokens are stored hashed (SHA-256 hex) and bound to the
-- `client_id` they were issued to. The application revokes tokens by
-- setting `revoked_at`; rows are retained for audit and replay
-- detection.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text        NOT NULL
        CONSTRAINT refresh_tokens_token_hash_nonempty CHECK (char_length(token_hash) > 0),
    client_id   uuid        NOT NULL,
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Hash uniqueness: a given token hash should appear at most once
-- across all users. This protects against accidental hash reuse and
-- supports fast lookup-by-hash on /auth/refresh.
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_unique
    ON refresh_tokens (token_hash);

-- Active-token lookup by user (used to revoke all tokens on logout-all
-- or password reset).
CREATE INDEX IF NOT EXISTS refresh_tokens_user_active_idx
    ON refresh_tokens (user_id)
    WHERE revoked_at IS NULL;


-- ---------------------------------------------------------------------------
-- email_verifications (Requirement 1.3)
--
-- 24-hour TTL one-shot tokens. `used_at` is set on first successful
-- verification; subsequent uses are rejected by the application.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verifications (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text        NOT NULL
        CONSTRAINT email_verifications_token_hash_nonempty CHECK (char_length(token_hash) > 0),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_verifications_token_hash_unique
    ON email_verifications (token_hash);

CREATE INDEX IF NOT EXISTS email_verifications_user_idx
    ON email_verifications (user_id);


-- ---------------------------------------------------------------------------
-- password_resets (Requirement 1.3)
--
-- 60-minute TTL one-shot tokens, same shape as email_verifications.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  text        NOT NULL
        CONSTRAINT password_resets_token_hash_nonempty CHECK (char_length(token_hash) > 0),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS password_resets_token_hash_unique
    ON password_resets (token_hash);

CREATE INDEX IF NOT EXISTS password_resets_user_idx
    ON password_resets (user_id);


-- ---------------------------------------------------------------------------
-- Bootstrap-admin trigger (Requirement 2.4)
--
-- After a user is inserted, if the deployment had zero admins prior to
-- this insert, promote the new user to `admin` and append an audit_log
-- entry with reason code `bootstrap_admin`. The check excludes the
-- newly inserted row by filtering on `id <> NEW.id`, so even a manual
-- admin creation on a fresh deployment is recorded as a bootstrap event
-- (which is the desired behavior per R2.4: "WHEN a user account is
-- created on a deployment that currently has zero users with role
-- admin").
--
-- Idempotency: the UPDATE is a no-op when the inserted user already
-- has role='admin'; the audit row is still written so the bootstrap
-- event is recorded exactly once per deployment lifecycle.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION users_bootstrap_admin() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    other_admin_count integer;
BEGIN
    SELECT count(*) INTO other_admin_count
        FROM users
        WHERE role = 'admin' AND id <> NEW.id;

    IF other_admin_count = 0 THEN
        -- Promote the newly inserted user. UPDATE on the same row from
        -- an AFTER INSERT trigger is permitted and does not re-fire
        -- this INSERT trigger.
        IF NEW.role <> 'admin' THEN
            UPDATE users SET role = 'admin' WHERE id = NEW.id;
        END IF;

        -- Append the audit_log row only if the table exists. In
        -- production all migrations 0001..0006 run before any insert,
        -- so this branch is always taken; in test scenarios that run
        -- only this migration the guard prevents a failure.
        IF to_regclass('public.audit_log') IS NOT NULL THEN
            INSERT INTO audit_log (
                id, ts, actor_user_id, target_user_id,
                target_resource, event_type, outcome, reason_code, metadata
            ) VALUES (
                gen_random_uuid(),
                now(),
                NULL,
                NEW.id,
                'user:' || NEW.id::text,
                'role_assigned',
                'success',
                'bootstrap_admin',
                jsonb_build_object(
                    'assigned_role', 'admin',
                    'previous_role', NEW.role
                )
            );
        END IF;
    END IF;

    RETURN NULL;  -- AFTER trigger return value is ignored
END;
$$;

DROP TRIGGER IF EXISTS users_bootstrap_admin_trg ON users;
CREATE TRIGGER users_bootstrap_admin_trg
    AFTER INSERT ON users
    FOR EACH ROW
    EXECUTE FUNCTION users_bootstrap_admin();


-- ---------------------------------------------------------------------------
-- Application-role grants
--
-- Mirrors the convention used in 0006: only apply grants if the `app`
-- role exists. Refresh tokens, email verifications, and password resets
-- are read/write/delete-able (revocation, cleanup of expired tokens).
-- The `users` table allows UPDATE for verification timestamp, lockout
-- state, password reset, and admin role changes.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE ON users TO app';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO app';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON email_verifications TO app';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON password_resets TO app';
    END IF;
END
$$;

COMMIT;
