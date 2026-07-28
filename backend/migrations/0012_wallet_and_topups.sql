-- Migration 0012: wallet-based, per-minute billing model
--
-- Replaces the session-credit / pack model with a prepaid wallet:
--   * wallet_ledger  — append-only balance ledger in INR paise
--   * wallet_topups  — Razorpay-backed wallet recharge orders
--   * interview_sessions.charged_paise — running amount billed to a session
--   * interview_sessions.ended_reason gains 'insufficient_funds'
--
-- Interview time is billed at a flat per-minute rate (each started minute is
-- charged in full — see the application layer). New users receive a one-time
-- signup bonus credited to the wallet. Fixed packs, lifetime access, and the
-- welcome offer are retired (rows deactivated, tables left intact for history).
--
-- All monetary amounts are INR paise (bigint). All timestamps are timestamptz.
--
-- Depends on: 0001 (users), 0004 (interview_sessions).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- wallet_ledger (append-only)
-- -----------------------------------------------------------------------------
-- Every change to a user's wallet balance is one row. The canonical balance is
-- the latest row's resulting_balance_paise (a periodic audit can verify it
-- equals SUM(amount_paise)). Concurrent writes for one user are serialized with
-- pg_advisory_xact_lock(user_id) in the application writer.
CREATE TABLE wallet_ledger (
    id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  uuid        NOT NULL REFERENCES users(id),
    ts                       timestamptz NOT NULL DEFAULT clock_timestamp(),

    -- Signed delta in paise. Positive = credit, negative = debit. Never zero.
    amount_paise             bigint      NOT NULL,
    CONSTRAINT wallet_ledger_amount_range
        CHECK (amount_paise BETWEEN -100000000 AND 100000000),
    CONSTRAINT wallet_ledger_amount_nonzero
        CHECK (amount_paise <> 0),

    reason                   text        NOT NULL,
    CONSTRAINT wallet_ledger_reason_enum
        CHECK (reason IN (
            'signup_bonus',
            'topup',
            'session_charge',
            'admin_credit',
            'admin_debit',
            'refund'
        )),

    razorpay_payment_id      text        NULL,
    interview_session_id     uuid        NULL REFERENCES interview_sessions(id),
    acting_admin_id          uuid        NULL REFERENCES users(id),

    -- Denormalized running balance after applying this row, computed inside the
    -- inserting transaction. Must never go negative.
    resulting_balance_paise  bigint      NOT NULL,
    CONSTRAINT wallet_ledger_resulting_balance_nonneg
        CHECK (resulting_balance_paise >= 0),

    note                     text        NULL,
    CONSTRAINT wallet_ledger_note_length
        CHECK (note IS NULL OR length(note) <= 500)
);

CREATE INDEX wallet_ledger_user_ts_idx
    ON wallet_ledger (user_id, ts DESC, id DESC);

CREATE INDEX wallet_ledger_session_idx
    ON wallet_ledger (interview_session_id)
    WHERE interview_session_id IS NOT NULL;

CREATE INDEX wallet_ledger_razorpay_payment_idx
    ON wallet_ledger (razorpay_payment_id)
    WHERE razorpay_payment_id IS NOT NULL;

-- Append-only enforcement (mirrors entitlement_ledger in 0004).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
        EXECUTE 'REVOKE UPDATE, DELETE ON wallet_ledger FROM app';
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION wallet_ledger_reject_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'wallet_ledger is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER wallet_ledger_no_update
    BEFORE UPDATE ON wallet_ledger
    FOR EACH ROW EXECUTE FUNCTION wallet_ledger_reject_mutation();

CREATE TRIGGER wallet_ledger_no_delete
    BEFORE DELETE ON wallet_ledger
    FOR EACH ROW EXECUTE FUNCTION wallet_ledger_reject_mutation();

-- -----------------------------------------------------------------------------
-- wallet_topups (Razorpay-backed wallet recharge orders)
-- -----------------------------------------------------------------------------
CREATE TABLE wallet_topups (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount_paise         bigint      NOT NULL
                                     CHECK (amount_paise > 0 AND amount_paise <= 100000000),
    status               text        NOT NULL
                                     CHECK (status IN ('pending', 'completed', 'failed')),
    razorpay_order_id    text        NOT NULL
                                     CHECK (length(razorpay_order_id) BETWEEN 1 AND 255),
    razorpay_payment_id  text        NULL
                                     CHECK (razorpay_payment_id IS NULL
                                            OR length(razorpay_payment_id) BETWEEN 1 AND 255),
    created_at           timestamptz NOT NULL DEFAULT now(),
    completed_at         timestamptz NULL,

    CONSTRAINT wallet_topups_status_consistency CHECK (
        (status = 'pending'   AND razorpay_payment_id IS NULL     AND completed_at IS NULL)
        OR (status = 'completed' AND razorpay_payment_id IS NOT NULL AND completed_at IS NOT NULL)
        OR (status = 'failed'    AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX wallet_topups_razorpay_order_id_key
    ON wallet_topups (razorpay_order_id);

CREATE UNIQUE INDEX wallet_topups_razorpay_payment_id_key
    ON wallet_topups (razorpay_payment_id)
    WHERE razorpay_payment_id IS NOT NULL;

CREATE INDEX wallet_topups_user_created_idx
    ON wallet_topups (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- interview_sessions: per-minute billing support
-- -----------------------------------------------------------------------------
-- Running total already billed to this session, in paise. Updated as the
-- session accrues billable minutes (session start + heartbeats + end).
ALTER TABLE interview_sessions
    ADD COLUMN IF NOT EXISTS charged_paise bigint NOT NULL DEFAULT 0;

-- Allow a session to be ended when the wallet can no longer cover the next
-- minute. The original inline column CHECK is named
-- interview_sessions_ended_reason_check by Postgres.
ALTER TABLE interview_sessions
    DROP CONSTRAINT IF EXISTS interview_sessions_ended_reason_check;
ALTER TABLE interview_sessions
    ADD CONSTRAINT interview_sessions_ended_reason_check
    CHECK (
        ended_reason IS NULL
        OR ended_reason IN ('ended_by_user', 'expired', 'signed_out', 'insufficient_funds')
    );

-- -----------------------------------------------------------------------------
-- Retire the pack / lifetime / welcome-offer sales model.
-- Tables are kept for historical purchases; rows are deactivated so nothing is
-- offered for sale under the wallet model.
-- -----------------------------------------------------------------------------
UPDATE packs SET active = false WHERE active = true;
UPDATE welcome_offer SET enabled = false WHERE id = 1 AND enabled = true;

COMMIT;
