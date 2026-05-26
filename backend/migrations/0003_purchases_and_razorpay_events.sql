-- Migration: 0003_purchases_and_razorpay_events
-- Creates the `purchases` table that records each Razorpay-backed pack purchase
-- and the `razorpay_events` table used to dedupe webhook deliveries and to
-- stage unmatched events for later reconciliation.
--
-- Requirements covered:
--   10.1  Persist a Purchase record (status 'pending') linking the End_User,
--         the Pack slug, the effective price, and the Razorpay order id.
--   10.9  Dedupe webhook deliveries by Razorpay event id (PK on event_id).
--   10.10 Record signature-verified webhooks whose order id is unknown as
--         "unmatched" for later reconciliation.
--
-- Depends on:
--   0001_users.sql  (users.id)
--   0002_packs.sql  (packs.slug)

BEGIN;

-- pgcrypto provides gen_random_uuid(); idempotent on re-runs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- purchases
-- -----------------------------------------------------------------------------
CREATE TABLE purchases (
    id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid        NOT NULL
                                        REFERENCES users(id)
                                        ON DELETE RESTRICT,
    pack_slug               text        NOT NULL
                                        REFERENCES packs(slug)
                                        ON DELETE RESTRICT,
    effective_price_paise   bigint      NOT NULL
                                        CHECK (effective_price_paise >= 0
                                               AND effective_price_paise <= 100000000),
    mrp_at_purchase_paise   bigint      NOT NULL
                                        CHECK (mrp_at_purchase_paise > 0
                                               AND mrp_at_purchase_paise <= 100000000),
    status                  text        NOT NULL
                                        CHECK (status IN ('pending', 'completed', 'failed')),
    razorpay_order_id       text        NOT NULL
                                        CHECK (length(razorpay_order_id) BETWEEN 1 AND 255),
    razorpay_payment_id     text        NULL
                                        CHECK (razorpay_payment_id IS NULL
                                               OR length(razorpay_payment_id) BETWEEN 1 AND 255),
    welcome_offer_applied   boolean     NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    completed_at            timestamptz NULL,

    -- Status / payment_id / completed_at consistency:
    --   pending   : payment_id NULL,     completed_at NULL
    --   completed : payment_id NOT NULL, completed_at NOT NULL
    --   failed    : completed_at NULL    (payment_id optional; Razorpay may
    --                                     have issued one before capture failed)
    CONSTRAINT purchases_status_payment_consistency CHECK (
        (status = 'pending'
         AND razorpay_payment_id IS NULL
         AND completed_at IS NULL)
        OR
        (status = 'completed'
         AND razorpay_payment_id IS NOT NULL
         AND completed_at IS NOT NULL)
        OR
        (status = 'failed'
         AND completed_at IS NULL)
    )
);

-- UNIQUE on order id (R10.1: one Purchase row per Razorpay_Order).
CREATE UNIQUE INDEX purchases_razorpay_order_id_key
    ON purchases (razorpay_order_id);

-- UNIQUE on payment id when present; NULLs are not considered equal in
-- Postgres so multiple pending rows (without a payment id) are allowed.
CREATE UNIQUE INDEX purchases_razorpay_payment_id_key
    ON purchases (razorpay_payment_id)
    WHERE razorpay_payment_id IS NOT NULL;

-- Lookup user purchase history in reverse chronological order (R10.12).
CREATE INDEX purchases_user_id_created_at_idx
    ON purchases (user_id, created_at DESC);

-- Lookup pending purchases for a pack (R11.7 deactivation gate).
CREATE INDEX purchases_pack_slug_status_idx
    ON purchases (pack_slug, status);

COMMENT ON TABLE  purchases IS
    'One row per Razorpay-backed pack purchase. Append-mostly; status transitions ''pending'' -> ''completed'' or ''failed'' once.';
COMMENT ON COLUMN purchases.effective_price_paise IS
    'Price actually charged in INR paise (Welcome Offer applied if eligible at checkout time).';
COMMENT ON COLUMN purchases.mrp_at_purchase_paise IS
    'Pack MRP at the time of checkout, snapshotted for audit.';
COMMENT ON COLUMN purchases.welcome_offer_applied IS
    'True iff the effective price was the Welcome Offer price (R5.4).';

-- -----------------------------------------------------------------------------
-- razorpay_events (webhook dedupe + unmatched reconciliation)
-- -----------------------------------------------------------------------------
CREATE TABLE razorpay_events (
    event_id     text        PRIMARY KEY
                             CHECK (length(event_id) BETWEEN 1 AND 255),
    event_type   text        NOT NULL
                             CHECK (length(event_type) BETWEEN 1 AND 100),
    order_id     text        NULL
                             CHECK (order_id IS NULL
                                    OR length(order_id) BETWEEN 1 AND 255),
    payment_id   text        NULL
                             CHECK (payment_id IS NULL
                                    OR length(payment_id) BETWEEN 1 AND 255),
    received_at  timestamptz NOT NULL DEFAULT now(),
    processed    boolean     NOT NULL DEFAULT false,
    unmatched    boolean     NOT NULL DEFAULT false,
    raw_payload  jsonb       NOT NULL
);

-- Reconciliation sweep (R10.10) walks unmatched-but-not-processed events.
CREATE INDEX razorpay_events_unmatched_idx
    ON razorpay_events (received_at)
    WHERE unmatched = true AND processed = false;

-- Lookup events for a given order id during reconciliation.
CREATE INDEX razorpay_events_order_id_idx
    ON razorpay_events (order_id)
    WHERE order_id IS NOT NULL;

COMMENT ON TABLE  razorpay_events IS
    'Webhook dedupe table keyed by Razorpay event id (R10.9). Rows for events whose order id is unknown to us are marked unmatched=true for later reconciliation (R10.10).';
COMMENT ON COLUMN razorpay_events.processed IS
    'True once the event has been fully applied (or determined to be a no-op replay).';
COMMENT ON COLUMN razorpay_events.unmatched IS
    'True when the verified webhook references an order id that does not match any purchases row at processing time.';

COMMIT;
