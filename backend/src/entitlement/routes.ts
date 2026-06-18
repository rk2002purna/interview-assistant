/**
 * Entitlement HTTP routes.
 *
 * Exposes `GET /me/entitlement` per Requirement 6.4: serves the
 * authenticated user's current entitlement (remaining session_count and
 * lifetime_flag) by reading the latest `entitlement_ledger` row's
 * `resulting_*` columns.
 *
 * The query uses the existing `(user_id, ts DESC)` index so it
 * completes in O(1) regardless of ledger length, satisfying the
 * "within 1 second of commit" latency obligation.
 *
 * Authentication is performed inline via `verifyAccess` following the
 * same pattern as other routers (`src/packs/routes.ts`). Once the
 * global middleware chain is wired application-wide, this inline check
 * will be replaced by reading `c.get('userId')` from the context.
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { JwtError, verifyAccess } from '../auth/jwt.js';

export interface EntitlementRouterDeps {
  /** Postgres pool for read queries. */
  readonly pool: Pool;
}

/**
 * SQL that reads the most recent ledger row for a user. The
 * `resulting_*` columns on that row represent the canonical current
 * entitlement after all committed entries. Uses the
 * `entitlement_ledger_user_ts_idx` index for an efficient single-row
 * lookup.
 */
const LATEST_ENTITLEMENT_SQL = `
  SELECT resulting_session_count, resulting_lifetime_flag
    FROM entitlement_ledger
   WHERE user_id = $1
   ORDER BY ts DESC, id DESC
   LIMIT 1
`;

interface EntitlementRow {
  resulting_session_count: number | string;
  resulting_lifetime_flag: boolean;
}

/**
 * Build a Hono sub-app exposing entitlement routes. The returned router
 * is intended to be mounted at the root of the main app.
 */
export function buildEntitlementRouter(deps: EntitlementRouterDeps): Hono {
  const router = new Hono();

  router.get('/me/entitlement', async (c) => {
    // Inline JWT verification (same pattern as src/packs/routes.ts).
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

    let userId: string;
    try {
      const claims = await verifyAccess(match[1]!);
      userId = claims.sub;
    } catch (err) {
      const code = err instanceof JwtError ? err.code : 'unauthenticated';
      const message = err instanceof Error ? err.message : 'invalid token';
      return c.json({ error: { code, message } }, 401);
    }

    const result = await deps.pool.query<EntitlementRow>(
      LATEST_ENTITLEMENT_SQL,
      [userId],
    );

    const row = result.rows[0];
    if (!row) {
      // No ledger entries exist for this user yet.
      return c.json({ session_count: 0, lifetime_flag: false });
    }

    return c.json({
      session_count: Number(row.resulting_session_count),
      lifetime_flag: row.resulting_lifetime_flag === true,
    });
  });

  return router;
}
