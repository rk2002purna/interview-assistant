/**
 * Purchase checkout HTTP routes.
 *
 * Exposes `POST /purchases/checkout` per Requirements 10.1, 10.2:
 *   1. Requires authenticated user (JWT verified).
 *   2. Accepts `{pack_slug: 'starter' | 'pro' | 'lifetime'}` in body.
 *   3. Looks up the pack from `packs` table; rejects if not active.
 *   4. Computes effective price using the `effectivePrice` function
 *      (considers welcome offer eligibility).
 *   5. Calls Razorpay Orders API to create an order (via injected
 *      `RazorpayClient` for testability).
 *   6. Persists a `purchases` row with status='pending'.
 *   7. Returns `{order_id, key_id, amount, currency, checkout_url}`.
 *
 * The Razorpay client is injected via `CheckoutRouterDeps` so tests can
 * provide a stub without network access.
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import {
  effectivePrice,
  type EffectivePricePack,
  type EffectivePriceWelcomeOffer,
} from '../packs/effective-price.js';
import type { RazorpayClient } from './razorpay-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid pack slugs accepted by the checkout endpoint. */
const VALID_PACK_SLUGS = ['starter', 'pro', 'lifetime'] as const;
type PackSlug = (typeof VALID_PACK_SLUGS)[number];

export interface CheckoutRouterDeps {
  /** Postgres pool for read/write queries. */
  readonly pool: Pool;
  /** Razorpay client (injected for testability). */
  readonly razorpayClient: RazorpayClient;
  /** Razorpay key_id returned to the client for frontend checkout. */
  readonly razorpayKeyId: string;
  /** Clock injection for tests. Defaults to wall clock. */
  readonly now?: () => Date;
}

interface PackRow {
  slug: string;
  mrp_paise: string | number;
  welcome_price_paise: string | number;
  active: boolean;
}

interface WelcomeOfferRow {
  enabled: boolean;
  ends_at: Date | string;
}

interface CompletedCountRow {
  count: string | number;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Row shape returned by the purchases query for GET /me/purchases. */
interface PurchaseListRow {
  id: string;
  pack_slug: string;
  effective_price_paise: string | number;
  mrp_at_purchase_paise: string | number;
  status: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  welcome_offer_applied: boolean;
  created_at: Date | string;
  completed_at: Date | string | null;
}

/**
 * Build a Hono sub-app exposing purchase checkout routes. The returned
 * router is intended to be mounted at the root of the main app.
 */
export function buildCheckoutRouter(deps: CheckoutRouterDeps): Hono {
  const router = new Hono();
  const clock = deps.now ?? ((): Date => new Date());

  router.post('/purchases/checkout', async (c) => {
    // 1. Authenticate
    const authResult = await authenticate(c.req.header('Authorization'));
    if ('errorBody' in authResult) {
      return c.json(authResult.errorBody, authResult.status);
    }
    const userId = authResult.sub;

    // 2. Parse and validate body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: 'invalid_body', message: 'request body must be valid JSON' } },
        400,
      );
    }

    const packSlug = parsePackSlug(body);
    if (!packSlug) {
      return c.json(
        {
          error: {
            code: 'invalid_pack_slug',
            message: `pack_slug must be one of: ${VALID_PACK_SLUGS.join(', ')}`,
          },
        },
        400,
      );
    }

    const client = await deps.pool.connect();
    try {
      // 3. Look up the pack; reject if not active
      const packResult = await client.query<PackRow>(
        `SELECT slug, mrp_paise, welcome_price_paise, active
           FROM packs
          WHERE slug = $1`,
        [packSlug],
      );
      const packRow = packResult.rows[0];
      if (!packRow) {
        return c.json(
          { error: { code: 'pack_not_found', message: 'pack not found' } },
          404,
        );
      }
      if (!packRow.active) {
        return c.json(
          { error: { code: 'pack_not_active', message: 'pack is not currently available' } },
          400,
        );
      }

      // 4. Compute effective price
      const mrp = Number(packRow.mrp_paise);
      const welcomePrice = Number(packRow.welcome_price_paise);

      const offerResult = await client.query<WelcomeOfferRow>(
        `SELECT enabled, ends_at FROM welcome_offer WHERE id = 1`,
      );
      const offerRow = offerResult.rows[0];
      const welcomeOffer: EffectivePriceWelcomeOffer = offerRow
        ? { enabled: offerRow.enabled, ends_at: toDate(offerRow.ends_at) }
        : { enabled: false, ends_at: new Date(0) };

      const completedResult = await client.query<CompletedCountRow>(
        `SELECT COUNT(*) AS count
           FROM purchases
          WHERE user_id = $1
            AND status = 'completed'`,
        [userId],
      );
      const completedCount = completedResult.rows[0]
        ? Number(completedResult.rows[0].count)
        : 0;

      const pack: EffectivePricePack = {
        mrp_paise: mrp,
        welcome_price_paise: welcomePrice,
      };
      const user = { completedPurchasesCount: completedCount };
      const now = clock();

      const price = effectivePrice(user, pack, welcomeOffer, now);
      const welcomeOfferApplied = price < mrp;

      // 5. Create Razorpay Order
      const purchaseId = randomUUID();
      let razorpayOrder;
      try {
        razorpayOrder = await deps.razorpayClient.createOrder({
          amount: price,
          currency: 'INR',
          receipt: purchaseId,
          notes: {
            pack_slug: packSlug,
            user_id: userId,
          },
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Razorpay order creation failed';
        return c.json(
          { error: { code: 'payment_gateway_error', message } },
          502,
        );
      }

      // 6. Persist purchases row with status='pending'
      await client.query(
        `INSERT INTO purchases (
           id, user_id, pack_slug, effective_price_paise,
           mrp_at_purchase_paise, status, razorpay_order_id,
           welcome_offer_applied
         ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
        [
          purchaseId,
          userId,
          packSlug,
          price,
          mrp,
          razorpayOrder.id,
          welcomeOfferApplied,
        ],
      );

      // 7. Return checkout details
      const checkoutUrl =
        razorpayOrder.short_url ??
        `https://checkout.razorpay.com/payment/${razorpayOrder.id}?key=${encodeURIComponent(deps.razorpayKeyId)}`;

      return c.json(
        {
          order_id: razorpayOrder.id,
          key_id: deps.razorpayKeyId,
          amount: price,
          currency: 'INR',
          checkout_url: checkoutUrl,
        },
        201,
      );
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // GET /me/purchases — Requirement 10.12
  // Returns the caller's purchase records in reverse chronological order.
  // -------------------------------------------------------------------------
  router.get('/me/purchases', async (c) => {
    // 1. Authenticate
    const authResult = await authenticate(c.req.header('Authorization'));
    if ('errorBody' in authResult) {
      return c.json(authResult.errorBody, authResult.status);
    }
    const userId = authResult.sub;

    // 2. Query purchases in reverse chronological order
    const client = await deps.pool.connect();
    try {
      const result = await client.query<PurchaseListRow>(
        `SELECT id, pack_slug, effective_price_paise, mrp_at_purchase_paise,
                status, razorpay_order_id, razorpay_payment_id,
                welcome_offer_applied, created_at, completed_at
           FROM purchases
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId],
      );

      const purchases = result.rows.map((row) => ({
        id: row.id,
        pack_slug: row.pack_slug,
        effective_price_paise: Number(row.effective_price_paise),
        mrp_at_purchase_paise: Number(row.mrp_at_purchase_paise),
        status: row.status,
        razorpay_order_id: row.razorpay_order_id,
        razorpay_payment_id: row.razorpay_payment_id ?? null,
        welcome_offer_applied: row.welcome_offer_applied,
        created_at: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
        completed_at: row.completed_at
          ? row.completed_at instanceof Date
            ? row.completed_at.toISOString()
            : row.completed_at
          : null,
      }));

      return c.json({ purchases }, 200);
    } finally {
      client.release();
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AuthSuccess {
  sub: string;
  role: 'user' | 'admin';
  client_id: string;
}

interface AuthFailure {
  status: 401;
  errorBody: { error: { code: string; message: string } };
}

async function authenticate(
  authorization: string | undefined,
): Promise<AuthSuccess | AuthFailure> {
  if (!authorization) {
    return {
      status: 401,
      errorBody: {
        error: { code: 'unauthenticated', message: 'missing Authorization header' },
      },
    };
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) {
    return {
      status: 401,
      errorBody: {
        error: { code: 'unauthenticated', message: 'malformed Authorization header' },
      },
    };
  }
  try {
    const claims = await verifyAccess(match[1]!);
    return { sub: claims.sub, role: claims.role, client_id: claims.client_id };
  } catch (err) {
    const code = err instanceof JwtError ? err.code : 'unauthenticated';
    const message = err instanceof Error ? err.message : 'invalid token';
    return { status: 401, errorBody: { error: { code, message } } };
  }
}

function parsePackSlug(body: unknown): PackSlug | null {
  if (typeof body !== 'object' || body === null) return null;
  const slug = (body as Record<string, unknown>).pack_slug;
  if (typeof slug !== 'string') return null;
  if (!(VALID_PACK_SLUGS as readonly string[]).includes(slug)) return null;
  return slug as PackSlug;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
