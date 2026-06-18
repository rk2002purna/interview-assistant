/**
 * Session HTTP routes.
 *
 * Exposes session lifecycle endpoints:
 *   - `POST /sessions/start` per Requirements 8.1, 8.2, 8.3: starts a new
 *     interview session by acquiring a per-user advisory lock, checking
 *     entitlement, inserting a ledger entry, and creating the session row.
 *   - `GET /me/session/active` per Requirement 8.7: returns the
 *     authenticated user's current active Interview Session including
 *     session_id, started_at, expires_at, and remaining_seconds, or
 *     HTTP 404 with error code `no_active_session` if no session is
 *     active.
 *   - `POST /sessions/:id/end` per Requirement 8.6: allows an authenticated
 *     user to end their own active interview session. Verifies ownership and
 *     active status, then transitions the session to `ended` with
 *     `ended_reason='ended_by_user'`. No refund is issued.
 *
 * Authentication is performed inline via `verifyAccess` following the
 * same pattern as other routers (e.g. `src/entitlement/routes.ts`).
 */

import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import { appendLedgerEntry, LedgerError } from '../entitlement/ledger.js';

export interface SessionsRouterDeps {
  /** Postgres pool for read/write queries. */
  readonly pool: Pool;
  /** Clock injection used by tests. Defaults to wall clock. */
  readonly now?: () => Date;
}

/** Row shape returned by the session lookup query. */
interface SessionRow {
  id: string;
  user_id: string;
  status: string;
}

/** Row shape returned by the update query. */
interface UpdatedSessionRow {
  ended_at: Date | string;
}

/** Duration of a trial session in milliseconds (10 minutes). */
const TRIAL_SESSION_DURATION_MS = 10 * 60 * 1000;
/** Duration of a paid session in milliseconds (90 minutes). */
const PAID_SESSION_DURATION_MS = 90 * 60 * 1000;
/** Number of free trial sessions granted at signup. */
const TRIAL_SESSION_COUNT = 3;

/**
 * Advisory lock keyed on the user_id. Uses the same hashing approach as
 * the ledger module to serialize per-user operations within the
 * transaction.
 */
const ADVISORY_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(('x' || left(md5($1::text), 15))::bit(64)::bigint)";

/**
 * SQL that retrieves the active session for a user. Uses the partial
 * unique index `one_active_session_per_user` for an efficient lookup.
 */
const ACTIVE_SESSION_SQL = `
  SELECT id, started_at, expires_at
    FROM interview_sessions
   WHERE user_id = $1
     AND status = 'active'
   LIMIT 1
`;

/**
 * Read the latest entitlement state for the user.
 */
const LATEST_ENTITLEMENT_SQL = `
  SELECT resulting_session_count, resulting_lifetime_flag
    FROM entitlement_ledger
   WHERE user_id = $1
   ORDER BY ts DESC, id DESC
   LIMIT 1
`;

/**
 * Insert a new interview session row.
 */
const INSERT_SESSION_SQL = `
  INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at)
  VALUES ($1, $2, 'active', $3, $4)
  RETURNING id, started_at, expires_at
`;

interface ActiveSessionRow {
  id: string;
  started_at: Date;
  expires_at: Date;
}

interface EntitlementRow {
  resulting_session_count: number | string;
  resulting_lifetime_flag: boolean;
}

interface InsertedSessionRow {
  id: string;
  started_at: Date | string;
  expires_at: Date | string;
}

const FIND_SESSION_SQL = `
  SELECT id, user_id, status
    FROM interview_sessions
   WHERE id = $1
`;

const END_SESSION_SQL = `
  UPDATE interview_sessions
     SET status = 'ended',
         ended_at = NOW(),
         ended_reason = 'ended_by_user'
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
 * Build a Hono sub-app exposing session routes. The returned router is
 * intended to be mounted at the root of the main app.
 */
export function buildSessionsRouter(deps: SessionsRouterDeps): Hono {
  const router = new Hono();

  /**
   * POST /sessions/start
   *
   * Requirements 8.1, 8.2, 8.3: Start a new interview session.
   * Single transaction: advisory lock → entitlement check → ledger insert
   * (session_start, delta -1 or 0 for lifetime) → interview_sessions insert
   * (status='active', expires_at=started_at+90min).
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

      // 1. Acquire per-user advisory lock
      await client.query(ADVISORY_LOCK_SQL, [userId]);

      // 2. Check for existing active session → 409
      const activeResult = await client.query<ActiveSessionRow>(
        ACTIVE_SESSION_SQL,
        [userId],
      );
      const activeRow = activeResult.rows[0];
      if (activeRow) {
        await client.query('ROLLBACK');
        const expiresAt =
          activeRow.expires_at instanceof Date
            ? activeRow.expires_at
            : new Date(String(activeRow.expires_at));
        return c.json(
          {
            error: {
              code: 'session_already_active',
              details: {
                active_session_id: activeRow.id,
                expires_at: expiresAt.toISOString(),
              },
            },
          },
          409,
        );
      }

      // 3. Check entitlement
      const entitlementResult = await client.query<EntitlementRow>(
        LATEST_ENTITLEMENT_SQL,
        [userId],
      );
      const entitlementRow = entitlementResult.rows[0];
      const sessionCount = entitlementRow
        ? Number(entitlementRow.resulting_session_count)
        : 0;
      const lifetimeFlag = entitlementRow
        ? entitlementRow.resulting_lifetime_flag === true
        : false;

      if (sessionCount <= 0 && !lifetimeFlag) {
        await client.query('ROLLBACK');
        return c.json(
          { error: { code: 'no_sessions_remaining' } },
          402,
        );
      }

      // 4. Determine trial vs paid — first TRIAL_SESSION_COUNT sessions are 10 min
      const sessionCountResult = await client.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM interview_sessions WHERE user_id = $1`,
        [userId],
      );
      const sessionsStarted = Number(sessionCountResult.rows[0]?.count ?? 0);
      const isTrial = sessionsStarted < TRIAL_SESSION_COUNT;
      const durationMs = isTrial ? TRIAL_SESSION_DURATION_MS : PAID_SESSION_DURATION_MS;

      // 5. Prepare session row
      const sessionId = randomUUID();
      const startedAt = clock();
      const expiresAt = new Date(startedAt.getTime() + durationMs);

      // 6. Insert interview_sessions row FIRST (ledger has FK to it)
      const insertResult = await client.query<InsertedSessionRow>(
        INSERT_SESSION_SQL,
        [sessionId, userId, startedAt.toISOString(), expiresAt.toISOString()],
      );

      // 7. Insert ledger entry (session_start)
      const sessionDelta = lifetimeFlag ? 0 : -1;
      await appendLedgerEntry(client, {
        userId,
        sessionDelta,
        lifetimeFlagSet: 'unchanged',
        reason: 'session_start',
        interviewSessionId: sessionId,
      });

      await client.query('COMMIT');

      const inserted = insertResult.rows[0]!;
      const responseStartedAt =
        inserted.started_at instanceof Date
          ? inserted.started_at
          : new Date(String(inserted.started_at));
      const responseExpiresAt =
        inserted.expires_at instanceof Date
          ? inserted.expires_at
          : new Date(String(inserted.expires_at));

      return c.json(
        {
          session_id: inserted.id,
          started_at: responseStartedAt.toISOString(),
          expires_at: responseExpiresAt.toISOString(),
          is_trial: isTrial,
          duration_seconds: Math.floor(durationMs / 1000),
        },
        201,
      );
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback errors
        }
      }

      if (err instanceof LedgerError) {
        if (err.code === 'no_sessions_remaining') {
          return c.json(
            { error: { code: 'no_sessions_remaining' } },
            402,
          );
        }
        return c.json(
          { error: { code: 'internal_error', message: 'ledger operation failed' } },
          500,
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
   * Requirement 8.7: Returns the caller's active interview session with
   * remaining time, or 404 if no session is active.
   */
  router.get('/me/session/active', async (c) => {
    const authResult = await authenticateRequest(c);
    if (!(authResult && 'userId' in authResult)) {
      return authResult;
    }
    const { userId } = authResult;

    const result = await deps.pool.query<ActiveSessionRow>(
      ACTIVE_SESSION_SQL,
      [userId],
    );

    const row = result.rows[0];
    if (!row) {
      return c.json(
        { error: { code: 'no_active_session', message: 'no active interview session' } },
        404,
      );
    }

    const now = deps.now ? deps.now() : new Date();
    const remainingMs = new Date(row.expires_at).getTime() - now.getTime();
    const remaining_seconds = Math.max(0, Math.floor(remainingMs / 1000));

    // Determine if this is a trial session (first 3 sessions are 10-min trials)
    const countResult = await deps.pool.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM interview_sessions WHERE user_id = $1 AND id != $2`,
      [userId, row.id],
    );
    const priorCount = Number(countResult.rows[0]?.count ?? 0);
    const isTrial = priorCount < TRIAL_SESSION_COUNT;

    return c.json({
      session_id: row.id,
      started_at: new Date(row.started_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      remaining_seconds,
      is_trial: isTrial,
    });
  });

  /**
   * POST /sessions/:id/end
   *
   * Requirement 8.6: End an active interview session owned by the caller.
   * - Verifies caller owns session and status is `active`
   * - Writes `ended_at` and `ended_reason='ended_by_user'`
   * - No refund is issued
   */
  router.post('/sessions/:id/end', async (c) => {
    // Inline JWT verification.
    const authResult = await authenticateRequest(c);
    if (!(authResult && 'userId' in authResult)) {
      return authResult;
    }
    const { userId } = authResult;

    const sessionId = c.req.param('id');

    // Look up the session by id.
    const findResult = await deps.pool.query<SessionRow>(FIND_SESSION_SQL, [sessionId]);
    const session = findResult.rows[0];

    // If session doesn't exist or doesn't belong to the caller → 404.
    if (!session || session.user_id !== userId) {
      return c.json(
        { error: { code: 'session_not_found', message: 'session not found' } },
        404,
      );
    }

    // If session status is not 'active' → 409.
    if (session.status !== 'active') {
      return c.json(
        { error: { code: 'session_not_active', message: 'session is not active' } },
        409,
      );
    }

    // Update the session: status='ended', ended_at=now(), ended_reason='ended_by_user'.
    const updateResult = await deps.pool.query<UpdatedSessionRow>(END_SESSION_SQL, [
      sessionId,
      userId,
    ]);

    const updatedRow = updateResult.rows[0];
    if (!updatedRow) {
      // Race condition: session was ended/expired between the SELECT and UPDATE.
      return c.json(
        { error: { code: 'session_not_active', message: 'session is not active' } },
        409,
      );
    }

    const endedAt =
      updatedRow.ended_at instanceof Date
        ? updatedRow.ended_at.toISOString()
        : String(updatedRow.ended_at);

    return c.json({ ok: true, session_id: sessionId, ended_at: endedAt });
  });

  /**
   * POST /sessions/:id/extend
   *
   * Extend a paid session by 90 minutes by consuming one session credit.
   * Trial sessions cannot be extended. The user must have at least one
   * remaining session credit. Runs in a single transaction: advisory lock
   * → entitlement check → ledger deduct → extend expires_at.
   */
  router.post('/sessions/:id/extend', async (c) => {
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

      // Verify session is active and belongs to user
      const findResult = await client.query<SessionRow>(FIND_SESSION_SQL, [sessionId]);
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

      // Count prior sessions — trial sessions (first 3) cannot be extended
      const countResult = await client.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM interview_sessions
          WHERE user_id = $1 AND id != $2`,
        [userId, sessionId],
      );
      const priorCount = Number(countResult.rows[0]?.count ?? 0);
      if (priorCount < TRIAL_SESSION_COUNT) {
        await client.query('ROLLBACK');
        return c.json(
          { error: { code: 'trial_session_not_extendable', message: 'trial sessions cannot be extended' } },
          400,
        );
      }

      // Check entitlement
      const entitlementResult = await client.query<EntitlementRow>(
        LATEST_ENTITLEMENT_SQL,
        [userId],
      );
      const entitlementRow = entitlementResult.rows[0];
      const sessionCount = entitlementRow ? Number(entitlementRow.resulting_session_count) : 0;
      const lifetimeFlag = entitlementRow ? entitlementRow.resulting_lifetime_flag === true : false;

      if (sessionCount <= 0 && !lifetimeFlag) {
        await client.query('ROLLBACK');
        return c.json(
          { error: { code: 'no_sessions_remaining', message: 'no sessions remaining to extend' } },
          402,
        );
      }

      // Deduct one session and extend the session
      const newExpiresAt = new Date(clock().getTime() + PAID_SESSION_DURATION_MS);

      await client.query(
        `UPDATE interview_sessions
            SET expires_at = $1
          WHERE id = $2`,
        [newExpiresAt.toISOString(), sessionId],
      );

      const sessionDelta = lifetimeFlag ? 0 : -1;
      await appendLedgerEntry(client, {
        userId,
        sessionDelta,
        lifetimeFlagSet: 'unchanged',
        reason: 'session_start',
        interviewSessionId: sessionId,
        note: 'session extended by 90 min',
      });

      await client.query('COMMIT');

      return c.json({
        session_id: sessionId,
        expires_at: newExpiresAt.toISOString(),
        duration_seconds: Math.floor(PAID_SESSION_DURATION_MS / 1000),
      }, 200);
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      if (err instanceof LedgerError && err.code === 'no_sessions_remaining') {
        return c.json(
          { error: { code: 'no_sessions_remaining' } },
          402,
        );
      }
      throw err;
    } finally {
      if (client) client.release();
    }
  });

  return router;
}
