/**
 * Scheduled session expiry sweep.
 *
 * Transitions any `active` interview sessions whose `expires_at` has
 * passed to `expired` status. The function is idempotent: running it
 * multiple times has no additional effect because only rows with
 * `status = 'active'` are targeted, and once transitioned they no
 * longer match the WHERE clause.
 *
 * Wired into the platform's scheduled-invocation manifest (cron or
 * equivalent). Not exposed as an HTTP endpoint.
 *
 * Requirements: 8.5, 15.4, 15.5.
 */

import type { Pool } from 'pg';
import { Logger } from '../log/logger.js';

const logger = new Logger({ bindings: { module: 'session_expiry_sweep' } });

export interface SweepResult {
  expired_count: number;
}

/**
 * Expire all active sessions whose `expires_at` is at or before `now`.
 *
 * @param pool - Postgres connection pool.
 * @param now  - Optional clock override for testing. Defaults to current time.
 * @returns The count of sessions transitioned to `expired`.
 */
export async function runSessionExpirySweep(
  pool: Pool,
  now?: Date,
): Promise<SweepResult> {
  const effectiveNow = now ?? new Date();

  const result = await pool.query(
    `UPDATE interview_sessions
        SET status = 'expired',
            ended_at = $1,
            ended_reason = 'expired'
      WHERE status = 'active'
        AND expires_at <= $1`,
    [effectiveNow],
  );

  const expiredCount = result.rowCount ?? 0;

  logger.info('session_expiry_sweep_completed', {
    expired_count: expiredCount,
    sweep_time: effectiveNow.toISOString(),
  });

  return { expired_count: expiredCount };
}
