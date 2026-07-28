/**
 * Session HTTP routes — wallet / per-minute billing model.
 *
 * Interview time is billed from the user's prepaid wallet at a flat per-minute
 * rate (`RATE_PER_MINUTE_PAISE`). Each *started* minute is charged in full
 * (rounded up): a 1m20s session costs 2 minutes.
 *
 *   - `POST /sessions/start`        — requires wallet >= 1 minute; charges the
 *                                     first minute up front; sets a
 *                                     balance-bounded expires_at safety cap.
 *   - `GET  /me/session/active`     — the caller's active session with remaining
 *                                     seconds, wallet balance, and amount billed.
 *   - `POST /sessions/:id/heartbeat`— called ~every 60s while recording; bills
 *                                     each newly-elapsed minute. When the wallet
 *                                     can no longer cover the next minute the
 *                                     session is ended (`insufficient_funds`).
 *   - `POST /sessions/:id/end`      — bills the final started minute and ends
 *                                     the session (`ended_by_user`).
 *
 * Authentication is performed inline via `verifyAccess`, matching the other
 * routers. Every write path runs in a single transaction that holds the
 * per-user advisory lock, so wallet debits and session updates are atomic and
 * serialized against concurrent starts/charges for the same user.
 */

import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import {
  appendWalletEntry,
  getWalletBalancePaise,
  WalletError,
  RATE_PER_MINUTE_PAISE,
  MAX_SESSION_MINUTES,
} from '../wallet/ledger.js';

export interface SessionsRouterDeps {
  /** Postgres pool for read/write queries. */
  readonly pool: Pool;
  /** Clock injection used by tests. Defaults to wall clock. */
  readonly now?: () => Date;
}

/**
 * Advisory lock keyed on the user_id. Same hashing approach as the wallet /
 * entitlement writers so all per-user money operations serialize on one key.
 */
const ADVISORY_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(('x' || left(md5($1::text), 15))::bit(64)::bigint)";

/** Active session lookup (uses the one_active_session_per_user partial index). */
const ACTIVE_SESSION_SQL = `
  SELECT id, started_at, expires_at, charged_paise
    FROM interview_sessions
   WHERE user_id = $1
     AND status = 'active'
   LIMIT 1
`;

const INSERT_SESSION_SQL = `
  INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at, charged_paise)
  VALUES ($1, $2, 'active', $3, $4, 0)
  RETURNING id, started_at, expires_at
`;

const FIND_SESSION_SQL = `
  SELECT id, user_id, status, started_at, charged_paise
    FROM interview_sessions
   WHERE id = $1
`;

interface ActiveSessionRow {
  id: string;
  started_at: Date | string;
  expires_at: Date | string;
  charged_paise: number | string;
}

interface FindSessionRow {
  id: string;
  user_id: string;
  status: string;
  started_at: Date | string;
  charged_paise: number | string;
}

interface InsertedSessionRow {
  id: string;
  started_at: Date | string;
  expires_at: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Minutes owed for a session that started at `startedAt` observed at `now`.
 * Each started minute counts (rounded up), with a floor of 1 so the first
 * minute is always billable the instant recording begins.
 */
function owedMinutes(startedAtMs: number, nowMs: number): number {
  const elapsedSec = Math.max(0, (nowMs - startedAtMs) / 1000);
  return Math.max(1, Math.ceil(elapsedSec / 60));
}

interface ChargeResult {
  chargedPaise: number;
  balancePaise: number;
  /** True when the wallet could not cover all minutes owed so far. */
  exhausted: boolean;
}

/**
 * Bill any newly-elapsed whole minutes for an active session, within the
 * caller's transaction (which must already hold the per-user advisory lock).
 *
 * Charges `min(owed - alreadyCharged, affordable)` minutes. If the wallet
 * cannot cover every owed minute, it charges what it can and reports
 * `exhausted = true` so the caller ends the session.
 */
async function chargeElapsedMinutes(
  client: PoolClient,
  userId: string,
  session: { id: string; startedAtMs: number; chargedPaise: number },
  nowMs: number,
): Promise<ChargeResult> {
  const owed = owedMinutes(session.startedAtMs, nowMs);
  const alreadyChargedMinutes = Math.round(session.chargedPaise / RATE_PER_MINUTE_PAISE);
  const deltaMinutes = owed - alreadyChargedMinutes;

  if (deltaMinutes <= 0) {
    const balancePaise = await getWalletBalancePaise(client, userId);
    return { chargedPaise: session.chargedPaise, balancePaise, exhausted: false };
  }

  const balance = await getWalletBalancePaise(client, userId);
  const affordableMinutes = Math.floor(balance / RATE_PER_MINUTE_PAISE);
  const minutesToCharge = Math.min(deltaMinutes, affordableMinutes);

  let newChargedPaise = session.chargedPaise;
  let newBalance = balance;

  if (minutesToCharge > 0) {
    const amount = minutesToCharge * RATE_PER_MINUTE_PAISE;
    const res = await appendWalletEntry(client, {
      userId,
      amountPaise: -amount,
      reason: 'session_charge',
      interviewSessionId: session.id,
      note: `Interview time: ${minutesToCharge} min`,
    });
    newBalance = res.resultingBalancePaise;
    newChargedPaise = session.chargedPaise + amount;
    await client.query(
      `UPDATE interview_sessions SET charged_paise = $1 WHERE id = $2`,
      [newChargedPaise, session.id],
    );
  }

  // If we could not pay for every owed minute, the wallet is exhausted.
  return {
    chargedPaise: newChargedPaise,
    balancePaise: newBalance,
    exhausted: minutesToCharge < deltaMinutes,
  };
}

const END_SESSION_SQL = `
  UPDATE interview_sessions
     SET status = 'ended',
         ended_at = NOW(),
         ended_reason = $3
   WHERE id = $1
     AND user_id = $2
     AND status = 'active'
  RETURNING ended_at
`;

/**
 * Extract and verify the JWT from the Authorization header.
 * Returns the user id on success, or a JSON error response on failure.
 */
async function authenticateRequest(c: any): Promise<{ userId: string } | Response> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return c.json(
      { error: { code: 'unauthenticated', message: 'missing Authorization header' } },
      401,
    );
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  if (!match) {
    return c.json(
      { error: { code: 'unauthenticated', message: 'malformed Authorization header' } },
      401,
    );
  }
  try {
    const claims = await verifyAccess(match[1]!);
    return { userId: claims.sub };
  } catch (err) {
    const code = err instanceof JwtError ? err.code : 'unauthenticated';
    const message = err instanceof Error ? err.message : 'invalid token';
    return c.json({ error: { code, message } }, 401);
  }
}

/**
 * Build a Hono sub-app exposing session routes. Mount at the root of the app.
 */
export function buildSessionsRouter(deps: SessionsRouterDeps): Hono {
  const router = new Hono();

  /**
   * POST /sessions/start
   *
   * Requires the wallet to cover at least one minute. Charges the first minute
   * up front, then sets expires_at to a balance-bounded safety cap so a session
   * can never bill beyond the funds available at start (and never beyond
   * MAX_SESSION_MINUTES).
   */
  router.post('/sessions/start', async (c) => {
    const authResult = await authenticateRequest(c);
    if (!(authResult && 'userId' in authResult)) {
      return authResult;
    }
    const { userId } = authResult;

    const clock = deps.now ?? (() => new Date());
    let client: PoolClient | undefined;

    try {
      client = await deps.pool.connect();
      await client.query('BEGIN');

      await client.query(ADVISORY_LOCK_SQL, [userId]);

      // Reject a second concurrent session.
      const activeResult = await client.query<ActiveSessionRow>(ACTIVE_SESSION_SQL, [userId]);
      const activeRow = activeResult.rows[0];
      if (activeRow) {
        await client.query('ROLLBACK');
        return c.json(
          {
            error: {
              code: 'session_already_active',
              details: {
                active_session_id: activeRow.id,
                expires_at: toDate(activeRow.expires_at).toISOString(),
              },
            },
          },
          409,
        );
      }

      // Require at least one minute of balance.
      const balance = await getWalletBalancePaise(client, userId);
      if (balance < RATE_PER_MINUTE_PAISE) {
        await client.query('ROLLBACK');
        return c.json(
          {
            error: {
              code: 'insufficient_balance',
              message: 'Add money to your wallet to start an interview.',
              details: {
                balance_paise: balance,
                rate_per_minute_paise: RATE_PER_MINUTE_PAISE,
              },
            },
          },
          402,
        );
      }

      // Balance-bounded safety cap on session length.
      const affordableMinutes = Math.min(
        MAX_SESSION_MINUTES,
        Math.max(1, Math.floor(balance / RATE_PER_MINUTE_PAISE)),
      );
      const sessionId = randomUUID();
      const startedAt = clock();
      const expiresAt = new Date(startedAt.getTime() + affordableMinutes * 60 * 1000);

      const insertResult = await client.query<InsertedSessionRow>(INSERT_SESSION_SQL, [
        sessionId,
        userId,
        startedAt.toISOString(),
        expiresAt.toISOString(),
      ]);

      // Charge the first minute up front.
      const charge = await chargeElapsedMinutes(
        client,
        userId,
        { id: sessionId, startedAtMs: startedAt.getTime(), chargedPaise: 0 },
        startedAt.getTime(),
      );

      await client.query('COMMIT');

      const inserted = insertResult.rows[0]!;
      return c.json(
        {
          session_id: inserted.id,
          started_at: toDate(inserted.started_at).toISOString(),
          expires_at: toDate(inserted.expires_at).toISOString(),
          rate_per_minute_paise: RATE_PER_MINUTE_PAISE,
          balance_paise: charge.balancePaise,
          charged_paise: charge.chargedPaise,
        },
        201,
      );
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback errors.
        }
      }
      if (err instanceof WalletError && err.code === 'insufficient_balance') {
        return c.json(
          { error: { code: 'insufficient_balance', message: 'Insufficient wallet balance.' } },
          402,
        );
      }
      throw err;
    } finally {
      if (client) {
        client.release();
      }
    }
  });

  /**
   * GET /me/session/active
   *
   * Returns the caller's active interview session with remaining seconds (to
   * the balance-bounded cap), current wallet balance, and amount billed so far.
   */
  router.get('/me/session/active', async (c) => {
    const authResult = await authenticateRequest(c);
    if (!(authResult && 'userId' in authResult)) {
      return authResult;
    }
    const { userId } = authResult;

    const result = await deps.pool.query<ActiveSessionRow>(ACTIVE_SESSION_SQL, [userId]);
    const row = result.rows[0];
    if (!row) {
      return c.json(
        { error: { code: 'no_active_session', message: 'no active interview session' } },
        404,
      );
    }

    const now = deps.now ? deps.now() : new Date();
    const remainingMs = toDate(row.expires_at).getTime() - now.getTime();
    const remaining_seconds = Math.max(0, Math.floor(remainingMs / 1000));
    const balancePaise = await getWalletBalancePaise(deps.pool, userId);

    return c.json({
      session_id: row.id,
      started_at: toDate(row.started_at).toISOString(),
      expires_at: toDate(row.expires_at).toISOString(),
      remaining_seconds,
      rate_per_minute_paise: RATE_PER_MINUTE_PAISE,
      balance_paise: balancePaise,
      charged_paise: Number(row.charged_paise),
    });
  });

  /**
   * POST /sessions/:id/heartbeat
   *
   * Called ~every 60s while recording. Bills each newly-elapsed minute. If the
   * wallet cannot cover the next minute, the session is ended with
   * `insufficient_funds` and `active: false` is returned so the client stops.
   */
  router.post('/sessions/:id/heartbeat', async (c) => {
    const authResult = await authenticateRequest(c);
    if (!(authResult && 'userId' in authResult)) {
      return authResult;
    }
    const { userId } = authResult;
    const sessionId = c.req.param('id');
    const clock = deps.now ?? (() => new Date());
    let client: PoolClient | undefined;

    try {
      client = await deps.pool.connect();
      await client.query('BEGIN');
      await client.query(ADVISORY_LOCK_SQL, [userId]);

      const findResult = await client.query<FindSessionRow>(FIND_SESSION_SQL, [sessionId]);
      const session = findResult.rows[0];
      if (!session || session.user_id !== userId) {
        await client.query('ROLLBACK');
        return c.json(
          { error: { code: 'session_not_found', message: 'session not found' } },
          404,
        );
      }
      if (session.status !== 'active') {
        await client.query('ROLLBACK');
        return c.json(
          { error: { code: 'session_not_active', message: 'session is not active' } },
          409,
        );
      }

      const now = clock();
      const charge = await chargeElapsedMinutes(
        client,
        userId,
        {
          id: session.id,
          startedAtMs: toDate(session.started_at).getTime(),
          chargedPaise: Number(session.charged_paise),
        },
        now.getTime(),
      );

      if (charge.exhausted) {
        await client.query(END_SESSION_SQL, [sessionId, userId, 'insufficient_funds']);
        await client.query('COMMIT');
        return c.json({
          active: false,
          reason: 'insufficient_funds',
          balance_paise: charge.balancePaise,
          charged_paise: charge.chargedPaise,
        });
      }

      await client.query('COMMIT');
      return c.json({
        active: true,
        balance_paise: charge.balancePaise,
        charged_paise: charge.chargedPaise,
        rate_per_minute_paise: RATE_PER_MINUTE_PAISE,
      });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback errors.
        }
      }
      throw err;
    } finally {
      if (client) {
        client.release();
      }
    }
  });

  /**
   * POST /sessions/:id/end
   *
   * Bills the final started minute, then ends the session (`ended_by_user`).
   */
  router.post('/sessions/:id/end', async (c) => {
    const authResult = await authenticateRequest(c);
    if (!(authResult && 'userId' in authResult)) {
      return authResult;
    }
    const { userId } = authResult;
    const sessionId = c.req.param('id');
    const clock = deps.now ?? (() => new Date());
    let client: PoolClient | undefined;

    try {
      client = await deps.pool.connect();
      await client.query('BEGIN');
      await client.query(ADVISORY_LOCK_SQL, [userId]);

      const findResult = await client.query<FindSessionRow>(FIND_SESSION_SQL, [sessionId]);
      const session = findResult.rows[0];
      if (!session || session.user_id !== userId) {
        await client.query('ROLLBACK');
        return c.json(
          { error: { code: 'session_not_found', message: 'session not found' } },
          404,
        );
      }
      if (session.status !== 'active') {
        await client.query('ROLLBACK');
        return c.json(
          { error: { code: 'session_not_active', message: 'session is not active' } },
          409,
        );
      }

      // Bill the final started minute before ending.
      const charge = await chargeElapsedMinutes(
        client,
        userId,
        {
          id: session.id,
          startedAtMs: toDate(session.started_at).getTime(),
          chargedPaise: Number(session.charged_paise),
        },
        clock().getTime(),
      );

      const updateResult = await client.query<{ ended_at: Date | string }>(
        END_SESSION_SQL,
        [sessionId, userId, 'ended_by_user'],
      );
      const updatedRow = updateResult.rows[0];
      if (!updatedRow) {
        await client.query('ROLLBACK');
        return c.json(
          { error: { code: 'session_not_active', message: 'session is not active' } },
          409,
        );
      }

      await client.query('COMMIT');
      return c.json({
        ok: true,
        session_id: sessionId,
        ended_at: toDate(updatedRow.ended_at).toISOString(),
        balance_paise: charge.balancePaise,
        charged_paise: charge.chargedPaise,
      });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback errors.
        }
      }
      throw err;
    } finally {
      if (client) {
        client.release();
      }
    }
  });

  return router;
}
