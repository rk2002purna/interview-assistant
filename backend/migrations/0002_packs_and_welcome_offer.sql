-- Migration 0002: Pack catalog and Welcome Offer singleton
--
-- Implements Requirements 5.1, 5.2, 5.3 from the credits-and-subscription-system spec.
--
-- Tables:
--   packs           - immutable-slug catalog of one-time Interview Session Packs
--   welcome_offer   - single-row global discount campaign configuration
--
-- All monetary amounts are stored in INR paise as bigints.
-- All timestamps are timestamptz (UTC).

BEGIN;

-- =============================================================================
-- packs (Pack_Catalog)
-- =============================================================================
--
-- Holds exactly the three pack slugs allowed by Requirement 5.1: starter, pro,
-- lifetime. Each row enforces:
--   * display_name length 1..50            (R5.1)
--   * description  length 1..500           (R5.1)
--   * mrp_paise   in (0, 100_000_000]      (R5.1)
--   * welcome_price_paise in [0, mrp_paise) -- strictly less than MRP (R5.1)
--   * session_count > 0 when present       (R5.1)
--   * is_lifetime XOR session_count        (R5.1, lifetime grants unlimited)

CREATE TABLE IF NOT EXISTS packs (
    slug                 text        PRIMARY KEY
        CONSTRAINT packs_slug_allowed CHECK (slug IN ('starter', 'pro', 'lifetime')),
    display_name         text        NOT NULL
        CONSTRAINT packs_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 50),
    description          text        NOT NULL
        CONSTRAINT packs_description_length CHECK (char_length(description) BETWEEN 1 AND 500),
    mrp_paise            bigint      NOT NULL
        CONSTRAINT packs_mrp_range CHECK (mrp_paise > 0 AND mrp_paise <= 100000000),
    welcome_price_paise  bigint      NOT NULL
        CONSTRAINT packs_welcome_price_range CHECK (welcome_price_paise >= 0),
    session_count        integer     NULL
        CONSTRAINT packs_session_count_positive CHECK (session_count IS NULL OR session_count > 0),
    is_lifetime          boolean     NOT NULL DEFAULT false,
    active               boolean     NOT NULL DEFAULT true,
    updated_at           timestamptz NOT NULL DEFAULT now(),

    -- welcome_price_paise must be strictly less than mrp_paise
    CONSTRAINT packs_welcome_price_lt_mrp
        CHECK (welcome_price_paise < mrp_paise),

    -- Lifetime XOR session_count: a lifetime pack has no session_count;
    -- a non-lifetime pack must have a positive session_count.
    CONSTRAINT packs_lifetime_xor_session_count CHECK (
        (is_lifetime = true  AND session_count IS NULL)
        OR
        (is_lifetime = false AND session_count IS NOT NULL)
    )
);

-- =============================================================================
-- welcome_offer (singleton)
-- =============================================================================
--
-- Per Requirement 5.3 there is exactly one Welcome_Offer record. The id column
-- is constrained to the literal value 1 to enforce singleton semantics; any
-- attempt to insert a second row will fail the CHECK constraint and the
-- primary key.

CREATE TABLE IF NOT EXISTS welcome_offer (
    id          integer     PRIMARY KEY
        CONSTRAINT welcome_offer_singleton CHECK (id = 1),
    enabled     boolean     NOT NULL,
    ends_at     timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Seed data (Requirement 5.2 and 5.3)
-- =============================================================================
--
-- Defaults from Requirement 5.2:
--   starter:  MRP  99900 paise (Rs.  999), Welcome  49900 paise (Rs.  499), 5 sessions
--   pro:      MRP 249900 paise (Rs. 2499), Welcome  99900 paise (Rs.  999), 15 sessions
--   lifetime: MRP 999900 paise (Rs. 9999), Welcome 199900 paise (Rs. 1999), unlimited
--
-- ON CONFLICT DO NOTHING keeps this migration idempotent without overwriting
-- any admin edits made post-deploy.

INSERT INTO packs (
    slug, display_name, description,
    mrp_paise, welcome_price_paise,
    session_count, is_lifetime, active
) VALUES
    (
        'starter',
        'Starter',
        '5 Interview Sessions. Each session is a 90-minute window of unlimited AI usage across Manual, Passive, and Screen Analyzer modes.',
        99900, 49900,
        5, false, true
    ),
    (
        'pro',
        'Pro',
        '15 Interview Sessions. Each session is a 90-minute window of unlimited AI usage across Manual, Passive, and Screen Analyzer modes.',
        249900, 99900,
        15, false, true
    ),
    (
        'lifetime',
        'Lifetime',
        'Unlimited Interview Sessions for the lifetime of your account. Each session is a 90-minute window of unlimited AI usage across Manual, Passive, and Screen Analyzer modes.',
        999900, 199900,
        NULL, true, true
    )
ON CONFLICT (slug) DO NOTHING;

-- Seed the singleton Welcome_Offer row: enabled, ends 90 days from first
-- deployment (Requirement 5.3).
INSERT INTO welcome_offer (id, enabled, ends_at, created_at, updated_at)
VALUES (1, true, now() + interval '90 days', now(), now())
ON CONFLICT (id) DO NOTHING;

COMMIT;
