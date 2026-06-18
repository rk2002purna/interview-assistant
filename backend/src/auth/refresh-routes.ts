/**
 * Auth_Service refresh and logout routes.
 *
 * This module exposes:
 *
 *   - POST /auth/refresh   (Requirements 1.6, 1.10, 13.5)
 *   - POST /auth/logout    (Requirement 1.7)
 *
 * Refresh tokens are opaque random strings stored hashed (SHA-256) in
 * the `refresh_tokens` table. Each row is bound to a `client_id` at
 * issuance time. On refresh:
 *
 *   1. Look up the token by its SHA-256 hash.
 *   2. Reject if revoked, expired, or if the `client_id` on the row
 *      does not match the `X-Client-Id` header on the request.
 *   3. On any rejection: revoke the token row (set `revoked_at`),
 *      write an audit_log row, and return 401.
 *   4. On success: issue a new access token and return it.
 *
 * Logout simply revokes the refresh token row and returns `{ok: true}`.
 *
 * Design references:
 *   - design.md Auth_Service table: POST /auth/refresh, POST /auth/logout
 *   - Requirement 1.6: silent refresh when refresh token is valid
 *   - Requirement 1.7: logout revokes refresh token
 *   - Requirement 1.10: expired/revoked/rejected refresh -> clear tokens
 *   - Requirement 13.5: client_id binding and mismatch detection
 */

import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { signAccessToken } from './jwt.js';
import { writeAudit } from '../log/audit.js';

/** Refresh token TTL: 30 days in milliseconds. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface RefreshRoutesDeps {
  /** Postgres pool for reading/writing refresh_tokens and audit_log. */
  readonly pool: Pool;
  /** Clock injection for tests; defaults to wall-clock UTC. */
  readonly now?: () => Date;
}

const refreshBody = z.object({
  refresh_token: z.string().min(1).max(2048),
});

const logoutBody = z.object({
  refresh_token: z.string().min(1).max(2048),
});

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

function err(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ErrorBody {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}

async function readJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Connection already torn down or no active transaction.
  }
}

/**
 * Build the auth refresh/logout sub-router. Mount with
 * `app.route('/', buildAuthRefreshRouter(deps))`.
 */
export function buildAuthRefreshRouter(deps: RefreshRoutesDeps): Hono {
  const router = new Hono();
  const clock = deps.now ?? ((): Date => new Date());

  // -------------------------------------------------------------------------
  // POST /auth/refresh
  // -------------------------------------------------------------------------
  router.post('/auth/refresh', async (c) => {
    const raw = await readJson(c.req.raw);
    if (raw === null) {
      return c.json(err('invalid_json', 'request body must be JSON'), 400);
    }
    const parsed = refreshBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        err('invalid_input', 'refresh_token is required'),
        400,
      );
    }

    const clientId = c.req.header('X-Client-Id') ?? '';
    const tokenHash = sha256Hex(parsed.data.refresh_token);
    const now = clock();

    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      const tokenRow = await client.query<{
        id: string;
        user_id: string;
        client_id: string;
        expires_at: Date | string;
        revoked_at: Date | string | null;
      }>(
        `SELECT id, user_id, client_id, expires_at, revoked_at
           FROM refresh_tokens
          WHERE token_hash = $1`,
        [tokenHash],
      );

      const row = tokenRow.rows[0];

      // Token not found — return generic 401 without audit (no row to revoke).
      if (!row) {
        await client.query('ROLLBACK');
        return c.json(
          err('invalid_refresh_token', 'refresh token is invalid'),
          401,
        );
      }

      const expiresAt =
        row.expires_at instanceof Date
          ? row.expires_at
          : new Date(row.expires_at);

      // Determine rejection reason (if any).
      let rejectionReason: string | null = null;
      if (row.revoked_at !== null) {
        rejectionReason = 'token_revoked';
      } else if (expiresAt.getTime() <= now.getTime()) {
        rejectionReason = 'token_expired';
      } else if (row.client_id !== clientId) {
        rejectionReason = 'client_id_mismatch';
      }

      if (rejectionReason !== null) {
        // Revoke the token (idempotent if already revoked).
        if (row.revoked_at === null) {
          await client.query(
            `UPDATE refresh_tokens SET revoked_at = $1 WHERE id = $2`,
            [now.toISOString(), row.id],
          );
        }

        // Write audit row documenting the rejection.
        await writeAudit(client, {
          actor: { userId: row.user_id },
          target: { userId: row.user_id, resource: `refresh_token:${row.id}` },
          eventType: 'refresh_token_rejected',
          outcome: 'failure',
          reasonCode: rejectionReason,
          metadata: {
            presenting_client_id: clientId,
            issuing_client_id: row.client_id,
          },
        });

        await client.query('COMMIT');
        return c.json(
          err('invalid_refresh_token', 'refresh token is invalid'),
          401,
        );
      }

      // Token is valid — look up the user's role, email, and display name.
      const userRow = await client.query<{ role: string; email: string; display_name: string | null }>(
        `SELECT role, email, display_name FROM users WHERE id = $1`,
        [row.user_id],
      );

      if (userRow.rows.length === 0) {
        // User was deleted between token issuance and now. Revoke.
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = $1 WHERE id = $2`,
          [now.toISOString(), row.id],
        );
        await client.query('COMMIT');
        return c.json(
          err('invalid_refresh_token', 'refresh token is invalid'),
          401,
        );
      }

      await client.query('COMMIT');

      const role = userRow.rows[0]!.role as 'user' | 'admin';
      const email = userRow.rows[0]!.email;
      const displayName = userRow.rows[0]!.display_name;
      const signed = await signAccessToken({
        sub: row.user_id,
        role,
        clientId: row.client_id,
        email,
        displayName,
      });

      return c.json(
        {
          access_token: signed.token,
          expires_in: signed.expiresIn,
        },
        200,
      );
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // POST /auth/logout
  // -------------------------------------------------------------------------
  router.post('/auth/logout', async (c) => {
    const raw = await readJson(c.req.raw);
    if (raw === null) {
      return c.json(err('invalid_json', 'request body must be JSON'), 400);
    }
    const parsed = logoutBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        err('invalid_input', 'refresh_token is required'),
        400,
      );
    }

    const tokenHash = sha256Hex(parsed.data.refresh_token);
    const now = clock();

    const client = await deps.pool.connect();
    try {
      // Revoke the token row. If it doesn't exist or is already revoked,
      // we still return {ok: true} to avoid leaking token existence.
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = $1
          WHERE token_hash = $2 AND revoked_at IS NULL`,
        [now.toISOString(), tokenHash],
      );

      return c.json({ ok: true as const }, 200);
    } finally {
      client.release();
    }
  });

  return router;
}
