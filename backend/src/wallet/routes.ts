/**
 * Wallet HTTP routes.
 *
 *   GET /me/wallet — the authenticated user's current wallet balance plus the
 *                    per-minute rate, so clients can show balance and estimate
 *                    remaining interview minutes.
 *
 * Authentication is performed inline via `verifyAccess`, matching the pattern
 * used by the entitlement and session routers.
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import { getWalletBalancePaise, RATE_PER_MINUTE_PAISE } from './ledger.js';

export interface WalletRouterDeps {
  /** Postgres pool for read queries. */
  readonly pool: Pool;
}

/**
 * Extract and verify the JWT from the Authorization header.
 * Returns the user id on success, or a JSON error response on failure.
 */
async function authenticate(c: any): Promise<{ userId: string } | Response> {
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
 * Build a Hono sub-app exposing wallet routes. Mount at the root of the app.
 */
export function buildWalletRouter(deps: WalletRouterDeps): Hono {
  const router = new Hono();

  router.get('/me/wallet', async (c) => {
    const auth = await authenticate(c);
    if (!(auth && 'userId' in auth)) {
      return auth;
    }

    const balancePaise = await getWalletBalancePaise(deps.pool, auth.userId);
    const estimatedMinutes = Math.floor(balancePaise / RATE_PER_MINUTE_PAISE);

    return c.json({
      balance_paise: balancePaise,
      rate_per_minute_paise: RATE_PER_MINUTE_PAISE,
      estimated_minutes_remaining: estimatedMinutes,
    });
  });

  // GET /me/profile — the authenticated user's identity, read from the users
  // table rather than decoded from the token. Clients (notably the desktop app)
  // must not trust email/role/display_name decoded locally from an access token,
  // because the token's signature is only checked server-side; a token pushed in
  // over the interview-assistant:// callback could carry attacker-chosen claims
  // (finding F12). The JWT is signature-verified in `authenticate`, then the
  // canonical fields are served from the row keyed by its subject.
  router.get('/me/profile', async (c) => {
    const auth = await authenticate(c);
    if (!(auth && 'userId' in auth)) {
      return auth;
    }

    const result = await deps.pool.query<{
      email: string;
      role: string;
      display_name: string | null;
    }>(`SELECT email, role, display_name FROM users WHERE id = $1`, [auth.userId]);

    const row = result.rows[0];
    if (!row) {
      return c.json(
        { error: { code: 'not_found', message: 'user not found' } },
        404,
      );
    }

    return c.json({
      email: row.email,
      role: row.role,
      display_name: row.display_name,
    });
  });

  return router;
}
