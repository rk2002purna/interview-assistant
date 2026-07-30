-- Migration 0014: Google OAuth ("Sign in with Google") support
--
-- Adds a nullable google_sub column to link a user to their Google account
-- (the Google `sub` claim is a stable per-user identifier) and relaxes the
-- password_hash NOT NULL constraint so OAuth-only accounts (which never set a
-- password) can exist. The nonempty CHECK is retained: it only rejects empty
-- strings; NULL satisfies the CHECK, so password users keep their guarantee
-- while OAuth users store NULL.

BEGIN;

-- Allow OAuth-only accounts to have no password.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Stable Google account identifier (the ID token `sub` claim). Nullable so
-- password-only users are unaffected.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text NULL;

-- At most one account per Google identity. Partial index so multiple NULLs
-- (password-only users) are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique
    ON users (google_sub)
    WHERE google_sub IS NOT NULL;

-- Grant column privileges to the app role if it exists (consistent with 0009).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
        EXECUTE 'GRANT UPDATE (google_sub, email_verified_at, display_name) ON users TO app';
    END IF;
END
$$;

COMMIT;
