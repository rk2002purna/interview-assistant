-- Migration 0006: rate_events, rate_limit_overrides, audit_log
--
-- Validates: Requirements 12.1, 12.4, 14.4, 14.5
--
-- Notes on ordering:
--   The bootstrap-admin trigger introduced by migration 0001 (users table)
--   writes an audit_log row with reason `bootstrap_admin`. That trigger
--   therefore depends on the audit_log table defined here. In production
--   migrations are executed in numeric order, so the canonical fix is for
--   0001 to either (a) use CREATE OR REPLACE for the trigger function and
--   defer the trigger CREATE to a later migration, or (b) be reordered to
--   run after 0006. The numeric prefix used here matches the wave plan in
--   tasks.md (wave 1 covers 2.1..2.6 in parallel); coordinating the actual
--   trigger placement is task 2.1's responsibility. This file only owns
--   creating the three tables with the required constraints, indexes, and
--   permission revocations.
--
-- Application role: `app`.

BEGIN;

-- ---------------------------------------------------------------------------
-- audit_log (Requirements 14.4, 14.5)
--
-- Append-only. Updates and deletes are revoked from the application role
-- (R14.5). Retention >= 24 months is enforced operationally.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id              uuid PRIMARY KEY,
    ts              timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor_user_id   uuid NULL,
    target_user_id  uuid NULL,
    target_resource text NULL,
    event_type      text NOT NULL,
    outcome         text NOT NULL CHECK (outcome IN ('success', 'failure')),
    reason_code     text NULL,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Index for time-ordered admin reads (GET /admin/audit-log, R14.4).
CREATE INDEX IF NOT EXISTS audit_log_ts_idx
    ON audit_log (ts DESC);

-- Optional supporting indexes for common filters.
CREATE INDEX IF NOT EXISTS audit_log_actor_ts_idx
    ON audit_log (actor_user_id, ts DESC)
    WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_target_user_ts_idx
    ON audit_log (target_user_id, ts DESC)
    WHERE target_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_event_type_ts_idx
    ON audit_log (event_type, ts DESC);

-- ---------------------------------------------------------------------------
-- rate_events (Requirement 12.1)
--
-- Rolling-window rate limiting. Pruned weekly to last 30 days by a separate
-- maintenance task; that pruning is an authorized administrative DELETE and
-- is not subject to the application-role REVOKE (which only protects the
-- append-only audit_log).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_events (
    user_id uuid        NOT NULL,
    ts      timestamptz NOT NULL,
    kind    text        NOT NULL CHECK (kind IN (
                'ai_op',
                'session_start',
                'login_attempt',
                'login_success'
            )),
    ip      inet        NULL,
    PRIMARY KEY (user_id, ts, kind)
);

-- Rolling-window count index: reads filter by (user_id, kind) and scan
-- backward by ts to find events newer than `now() - interval`.
CREATE INDEX IF NOT EXISTS rate_events_user_kind_ts_idx
    ON rate_events (user_id, kind, ts DESC);

-- ---------------------------------------------------------------------------
-- rate_limit_overrides (Requirement 12.4)
--
-- Per-user override values; NULL means "use default". Mutations are written
-- through the admin API which also appends an audit_log entry recording the
-- previous and new values in the same transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_overrides (
    user_id          uuid PRIMARY KEY,
    ai_per_min       int NULL CHECK (ai_per_min IS NULL OR ai_per_min BETWEEN 0 AND 100000),
    ai_per_day       int NULL CHECK (ai_per_day IS NULL OR ai_per_day BETWEEN 0 AND 100000),
    session_per_hour int NULL CHECK (session_per_hour IS NULL OR session_per_hour BETWEEN 0 AND 100000),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Append-only enforcement for audit_log (Requirement 14.5)
--
-- Application role `app` can INSERT and SELECT, but UPDATE and DELETE are
-- revoked. This complements the trigger / RLS layer applied in later
-- migrations and ensures any API request attempting to modify or delete an
-- audit_log row fails at the database boundary.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
        EXECUTE 'GRANT SELECT, INSERT ON audit_log TO app';
        EXECUTE 'REVOKE UPDATE, DELETE ON audit_log FROM app';

        EXECUTE 'GRANT SELECT, INSERT, DELETE ON rate_events TO app';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_overrides TO app';
    END IF;
END
$$;

COMMIT;
