/**
 * Scheduled unmatched-webhook reconciliation handler.
 *
 * Re-reads `razorpay_events` rows where `unmatched = true` and
 * `processed = false`. For each event, checks whether a matching
 * `purchases` row now exists (the purchase may have been created after
 * the webhook arrived due to race conditions). If a match is found and
 * the purchase is still `pending`, the handler processes the event
 * (updates purchase status + appends an entitlement ledger entry). If
 * no match is found, the event is left for the next scheduled run.
 *
 * The function processes each event in its own transaction so that a
 * failure on one event does not roll back progress on others, while
 * still satisfying Requirement 15.5 (no partial commits per event).
 *
 * Wired into the platform's scheduled-invocation manifest (cron or
 * equivalent). Not exposed as an HTTP endpoint.
 *
 * Requirements: 10.10, 15.4, 15.5.
 */

import type { Pool } from 'pg';
import { appendLedgerEntry } from '../entitlement/ledger.js';
import { Logger } from '../log/logger.js';

const logger = new Logger({ bindings: { module: 'webhook_reconciliation' } });

export interface ReconciliationResult {
  /** Number of unmatched events examined. */
  examined_count: number;
  /** Number of events successfully reconciled (matched + processed). */
  reconciled_count: number;
  /** Number of events still unmatched (left for next run). */
  still_unmatched_count: number;
  /** Number of events that failed during processing. */
  error_count: number;
}

interface UnmatchedEventRow {
  event_id: string;
  event_type: string;
  order_id: string | null;
  payment_id: string | null;
  raw_payload: unknown;
}

interface PurchaseRow {
  id: string;
  user_id: string;
  pack_slug: string;
  status: string;
}

interface PackRow {
  session_count: number | null;
  is_lifetime: boolean;
}

/**
 * Run the unmatched-webhook reconciliation sweep.
 *
 * @param pool - Postgres connection pool.
 * @param now  - Optional clock override for testing. Defaults to current time.
 * @returns Summary of reconciliation results.
 */
export async function runWebhookReconciliation(
  pool: Pool,
  now?: Date,
): Promise<ReconciliationResult> {
  const effectiveNow = now ?? new Date();

  // Read all unmatched, unprocessed events. These are events whose
  // order_id did not match any purchases row at webhook receipt time.
  const unmatchedResult = await pool.query<UnmatchedEventRow>(
    `SELECT event_id, event_type, order_id, payment_id, raw_payload
       FROM razorpay_events
      WHERE unmatched = true
        AND processed = false
      ORDER BY received_at ASC`,
  );

  const events = unmatchedResult.rows;
  let reconciledCount = 0;
  let stillUnmatchedCount = 0;
  let errorCount = 0;

  for (const event of events) {
    // Skip events without an order_id — nothing to match against.
    if (!event.order_id) {
      stillUnmatchedCount++;
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Look up the purchase by razorpay_order_id.
      const purchaseResult = await client.query<PurchaseRow>(
        `SELECT id, user_id, pack_slug, status
           FROM purchases
          WHERE razorpay_order_id = $1
          FOR UPDATE`,
        [event.order_id],
      );

      const purchase = purchaseResult.rows[0];

      if (!purchase) {
        // Still no matching purchase row — leave for next run.
        await client.query('ROLLBACK');
        stillUnmatchedCount++;
        continue;
      }

      // If the purchase is already completed or failed, just mark the
      // event as processed (it's a replay of an already-handled state).
      if (purchase.status !== 'pending') {
        await client.query(
          `UPDATE razorpay_events
              SET processed = true,
                  unmatched = false
            WHERE event_id = $1`,
          [event.event_id],
        );
        await client.query('COMMIT');
        reconciledCount++;
        continue;
      }

      // Process based on event type.
      if (event.event_type === 'payment.captured') {
        // Look up the pack to determine session_count or lifetime.
        const packResult = await client.query<PackRow>(
          `SELECT session_count, is_lifetime
             FROM packs
            WHERE slug = $1`,
          [purchase.pack_slug],
        );
        const pack = packResult.rows[0];

        if (!pack) {
          // Pack no longer exists — unusual but possible. Log and skip.
          await client.query('ROLLBACK');
          logger.warn('reconciliation_pack_not_found', {
            event_id: event.event_id,
            pack_slug: purchase.pack_slug,
          });
          errorCount++;
          continue;
        }

        // Update purchase to completed.
        await client.query(
          `UPDATE purchases
              SET status = 'completed',
                  razorpay_payment_id = $1,
                  completed_at = $2
            WHERE id = $3`,
          [event.payment_id, effectiveNow, purchase.id],
        );

        // Append entitlement ledger entry.
        if (pack.is_lifetime) {
          await appendLedgerEntry(client, {
            userId: purchase.user_id,
            sessionDelta: 1,
            lifetimeFlagSet: 'set_true',
            reason: 'lifetime_grant',
            razorpayPaymentId: event.payment_id,
          });
        } else {
          await appendLedgerEntry(client, {
            userId: purchase.user_id,
            sessionDelta: pack.session_count!,
            lifetimeFlagSet: 'unchanged',
            reason: 'pack_purchase',
            razorpayPaymentId: event.payment_id,
          });
        }

        // Mark event as processed and no longer unmatched.
        await client.query(
          `UPDATE razorpay_events
              SET processed = true,
                  unmatched = false
            WHERE event_id = $1`,
          [event.event_id],
        );

        await client.query('COMMIT');
        reconciledCount++;

        logger.info('reconciliation_event_processed', {
          event_id: event.event_id,
          event_type: event.event_type,
          purchase_id: purchase.id,
          user_id: purchase.user_id,
          pack_slug: purchase.pack_slug,
        });
      } else if (event.event_type === 'payment.failed') {
        // Update purchase to failed.
        await client.query(
          `UPDATE purchases
              SET status = 'failed'
            WHERE id = $1`,
          [purchase.id],
        );

        // Mark event as processed and no longer unmatched.
        await client.query(
          `UPDATE razorpay_events
              SET processed = true,
                  unmatched = false
            WHERE event_id = $1`,
          [event.event_id],
        );

        await client.query('COMMIT');
        reconciledCount++;

        logger.info('reconciliation_event_processed', {
          event_id: event.event_id,
          event_type: event.event_type,
          purchase_id: purchase.id,
          user_id: purchase.user_id,
          status: 'failed',
        });
      } else {
        // Unknown event type — leave for next run but log a warning.
        await client.query('ROLLBACK');
        stillUnmatchedCount++;
        logger.warn('reconciliation_unknown_event_type', {
          event_id: event.event_id,
          event_type: event.event_type,
        });
      }
    } catch (err) {
      // Roll back on any error — Requirement 15.5: no partial commits.
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors.
      }
      errorCount++;
      logger.error('reconciliation_event_error', {
        event_id: event.event_id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.release();
    }
  }

  logger.info('webhook_reconciliation_completed', {
    examined_count: events.length,
    reconciled_count: reconciledCount,
    still_unmatched_count: stillUnmatchedCount,
    error_count: errorCount,
    sweep_time: effectiveNow.toISOString(),
  });

  return {
    examined_count: events.length,
    reconciled_count: reconciledCount,
    still_unmatched_count: stillUnmatchedCount,
    error_count: errorCount,
  };
}
