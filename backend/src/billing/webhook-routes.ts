/**
 * Razorpay webhook HTTP route.
 *
 * Exposes `POST /webhooks/razorpay` per Requirements 10.7, 10.8, 10.9, 10.10:
 *   1. Verifies the HMAC-SHA256 signature (returns 400 on failure).
 *   2. Deduplicates by `event_id` (returns 200 for replays).
 *   3. Branches on `payment.captured` / `payment.failed`:
 *      - `payment.captured`: updates purchase to `completed`, appends
 *        ledger entry (`pack_purchase` or `lifetime_grant`).
 *      - `payment.failed`: updates purchase to `failed`.
 *   4. Marks the event as processed.
 *   5. Returns 200 for unknown order ids (sets `unmatched=true`).
 *   6. Returns 200 for successful processing.
 *   7. Returns 400 only for signature failures.
 *
 * The entire flow runs in a single Postgres transaction so that dedupe,
 * purchase update, and ledger append are atomic.
 */

import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { verifyWebhookSignature } from './razorpay-signature.js';
import { appendLedgerEntry } from '../entitlement/ledger.js';
import { writeAudit } from '../log/audit.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookRouterDeps {
  /** Postgres pool for read/write queries. */
  readonly pool: Pool;
  /** Razorpay webhook secret for signature verification. */
  readonly webhookSecret: string;
}

/** Shape of the Razorpay webhook payload we care about. */
interface RazorpayWebhookPayload {
  event: string;
  payload: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        status?: string;
      };
    };
  };
}

/** Row from the `purchases` table. */
interface PurchaseRow {
  id: string;
  user_id: string;
  pack_slug: string;
  status: string;
}

/** Row from the `packs` table. */
interface PackRow {
  session_count: number | null;
  is_lifetime: boolean;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Build a Hono sub-app exposing the Razorpay webhook endpoint.
 */
export function buildWebhookRouter(deps: WebhookRouterDeps): Hono {
  const router = new Hono();

  router.post('/webhooks/razorpay', async (c) => {
    // 1. Read raw body for signature verification
    const rawBody = await c.req.text();
    const signature = c.req.header('X-Razorpay-Signature') ?? '';

    // Verify HMAC-SHA256 signature (R10.5, R10.6)
    const isValid = verifyWebhookSignature(rawBody, signature, deps.webhookSecret);
    if (!isValid) {
      // Write audit entry for signature failure (R10.6)
      // We do this outside the main transaction since we're rejecting
      const auditClient = await deps.pool.connect();
      try {
        await auditClient.query('BEGIN');
        await writeAudit(auditClient, {
          actor: { userId: null },
          target: { resource: 'webhook:razorpay' },
          eventType: 'webhook_signature_failure',
          outcome: 'failure',
          reasonCode: 'invalid_signature',
          metadata: {
            source_ip: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown',
          },
        });
        await auditClient.query('COMMIT');
      } catch {
        await auditClient.query('ROLLBACK').catch(() => {});
      } finally {
        auditClient.release();
      }

      return c.json(
        { error: { code: 'invalid_signature', message: 'webhook signature verification failed' } },
        400,
      );
    }

    // 2. Parse the payload
    let payload: RazorpayWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as RazorpayWebhookPayload;
    } catch {
      return c.json(
        { error: { code: 'invalid_body', message: 'request body must be valid JSON' } },
        400,
      );
    }

    // Extract event_id from the parsed payload
    // Razorpay sends event id at the top level as "id"
    const razorpayEventId = (payload as unknown as Record<string, unknown>).id as string | undefined;
    if (!razorpayEventId) {
      // If no event_id, still return 200 to avoid retries
      return c.json({ status: 'ignored', reason: 'missing_event_id' }, 200);
    }

    const eventType = payload.event;
    const paymentEntity = payload.payload?.payment?.entity;
    const orderId = paymentEntity?.order_id ?? null;
    const paymentId = paymentEntity?.id ?? null;

    // 3. Single transaction: dedupe → branch → update → mark processed
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      // Dedupe by event_id (R10.9)
      const dedupeResult = await client.query(
        `INSERT INTO razorpay_events (event_id, event_type, order_id, payment_id, raw_payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [razorpayEventId, eventType, orderId, paymentId, rawBody],
      );

      if (dedupeResult.rows.length === 0) {
        // This event was already processed — replay (R10.9)
        await client.query('COMMIT');
        return c.json({ status: 'already_processed' }, 200);
      }

      // Only process payment.captured and payment.failed
      if (eventType !== 'payment.captured' && eventType !== 'payment.failed') {
        // Mark as processed for non-payment events
        await client.query(
          `UPDATE razorpay_events SET processed = true WHERE event_id = $1`,
          [razorpayEventId],
        );
        await client.query('COMMIT');
        return c.json({ status: 'ignored', reason: 'unhandled_event_type' }, 200);
      }

      // Look up the purchase by razorpay_order_id
      if (!orderId) {
        // No order_id in the event — mark unmatched
        await client.query(
          `UPDATE razorpay_events SET processed = true, unmatched = true WHERE event_id = $1`,
          [razorpayEventId],
        );
        await client.query('COMMIT');
        return c.json({ status: 'unmatched', reason: 'no_order_id' }, 200);
      }

      const purchaseResult = await client.query<PurchaseRow>(
        `SELECT id, user_id, pack_slug, status
           FROM purchases
          WHERE razorpay_order_id = $1`,
        [orderId],
      );

      const purchase = purchaseResult.rows[0];
      if (!purchase) {
        // Unknown order id — mark unmatched (R10.10)
        await client.query(
          `UPDATE razorpay_events SET processed = true, unmatched = true WHERE event_id = $1`,
          [razorpayEventId],
        );
        await client.query('COMMIT');
        return c.json({ status: 'unmatched', reason: 'unknown_order_id' }, 200);
      }

      // If purchase is already completed or failed, this is a replay for a
      // known order — just mark processed and return 200 (R10.9)
      if (purchase.status !== 'pending') {
        await client.query(
          `UPDATE razorpay_events SET processed = true WHERE event_id = $1`,
          [razorpayEventId],
        );
        await client.query('COMMIT');
        return c.json({ status: 'already_processed' }, 200);
      }

      // Branch on event type
      if (eventType === 'payment.captured') {
        await handlePaymentCaptured(client, purchase, paymentId, razorpayEventId);
      } else if (eventType === 'payment.failed') {
        await handlePaymentFailed(client, purchase, razorpayEventId);
      }

      await client.query('COMMIT');
      return c.json({ status: 'processed' }, 200);
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
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handle `payment.captured`: update purchase to completed, append ledger entry.
 * (R10.7)
 */
async function handlePaymentCaptured(
  client: PoolClient,
  purchase: PurchaseRow,
  paymentId: string | null,
  eventId: string,
): Promise<void> {
  // Update purchase status to 'completed'
  await client.query(
    `UPDATE purchases
        SET status = 'completed',
            razorpay_payment_id = $1,
            completed_at = now()
      WHERE id = $2`,
    [paymentId, purchase.id],
  );

  // Look up the pack to determine session_count or lifetime
  const packResult = await client.query<PackRow>(
    `SELECT session_count, is_lifetime FROM packs WHERE slug = $1`,
    [purchase.pack_slug],
  );
  const pack = packResult.rows[0];

  if (pack && pack.is_lifetime) {
    // Lifetime grant (R10.7: reason 'lifetime_grant', lifetime_flag_set = 'set_true')
    await appendLedgerEntry(client, {
      userId: purchase.user_id,
      sessionDelta: 1, // Must be non-zero per schema CHECK; use +1 as a token grant
      lifetimeFlagSet: 'set_true',
      reason: 'lifetime_grant',
      razorpayPaymentId: paymentId,
    });
  } else if (pack && pack.session_count) {
    // Pack purchase (R10.7: reason 'pack_purchase', grant session_count)
    await appendLedgerEntry(client, {
      userId: purchase.user_id,
      sessionDelta: pack.session_count,
      lifetimeFlagSet: 'unchanged',
      reason: 'pack_purchase',
      razorpayPaymentId: paymentId,
    });
  }

  // Mark event as processed
  await client.query(
    `UPDATE razorpay_events SET processed = true WHERE event_id = $1`,
    [eventId],
  );
}

/**
 * Handle `payment.failed`: update purchase to failed. (R10.8)
 */
async function handlePaymentFailed(
  client: PoolClient,
  purchase: PurchaseRow,
  eventId: string,
): Promise<void> {
  // Update purchase status to 'failed'
  await client.query(
    `UPDATE purchases SET status = 'failed' WHERE id = $1`,
    [purchase.id],
  );

  // Mark event as processed
  await client.query(
    `UPDATE razorpay_events SET processed = true WHERE event_id = $1`,
    [eventId],
  );
}
