/**
 * Razorpay webhook HTTP route (wallet top-up model).
 *
 * `POST /webhooks/razorpay`:
 *   1. Verifies the HMAC-SHA256 signature (returns 400 on failure).
 *   2. Deduplicates by `event_id` (returns 200 for replays).
 *   3. Branches on `payment.captured` / `payment.failed`:
 *      - `payment.captured`: marks the `wallet_topups` row `completed` and
 *        credits the wallet (`wallet_ledger`, reason `topup`).
 *      - `payment.failed`: marks the `wallet_topups` row `failed`.
 *   4. Marks the event processed; unknown order ids are recorded `unmatched`.
 *
 * The whole flow runs in a single transaction so dedupe, top-up update, and
 * wallet credit are atomic.
 */

import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { verifyWebhookSignature } from './razorpay-signature.js';
import { appendWalletEntry } from '../wallet/ledger.js';
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

/** Row from the `wallet_topups` table. */
interface TopupRow {
  id: string;
  user_id: string;
  amount_paise: string | number;
  status: string;
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

    const isValid = verifyWebhookSignature(rawBody, signature, deps.webhookSecret);
    if (!isValid) {
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

    // Razorpay delivers the unique event id in the X-Razorpay-Event-Id header,
    // not the JSON body. Fall back to a body `id` for test/mock compatibility.
    const headerEventId = c.req.header('X-Razorpay-Event-Id');
    const bodyEventId = (payload as unknown as Record<string, unknown>).id;
    const razorpayEventId =
      (typeof headerEventId === 'string' && headerEventId.length > 0)
        ? headerEventId
        : (typeof bodyEventId === 'string' && bodyEventId.length > 0)
          ? bodyEventId
          : undefined;
    if (!razorpayEventId) {
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

      const dedupeResult = await client.query(
        `INSERT INTO razorpay_events (event_id, event_type, order_id, payment_id, raw_payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [razorpayEventId, eventType, orderId, paymentId, rawBody],
      );

      if (dedupeResult.rows.length === 0) {
        await client.query('COMMIT');
        return c.json({ status: 'already_processed' }, 200);
      }

      if (eventType !== 'payment.captured' && eventType !== 'payment.failed') {
        await client.query(
          `UPDATE razorpay_events SET processed = true WHERE event_id = $1`,
          [razorpayEventId],
        );
        await client.query('COMMIT');
        return c.json({ status: 'ignored', reason: 'unhandled_event_type' }, 200);
      }

      if (!orderId) {
        await client.query(
          `UPDATE razorpay_events SET processed = true, unmatched = true WHERE event_id = $1`,
          [razorpayEventId],
        );
        await client.query('COMMIT');
        return c.json({ status: 'unmatched', reason: 'no_order_id' }, 200);
      }

      const topupResult = await client.query<TopupRow>(
        `SELECT id, user_id, amount_paise, status
           FROM wallet_topups
          WHERE razorpay_order_id = $1`,
        [orderId],
      );

      const topup = topupResult.rows[0];
      if (!topup) {
        await client.query(
          `UPDATE razorpay_events SET processed = true, unmatched = true WHERE event_id = $1`,
          [razorpayEventId],
        );
        await client.query('COMMIT');
        return c.json({ status: 'unmatched', reason: 'unknown_order_id' }, 200);
      }

      // Replay for a top-up already resolved — just mark processed.
      if (topup.status !== 'pending') {
        await client.query(
          `UPDATE razorpay_events SET processed = true WHERE event_id = $1`,
          [razorpayEventId],
        );
        await client.query('COMMIT');
        return c.json({ status: 'already_processed' }, 200);
      }

      if (eventType === 'payment.captured') {
        if (!paymentId) {
          // A captured event with no payment id cannot satisfy the
          // wallet_topups completed-state CHECK (payment_id NOT NULL). Rather
          // than abort and trigger endless webhook retries, record it as
          // unmatched (processed) so an admin can credit manually if needed.
          await client.query(
            `UPDATE razorpay_events SET processed = true, unmatched = true WHERE event_id = $1`,
            [razorpayEventId],
          );
          await client.query('COMMIT');
          return c.json({ status: 'unmatched', reason: 'missing_payment_id' }, 200);
        }
        await handlePaymentCaptured(client, topup, paymentId, razorpayEventId);
      } else {
        await handlePaymentFailed(client, topup, razorpayEventId);
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
 * Handle `payment.captured`: mark the top-up completed and credit the wallet.
 */
async function handlePaymentCaptured(
  client: PoolClient,
  topup: TopupRow,
  paymentId: string | null,
  eventId: string,
): Promise<void> {
  // Conditional flip pending -> completed. Only the transaction that actually
  // flips the row credits the wallet, so the webhook and the synchronous
  // /payments/verify endpoint can never both credit the same top-up.
  const updated = await client.query(
    `UPDATE wallet_topups
        SET status = 'completed',
            razorpay_payment_id = $1,
            completed_at = now()
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

  await client.query(
    `UPDATE razorpay_events SET processed = true WHERE event_id = $1`,
    [eventId],
  );
}

/**
 * Handle `payment.failed`: mark the top-up failed.
 */
async function handlePaymentFailed(
  client: PoolClient,
  topup: TopupRow,
  eventId: string,
): Promise<void> {
  await client.query(
    `UPDATE wallet_topups SET status = 'failed' WHERE id = $1`,
    [topup.id],
  );

  await client.query(
    `UPDATE razorpay_events SET processed = true WHERE event_id = $1`,
    [eventId],
  );
}
