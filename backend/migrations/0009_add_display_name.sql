-- Migration 0009: add display_name to users
--
-- Adds an optional display_name column so users can set a human-readable
-- name during registration. Shown in the UI (header, admin pages) instead
-- of the raw UUID.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text NULL;

-- Grant to app role if it exists (consistent with other migrations).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
        EXECUTE 'GRANT UPDATE (display_name) ON users TO app';
    END IF;
END
$$;

COMMIT;
