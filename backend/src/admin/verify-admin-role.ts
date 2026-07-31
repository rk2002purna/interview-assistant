/**
 * Shared admin role re-verification (finding F3).
 *
 * Every admin route authenticates by verifying the access token's signature
 * and reading its `role` claim. That claim is baked into the JWT when the
 * token is minted and does not change for the token's ~60-minute lifetime, so
 * a user who was an admin at sign-in keeps a token that still says
 * `role: "admin"` even after an operator demotes them in the database. Until
 * the token expires, that stale claim alone would keep authorizing wallet
 * adjustments, provider-key rotation, role changes, and configuration edits.
 *
 * `isCurrentAdmin` closes that window by confirming, on every privileged
 * request, that the user row still carries `role = 'admin'`. The token check
 * still runs first (authentication + shape); this is the authorization
 * freshness check layered on top.
 */

import type { Pool } from 'pg';

/**
 * Return true only if the user identified by `userId` currently has the
 * `admin` role in the database. Any other outcome — the row is missing, the
 * role has been changed, or the lookup fails — returns false so the caller
 * denies access with its standard forbidden envelope.
 *
 * A lookup error is treated as "not currently an admin" rather than being
 * thrown, so a transient database problem fails closed (denies the privileged
 * action) instead of surfacing a 500 that leaks that the account exists.
 */
export async function isCurrentAdmin(
  pool: Pool,
  userId: string,
): Promise<boolean> {
  try {
    const result = await pool.query<{ role: string }>(
      `SELECT role FROM users WHERE id = $1`,
      [userId],
    );
    return result.rows[0]?.role === 'admin';
  } catch {
    return false;
  }
}
