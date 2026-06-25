-- Migration 0004: entitlement_ledger and interview_sessions
--
-- Implements the append-only Entitlement_Ledger and the Interview_Session
-- lifecycle table.
--
-- Requirements:
--   6.1 - append-only ledger schema with required columns and CHECK constraints
--   6.6 - reject UPDATE / DELETE on entitlement_ledger entries
--   8.3 - at most one active interview session per user
--
-- Design references: design.md "Data Models" sections for `entitlement_ledger`
-- and `interview_sessions`, including the session_delta CHECK that allows a
-- zero delta only for `session_start` (lifetime users, per Requirement 6.7),
-- and the partial unique index `one_active_session_per_user`.
--
-- Depends on: 0001_users.sql (users table, app role).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- interview_sessions
-- -----------------------------------------------------------------------------
-- Created before entitlement_ledger because entitlement_ledger.interview_session_id
-- references it.
CREATE TABLE IF NOT EXISTS interview_sessions (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES users(id),
    status        text        NOT NULL CHECK (status IN ('active','ended','expired')),
    started_at    timestamptz NOT NULL,
    expires_at    timestamptz NOT NULL,
    ended_at      timestamptz NULL,
    ended_reason  text        NULL CHECK (
        ended_reason IS NULL
        OR ended_reason IN ('ended_by_user','expired','signed_out')
    ),
    CONSTRAINT interview_sessions_expires_after_start
        CHECK (expires_at > started_at),
    CONSTRAINT interview_sessions_ended_consistency
        CHECK (
            (status = 'active' AND ended_at IS NULL AND ended_reason IS NULL)
            OR (status IN ('ended','expired') AND ended_at IS NOT NULL)
        )
);

-- Requirement 8.3: a user may hold at most one active interview session at a time.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_user
    ON interview_sessions (user_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS interview_sessions_user_started_idx
    ON interview_sessions (user_id, started_at DESC);

-- Sweep job (runSessionExpirySweep) scans for expired but still-active rows.
CREATE INDEX IF NOT EXISTS interview_sessions_active_expires_idx
    ON interview_sessions (expires_at)
    WHERE status = 'active';

-- -----------------------------------------------------------------------------
-- entitlement_ledger (append-only)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entitlement_ledger (
    id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  uuid        NOT NULL REFERENCES users(id),
    ts                       timestamptz NOT NULL DEFAULT clock_timestamp(),

    -- Requirement 6.1: integer in [-1,000,000, 1,000,000].
    -- Design CHECK: non-zero, except a zero delta is permitted exclusively for
    -- `session_start` to record a lifetime-user session start (Requirement 6.7).
    session_delta            integer     NOT NULL,
    CONSTRAINT entitlement_ledger_session_delta_range
        CHECK (session_delta BETWEEN -1000000 AND 1000000),
    CONSTRAINT entitlement_ledger_session_delta_nonzero_or_lifetime_start
        CHECK (
            session_delta <> 0
            OR (session_delta = 0 AND reason = 'session_start')
        ),

    lifetime_flag_set        text        NOT NULL,
    CONSTRAINT entitlement_ledger_lifetime_flag_set_enum
        CHECK (lifetime_flag_set IN ('unchanged','set_true')),

    reason                   text        NOT NULL,
    CONSTRAINT entitlement_ledger_reason_enum
        CHECK (reason IN (
            'pack_purchase',
            'lifetime_grant',
            'session_start',
            'session_refund',
            'admin_adjustment'
        )),

    razorpay_payment_id      text        NULL,
    interview_session_id     uuid        NULL REFERENCES interview_sessions(id),
    acting_admin_id          uuid        NULL REFERENCES users(id),

    -- Denormalized result of applying this row, computed inside the inserting
    -- transaction (canonical source remains the SUM/lifetime derivation in 6.2;
    -- a periodic invariant audit verifies they agree).
    resulting_session_count  integer     NOT NULL,
    CONSTRAINT entitlement_ledger_resulting_session_count_nonneg
        CHECK (resulting_session_count >= 0),

    resulting_lifetime_flag  boolean     NOT NULL,

    note                     text        NULL,
    CONSTRAINT entitlement_ledger_note_length
        CHECK (note IS NULL OR length(note) <= 500)
);

CREATE INDEX IF NOT EXISTS entitlement_ledger_user_ts_idx
    ON entitlement_ledger (user_id, ts DESC);

CREATE INDEX IF NOT EXISTS entitlement_ledger_razorpay_payment_idx
    ON entitlement_ledger (razorpay_payment_id)
    WHERE razorpay_payment_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Append-only enforcement (Requirement 6.6).
-- -----------------------------------------------------------------------------
-- Defense-in-depth: revoke UPDATE and DELETE from the application role.
-- This preserves the ability of migration / superuser roles to manage the
-- table, while preventing any application code path from mutating committed
-- ledger rows.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
        EXECUTE 'REVOKE UPDATE, DELETE ON entitlement_ledger FROM app';
    END IF;
END
$$;

-- A trigger guards against direct UPDATE / DELETE under any role that still
-- holds those privileges (e.g. a future role that forgets the REVOKE).
CREATE OR REPLACE FUNCTION entitlement_ledger_reject_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'entitlement_ledger is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'check_violation';
END;
$$;

-- PostgreSQL has no CREATE TRIGGER IF NOT EXISTS, so DROP first for
-- idempotency against a schema that was bootstrapped out-of-band.
DROP TRIGGER IF EXISTS entitlement_ledger_no_update ON entitlement_ledger;
CREATE TRIGGER entitlement_ledger_no_update
    BEFORE UPDATE ON entitlement_ledger
    FOR EACH ROW EXECUTE FUNCTION entitlement_ledger_reject_mutation();

DROP TRIGGER IF EXISTS entitlement_ledger_no_delete ON entitlement_ledger;
CREATE TRIGGER entitlement_ledger_no_delete
    BEFORE DELETE ON entitlement_ledger
    FOR EACH ROW EXECUTE FUNCTION entitlement_ledger_reject_mutation();

COMMIT;
