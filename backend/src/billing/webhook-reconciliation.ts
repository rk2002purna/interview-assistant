/**
 * Scheduled unmatched-webhook reconciliation handler (wallet top-up model).
 *
 * Re-reads `razorpay_events` rows where `unmatched = true` and
 * `processed = false`. For each event, checks whether a matching
 * `wallet_topups` row now exists (the top-up may have been persisted after the
 * webhook arrived due to a race). If a match is found and the top-up is still
 * `pending`, the handler processes the event (updates the top-up and credits
 * the wallet). If no match is found, the event is left for the next run.
 *
 * Each event is processed in its own transaction so a failure on one event does
 * not roll back progress on others.
 *
 * Requirements: 10.10, 15.4, 15.5.
 */

import type { Pool } from 'pg';
import { appendWalletEntry } from '../wallet/ledger.js';
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

interface TopupRow {
  id: string;
  user_id: string;
  amount_paise: string | number;
  status: string;
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
    if (!event.order_id) {
      stillUnmatchedCount++;
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const topupResult = await client.query<TopupRow>(
        `SELECT id, user_id, amount_paise, status
           FROM wallet_topups
          WHERE razorpay_order_id = $1
          FOR UPDATE`,
        [event.order_id],
      );

      const topup = topupResult.rows[0];

      if (!topup) {
        await client.query('ROLLBACK');
        stillUnmatchedCount++;
        continue;
      }

      if (topup.status !== 'pending') {
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

      if (event.event_type === 'payment.captured') {
        if (!event.payment_id) {
          // Cannot complete a top-up without a payment id (violates the
          // wallet_topups completed-state CHECK). Leave for manual handling.
          await client.query('ROLLBACK');
          stillUnmatchedCount++;
          continue;
        }
        await client.query(
          `UPDATE wallet_topups
              SET status = 'completed',
                  razorpay_payment_id = $1,
                  completed_at = $2
            WHERE id = $3`,
          [event.payment_id, effectiveNow, topup.id],
        );

        await appendWalletEntry(client, {
          userId: topup.user_id,
          amountPaise: Number(topup.amount_paise),
          reason: 'topup',
          razorpayPaymentId: event.payment_id,
          note: 'Wallet top-up (reconciled)',
        });

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
          topup_id: topup.id,
          user_id: topup.user_id,
        });
      } else if (event.event_type === 'payment.failed') {
        await client.query(
          `UPDATE wallet_topups SET status = 'failed' WHERE id = $1`,
          [topup.id],
        );

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
          topup_id: topup.id,
          user_id: topup.user_id,
          status: 'failed',
        });
      } else {
        await client.query('ROLLBACK');
        stillUnmatchedCount++;
        logger.warn('reconciliation_unknown_event_type', {
          event_id: event.event_id,
          event_type: event.event_type,
        });
      }
    } catch (err) {
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
