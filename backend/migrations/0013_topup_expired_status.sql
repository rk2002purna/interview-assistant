-- Migration 0013: add 'expired' status to wallet_topups
--
-- Razorpay orders expire after ~30 minutes. If a user abandons checkout or the
-- payment fails without a webhook, the topup row stays 'pending' forever. This
-- adds an 'expired' status so the application can mark stale pending rows and
-- the frontend shows a clear outcome instead of a perpetual "pending."

BEGIN;

-- Widen the status CHECK to include 'expired'.
ALTER TABLE wallet_topups
    DROP CONSTRAINT IF EXISTS wallet_topups_status_check;

ALTER TABLE wallet_topups
    ADD CONSTRAINT wallet_topups_status_check
    CHECK (status IN ('pending', 'completed', 'failed', 'expired'));

-- Widen the consistency CHECK to allow 'expired' rows (no payment_id, no completed_at).
ALTER TABLE wallet_topups
    DROP CONSTRAINT IF EXISTS wallet_topups_status_consistency;

ALTER TABLE wallet_topups
    ADD CONSTRAINT wallet_topups_status_consistency CHECK (
        (status = 'pending'   AND razorpay_payment_id IS NULL     AND completed_at IS NULL)
        OR (status = 'completed' AND razorpay_payment_id IS NOT NULL AND completed_at IS NOT NULL)
        OR (status = 'failed'    AND completed_at IS NULL)
        OR (status = 'expired'   AND razorpay_payment_id IS NULL     AND completed_at IS NULL)
    );

-- Expire any existing stale pending topups older than 30 minutes.
UPDATE wallet_topups
   SET status = 'expired'
 WHERE status = 'pending'
   AND created_at < now() - interval '30 minutes';

COMMIT;
