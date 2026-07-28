/**
 * Wallet top-up checkout HTTP routes.
 *
 * Exposes:
 *   - `POST /wallet/topup/checkout` — create a Razorpay order for an arbitrary
 *     wallet recharge amount and persist a pending `wallet_topups` row. The
 *     wallet is credited later by the webhook on `payment.captured`.
 *   - `GET  /me/topups`            — the caller's recharge history.
 *
 * The Razorpay client is injected via `CheckoutRouterDeps` so tests can provide
 * a stub without network access. (The dependency shape is unchanged from the
 * previous pack-based checkout so app wiring stays the same.)
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import type { RazorpayClient } from './razorpay-client.js';
import { verifyPaymentSignature } from './razorpay-signature.js';
import { appendWalletEntry, getWalletBalancePaise } from '../wallet/ledger.js';

// Top-up bounds in paise: min Rs 1, max Rs 100,000.
const MIN_TOPUP_PAISE = 100;
const MAX_TOPUP_PAISE = 10_000_000;

export interface CheckoutRouterDeps {
  /** Postgres pool for read/write queries. */
  readonly pool: Pool;
  /** Razorpay client (injected for testability). */
  readonly razorpayClient: RazorpayClient;
  /** Razorpay key_id returned to the client for frontend checkout. */
  readonly razorpayKeyId: string;
  /** Razorpay key secret for verifying the checkout payment signature (server-only). */
  readonly razorpayKeySecret?: string;
  /** Clock injection for tests. Defaults to wall clock. */
  readonly now?: () => Date;
}

/** Row shape returned by the top-up history query. */
interface TopupListRow {
  id: string;
  amount_paise: string | number;
  status: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
}

/**
 * Build a Hono sub-app exposing wallet top-up checkout routes. Mount at the
 * root of the main app.
 */
export function buildCheckoutRouter(deps: CheckoutRouterDeps): Hono {
  const router = new Hono();

  router.post('/wallet/topup/checkout', async (c) => {
    const authResult = await authenticate(c.req.header('Authorization'));
    if ('errorBody' in authResult) {
      return c.json(authResult.errorBody, authResult.status);
    }
    const userId = authResult.sub;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: 'invalid_body', message: 'request body must be valid JSON' } },
        400,
      );
    }

    const amountPaise = parseAmountPaise(body);
    if (amountPaise === null) {
      return c.json(
        {
          error: {
            code: 'invalid_amount',
            message: `amount_paise must be an integer between ${MIN_TOPUP_PAISE} and ${MAX_TOPUP_PAISE}`,
          },
        },
        400,
      );
    }

    const client = await deps.pool.connect();
    try {
      const topupId = randomUUID();

      // Create the Razorpay order for the recharge amount.
      let razorpayOrder;
      try {
        razorpayOrder = await deps.razorpayClient.createOrder({
          amount: amountPaise,
          currency: 'INR',
          receipt: topupId,
          notes: {
            kind: 'wallet_topup',
            user_id: userId,
          },
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Razorpay order creation failed';
        return c.json({ error: { code: 'payment_gateway_error', message } }, 502);
      }

      // Persist a pending top-up row keyed by the Razorpay order id.
      await client.query(
        `INSERT INTO wallet_topups (id, user_id, amount_paise, status, razorpay_order_id)
         VALUES ($1, $2, $3, 'pending', $4)`,
        [topupId, userId, amountPaise, razorpayOrder.id],
      );

      const checkoutUrl =
        razorpayOrder.short_url ??
        `https://checkout.razorpay.com/payment/${razorpayOrder.id}?key=${encodeURIComponent(deps.razorpayKeyId)}`;

      return c.json(
        {
          topup_id: topupId,
          order_id: razorpayOrder.id,
          key_id: deps.razorpayKeyId,
          amount: amountPaise,
          currency: 'INR',
          checkout_url: checkoutUrl,
        },
        201,
      );
    } finally {
      client.release();
    }
  });

  router.get('/me/topups', async (c) => {
    const authResult = await authenticate(c.req.header('Authorization'));
    if ('errorBody' in authResult) {
      return c.json(authResult.errorBody, authResult.status);
    }
    const userId = authResult.sub;

    const client = await deps.pool.connect();
    try {
      // Auto-expire any pending topups older than 30 minutes (Razorpay orders
      // expire after ~30 min). This ensures the user sees a clear "expired"
      // status instead of a perpetual "pending" for abandoned/failed attempts.
      await client.query(
        `UPDATE wallet_topups
            SET status = 'expired'
          WHERE user_id = $1
            AND status = 'pending'
            AND created_at < now() - interval '30 minutes'`,
        [userId],
      );

      const result = await client.query<TopupListRow>(
        `SELECT id, amount_paise, status, razorpay_order_id,
                razorpay_payment_id, created_at, completed_at
           FROM wallet_topups
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId],
      );

      const topups = result.rows.map((row) => ({
        id: row.id,
        amount_paise: Number(row.amount_paise),
        status: row.status,
        razorpay_order_id: row.razorpay_order_id,
        razorpay_payment_id: row.razorpay_payment_id ?? null,
        created_at:
          row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        completed_at: row.completed_at
          ? row.completed_at instanceof Date
            ? row.completed_at.toISOString()
            : row.completed_at
          : null,
      }));

      return c.json({ topups }, 200);
    } finally {
      client.release();
    }
  });

  // POST /payments/verify
  //
  // Synchronous confirmation for Razorpay Standard Checkout. The browser posts
  // { razorpay_order_id, razorpay_payment_id, razorpay_signature } after a
  // successful payment. We verify the HMAC-SHA256 signature with the KEY_SECRET
  // and, if valid, credit the wallet — guarded by a conditional pending ->
  // completed update so this and the webhook can never double-credit.
  router.post('/payments/verify', async (c) => {
    const authResult = await authenticate(c.req.header('Authorization'));
    if ('errorBody' in authResult) {
      return c.json(authResult.errorBody, authResult.status);
    }
    const userId = authResult.sub;

    if (!deps.razorpayKeySecret) {
      return c.json(
        { error: { code: 'not_configured', message: 'payment verification is not configured' } },
        500,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'request body must be valid JSON' } }, 400);
    }

    const fields = (body ?? {}) as Record<string, unknown>;
    const orderId = typeof fields.razorpay_order_id === 'string' ? fields.razorpay_order_id : '';
    const paymentId = typeof fields.razorpay_payment_id === 'string' ? fields.razorpay_payment_id : '';
    const signature = typeof fields.razorpay_signature === 'string' ? fields.razorpay_signature : '';

    if (!orderId || !paymentId || !signature) {
      return c.json(
        {
          error: {
            code: 'missing_fields',
            message: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required',
          },
        },
        400,
      );
    }

    if (!verifyPaymentSignature(orderId, paymentId, signature, deps.razorpayKeySecret)) {
      // Do NOT credit on a signature mismatch.
      return c.json(
        { error: { code: 'invalid_signature', message: 'payment signature verification failed' } },
        400,
      );
    }

    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      const topupResult = await client.query<{
        id: string;
        user_id: string;
        amount_paise: string | number;
        status: string;
      }>(
        `SELECT id, user_id, amount_paise, status
           FROM wallet_topups
          WHERE razorpay_order_id = $1
          FOR UPDATE`,
        [orderId],
      );
      const topup = topupResult.rows[0];

      if (!topup) {
        await client.query('ROLLBACK');
        return c.json({ error: { code: 'order_not_found', message: 'no top-up matches this order' } }, 404);
      }
      if (topup.user_id !== userId) {
        await client.query('ROLLBACK');
        return c.json({ error: { code: 'forbidden', message: 'order does not belong to this user' } }, 403);
      }

      // Conditional flip pending -> completed. Only the winner credits.
      const updated = await client.query(
        `UPDATE wallet_topups
            SET status = 'completed', razorpay_payment_id = $1, completed_at = now()
          WHERE id = $2 AND status = 'pending'`,
        [paymentId, topup.id],
      );
      if (updated.rowCount === 1) {
        await appendWalletEntry(client, {
          userId: topup.user_id,
          amountPaise: Number(topup.amount_paise),
          reason: 'topup',
          razorpayPaymentId: paymentId,
          note: 'Wallet top-up',
        });
      }

      const balancePaise = await getWalletBalancePaise(client, topup.user_id);
      await client.query('COMMIT');

      return c.json({ verified: true, balance_paise: balancePaise });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
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

/**
 * Parse and validate `{ amount_paise }` from the request body. Returns the
 * integer amount in paise, or null when missing / out of range.
 */
function parseAmountPaise(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as Record<string, unknown>).amount_paise;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < MIN_TOPUP_PAISE || raw > MAX_TOPUP_PAISE) return null;
  return raw;
}
