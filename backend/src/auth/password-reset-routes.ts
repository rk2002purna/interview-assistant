/**
 * Auth_Service password reset routes.
 *
 * This module exposes two endpoints for the password reset flow:
 *
 *   - POST /auth/password-reset/request   (Requirement 1.3)
 *   - POST /auth/password-reset/confirm   (Requirement 1.3)
 *
 * The request endpoint always returns `{sent: true}` regardless of
 * whether the email exists, to prevent email enumeration (same pattern
 * as resend-verification). The confirm endpoint validates the token,
 * checks expiry and used status, enforces password policy, updates the
 * user's password hash, and marks the token as used.
 *
 * Email "send" is a logging stub by default. The actual email delivery
 * integration is intentionally out of scope.
 *
 * Design references:
 *   - design.md "Auth_Service" table:
 *       * password-reset/request: generates 32-byte random token,
 *         stores SHA-256 hash in `password_resets` with 60-min TTL
 *       * password-reset/confirm: validates token, updates password
 */

import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash as hashPassword, validatePolicy } from './password.js';
import { Logger } from '../log/logger.js';

/** Password reset token TTL: 60 minutes. */
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Random byte length of a password reset token before base64url encoding. */
export const PASSWORD_RESET_TOKEN_BYTES = 32;

/** Stub-friendly delivery seam for password reset emails. */
export type PasswordResetEmailSender = (input: {
  readonly email: string;
  readonly token: string;
  readonly userId: string;
}) => Promise<void>;

export interface PasswordResetRoutesDeps {
  /** Postgres pool used for reads and writes. */
  readonly pool: Pool;
  /** Clock injection for tests; defaults to wall-clock UTC. */
  readonly now?: () => Date;
  /** Logger used for the email-send stub and unexpected failures. */
  readonly logger?: Logger;
  /**
   * Email delivery sink. The default sender logs the recipient at
   * `info` level. The token itself is never logged.
   */
  readonly sendPasswordResetEmail?: PasswordResetEmailSender;
  /** Override the random token byte length; primarily for tests. */
  readonly tokenBytes?: number;
}

/**
 * RFC 5322-shaped email with the operational max length pinned to 254
 * characters (R1.3).
 */
const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email();

const requestBody = z.object({
  email: emailSchema,
});

const confirmBody = z.object({
  token: z.string().min(1).max(1024),
  new_password: z.string().min(1).max(1024),
});

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

function err(code: string, message: string, details?: Readonly<Record<string, unknown>>): ErrorBody {
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

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // No active transaction or the connection is already torn down.
  }
}

/**
 * Build the password reset sub-router. Mount with
 * `app.route('/', buildPasswordResetRouter(deps))`.
 */
export function buildPasswordResetRouter(deps: PasswordResetRoutesDeps): Hono {
  const router = new Hono();
  const clock = deps.now ?? ((): Date => new Date());
  const tokenBytes = deps.tokenBytes ?? PASSWORD_RESET_TOKEN_BYTES;
  const logger = deps.logger ?? new Logger();
  const sendEmail: PasswordResetEmailSender =
    deps.sendPasswordResetEmail ??
    (async ({ email, userId }) => {
      logger.info('password_reset_email_stub_sent', { email, user_id: userId });
    });

  // -------------------------------------------------------------------------
  // POST /auth/password-reset/request
  //
  // Always returns {sent: true} to prevent email enumeration.
  // If the user exists, generates a 32-byte random token, stores its
  // SHA-256 hash in password_resets with a 60-minute TTL.
  // -------------------------------------------------------------------------
  router.post('/auth/password-reset/request', async (c) => {
    const raw = await readJson(c.req.raw);
    if (raw === null) {
      // Even for malformed JSON, return the success shape to avoid
      // leaking information about the endpoint's behavior.
      return c.json({ sent: true as const }, 200);
    }
    const parsed = requestBody.safeParse(raw);
    if (!parsed.success) {
      // Same as above: always return success shape.
      return c.json({ sent: true as const }, 200);
    }

    const email = parsed.data.email.toLowerCase();
    const now = clock();

    const client = await deps.pool.connect();
    try {
      const userResult = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(email) = $1`,
        [email],
      );

      const user = userResult.rows[0];
      if (!user) {
        // User doesn't exist; return success shape without doing anything.
        return c.json({ sent: true as const }, 200);
      }

      // Generate token and store hash.
      const tokenRaw = randomBytes(tokenBytes).toString('base64url');
      const tokenHash = sha256Hex(tokenRaw);
      const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

      await client.query('BEGIN');
      await client.query(
        `INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          randomUUID(),
          user.id,
          tokenHash,
          expiresAt.toISOString(),
          now.toISOString(),
        ],
      );
      await client.query('COMMIT');

      // Deliver the email (fire-and-forget; failure doesn't affect response).
      await deliverResetEmail(sendEmail, logger, {
        email,
        token: tokenRaw,
        userId: user.id,
      });

      return c.json({ sent: true as const }, 200);
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // POST /auth/password-reset/confirm
  //
  // Accepts {token, new_password}. Looks up by SHA-256 hash, verifies
  // not expired and not used, validates new password policy, updates
  // user's password_hash, marks token as used.
  // -------------------------------------------------------------------------
  router.post('/auth/password-reset/confirm', async (c) => {
    const raw = await readJson(c.req.raw);
    if (raw === null) {
      return c.json(err('invalid_json', 'request body must be JSON'), 400);
    }
    const parsed = confirmBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        err('invalid_input', 'token and new_password are required'),
        400,
      );
    }

    // Validate password policy before doing any DB work.
    const policy = validatePolicy(parsed.data.new_password);
    if (!policy.valid) {
      return c.json(err(policy.code, policy.message), 400);
    }

    const tokenHash = sha256Hex(parsed.data.token);
    const now = clock();

    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      const tokenRow = await client.query<{
        id: string;
        user_id: string;
        expires_at: Date | string;
        used_at: Date | string | null;
      }>(
        `SELECT id, user_id, expires_at, used_at
           FROM password_resets
          WHERE token_hash = $1`,
        [tokenHash],
      );

      const row = tokenRow.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return c.json(
          err('invalid_token', 'password reset token is invalid'),
          400,
        );
      }

      if (row.used_at !== null) {
        await client.query('ROLLBACK');
        return c.json(
          err('invalid_token', 'password reset token is invalid'),
          400,
        );
      }

      const expiresAt = toDate(row.expires_at);
      if (expiresAt.getTime() <= now.getTime()) {
        await client.query('ROLLBACK');
        return c.json(
          err('token_expired', 'password reset token has expired'),
          400,
        );
      }

      // Hash the new password.
      const newPasswordHash = await hashPassword(parsed.data.new_password);

      // Update the user's password.
      await client.query(
        `UPDATE users SET password_hash = $1 WHERE id = $2`,
        [newPasswordHash, row.user_id],
      );

      // Mark the token as used.
      await client.query(
        `UPDATE password_resets SET used_at = $1 WHERE id = $2`,
        [now.toISOString(), row.id],
      );

      await client.query('COMMIT');

      return c.json({ reset: true as const }, 200);
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
  });

  return router;
}

async function deliverResetEmail(
  send: PasswordResetEmailSender,
  logger: Logger,
  input: { readonly email: string; readonly token: string; readonly userId: string },
): Promise<void> {
  try {
    await send(input);
  } catch (err) {
    // A failed email send must never affect the response. Log the
    // failure so operators can see the delivery problem.
    logger.warn('password_reset_email_send_failed', {
      user_id: input.userId,
      email: input.email,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
