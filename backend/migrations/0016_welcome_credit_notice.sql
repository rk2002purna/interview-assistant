-- Migration 0016: one-time welcome-credit notification
--
-- Tracks delivery of the Rs 50 signup-credit notice. Existing users receive a
-- metadata-only timestamp default during the ALTER and are therefore treated
-- as already notified. The default is immediately removed, so accounts created
-- after this migration remain eligible until a reservation is acknowledged.
-- A short reservation lease makes claims replayable after a dropped response
-- while still allowing only one tab or device to display the notice at a time.
--
-- Depends on: 0001 (users), 0012 (wallet_ledger).

BEGIN;

-- On supported PostgreSQL versions, the stable now() default is recorded as a
-- missing value instead of rewriting every user row under the schema lock.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS welcome_credit_notice_claimed_at timestamptz DEFAULT now();

ALTER TABLE users
  ALTER COLUMN welcome_credit_notice_claimed_at DROP DEFAULT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS welcome_credit_notice_reservation_token uuid,
  ADD COLUMN IF NOT EXISTS welcome_credit_notice_reserved_at timestamptz;

COMMENT ON COLUMN users.welcome_credit_notice_claimed_at IS
  'Set after the signup-credit banner is rendered and acknowledged by the client; existing users were backfilled by migration 0016.';
COMMENT ON COLUMN users.welcome_credit_notice_reservation_token IS
  'Client nonce used to reserve and idempotently acknowledge delivery of the welcome-credit notice.';
COMMENT ON COLUMN users.welcome_credit_notice_reserved_at IS
  'Start time of the current welcome-credit notice reservation lease.';

COMMIT;
