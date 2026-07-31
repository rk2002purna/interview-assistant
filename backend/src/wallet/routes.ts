/**
 * Wallet HTTP routes.
 *
 *   GET  /me/wallet — the authenticated user's current wallet balance plus the
 *                     per-minute rate, so clients can show balance and estimate
 *                     remaining interview minutes.
 *   GET  /me/profile — the authenticated user's identity (email, role,
 *                     display_name), read from the users table rather than
 *                     decoded from the access token (finding F12).
 *   POST /me/welcome-credit-notice/claim — reserves the new-user credit banner
 *                     for one client with replay protection.
 *   POST /me/welcome-credit-notice/acknowledge — marks a rendered reservation
 *                     as delivered so it cannot be shown again.
 *
 * Authentication is performed inline via `verifyAccess`, matching the pattern
 * used by the entitlement and session routers.
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import { getWalletBalancePaise, RATE_PER_MINUTE_PAISE, SIGNUP_BONUS_PAISE } from './ledger.js';

export interface WalletRouterDeps {
  /** Postgres pool for read queries. */
  readonly pool: Pool;
}

const WelcomeCreditTokenBody = z.object({
  claim_token: z.string().uuid(),
}).strict();

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

  /**
   * Reserves the one-time welcome-credit notice for a client nonce.
   *
   * A reservation is replayable by the same nonce if the response is lost.
   * Other clients can take over only after the lease expires, while the ledger
   * predicate prevents notices for accounts without the canonical bonus.
   */
  router.post('/me/welcome-credit-notice/claim', async (c) => {
    const auth = await authenticate(c);
    if (!(auth && 'userId' in auth)) {
      return auth;
    }

    const parsed = WelcomeCreditTokenBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: { code: 'invalid_request', message: 'claim_token must be a valid UUID' } },
        400,
      );
    }

    const result = await deps.pool.query<{ id: string }>(
      `UPDATE users AS u
       SET welcome_credit_notice_reservation_token = $2::uuid,
           welcome_credit_notice_reserved_at = now()
       WHERE u.id = $1
         AND u.welcome_credit_notice_claimed_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM wallet_ledger AS wl
           WHERE wl.user_id = u.id
             AND wl.reason = 'signup_bonus'
             AND wl.amount_paise = $3
         )
         AND (
           u.welcome_credit_notice_reservation_token IS NULL
           OR u.welcome_credit_notice_reservation_token = $2::uuid
           OR u.welcome_credit_notice_reserved_at IS NULL
           OR u.welcome_credit_notice_reserved_at < now() - interval '10 minutes'
         )
       RETURNING u.id`,
      [auth.userId, parsed.data.claim_token, SIGNUP_BONUS_PAISE],
    );

    return c.json({
      show_banner: result.rowCount === 1,
      amount_paise: SIGNUP_BONUS_PAISE,
    });
  });

  /** Marks a rendered reservation as delivered. */
  router.post('/me/welcome-credit-notice/acknowledge', async (c) => {
    const auth = await authenticate(c);
    if (!(auth && 'userId' in auth)) {
      return auth;
    }

    const parsed = WelcomeCreditTokenBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: { code: 'invalid_request', message: 'claim_token must be a valid UUID' } },
        400,
      );
    }

    const result = await deps.pool.query<{ id: string }>(
      `UPDATE users
       SET welcome_credit_notice_claimed_at = COALESCE(welcome_credit_notice_claimed_at, now())
       WHERE id = $1
         AND welcome_credit_notice_reservation_token = $2::uuid
       RETURNING id`,
      [auth.userId, parsed.data.claim_token],
    );

    return c.json({ acknowledged: result.rowCount === 1 });
  });

  return router;
}