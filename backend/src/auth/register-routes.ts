/**
 * Auth_Service registration routes.
 *
 * This module exposes the three endpoints involved in account creation
 * and email verification:
 *
 *   - POST /auth/register             (Requirements 1.3, 1.9)
 *   - POST /auth/verify-email         (Requirement 1.3, 1.4)
 *   - POST /auth/resend-verification  (Requirement 1.3)
 *
 * The router lives in a dedicated file (separate from login, refresh,
 * password reset) so that other auth tasks running in parallel can
 * land their own routers without merge conflicts. `app.ts` mounts
 * each router at the root.
 *
 * Email "send" is a logging stub by default. The actual email
 * delivery integration is intentionally out of scope; the stub keeps
 * the registration flow end-to-end testable and allows tests to
 * substitute a recording sender.
 *
 * Design references:
 *   - design.md "Auth_Service" table:
 *       * register: `{user_id, status:'pending_verification'}`,
 *         password hashed with Argon2id (already enforced by
 *         `src/auth/password.ts`)
 *       * verify-email: token is a random 32-byte URL-safe string
 *         with a 24-hour TTL
 *       * resend-verification: rate-limited to 3 per hour per email
 *   - design.md "Property 18 / Email enumeration prevention":
 *     duplicate-registration responses are byte-equal regardless of
 *     the existing account's `email_verified_at` state
 */

import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendLedgerEntry } from '../entitlement/ledger.js';
import {
  PasswordPolicyError,
  hash as hashPassword,
  validatePolicy,
} from './password.js';
import { Logger } from '../log/logger.js';

/** Verification token TTL per the design (Auth_Service section). */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Rolling window over which {@link RESEND_RATE_LIMIT_COUNT} resends are allowed. */
export const RESEND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
/** Maximum verification emails per email per rolling hour. */
export const RESEND_RATE_LIMIT_COUNT = 3;
/** Random byte length of a verification token before base64url encoding. */
export const VERIFICATION_TOKEN_BYTES = 32;

/** Stub-friendly delivery seam for verification emails. */
export type VerificationEmailSender = (input: {
  readonly email: string;
  readonly token: string;
  readonly userId: string;
}) => Promise<void>;

export interface RegisterRoutesDeps {
  /** Postgres pool used for the small set of writes performed here. */
  readonly pool: Pool;
  /** Clock injection for tests; defaults to wall-clock UTC. */
  readonly now?: () => Date;
  /** Logger used for the email-send stub and unexpected failures. */
  readonly logger?: Logger;
  /**
   * Email delivery sink. The default sender logs the recipient at
   * `info` (the token itself never appears in logs because the
   * structured logger redacts known secret keys; we additionally pass
   * the token under a redacted-by-name field).
   */
  readonly sendVerificationEmail?: VerificationEmailSender;
  /** Override the random token byte length; primarily for tests. */
  readonly tokenBytes?: number;
}

/**
 * RFC 5322-shaped email with the operational max length pinned to 254
 * characters (R1.3). Zod's `.email()` is a pragmatic regex; the
 * database CHECK in migration 0001 acts as a defense-in-depth backstop.
 */
const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email();

const registerBody = z.object({
  email: emailSchema,
  // Password policy enforcement happens via `validatePolicy` below so
  // we can return its specific error code in the response body.
  password: z.string().min(1).max(1024),
  display_name: z.string().trim().min(1).max(100).optional(),
});

const verifyEmailBody = z.object({
  token: z.string().min(1).max(1024),
});

const resendBody = z.object({
  email: emailSchema,
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

/**
 * Build the auth registration sub-router. Mount with
 * `app.route('/', buildAuthRegisterRouter(deps))`.
 */
export function buildAuthRegisterRouter(deps: RegisterRoutesDeps): Hono {
  const router = new Hono();
  const clock = deps.now ?? ((): Date => new Date());
  const tokenBytes = deps.tokenBytes ?? VERIFICATION_TOKEN_BYTES;
  const logger = deps.logger ?? new Logger();
  const sendEmail: VerificationEmailSender =
    deps.sendVerificationEmail ??
    (async ({ email, userId }) => {
      // The token itself is intentionally NOT included on the structured
      // log call. Verification tokens are bearer credentials; even if
      // the redaction layer would catch a known field name, the safer
      // default is simply not to pass them.
      logger.info('verification_email_stub_sent', { email, user_id: userId });
    });

  router.post('/auth/register', async (c) => {
    const raw = await readJson(c.req.raw);
    if (raw === null) {
      return c.json(err('invalid_json', 'request body must be JSON'), 400);
    }
    const parsed = registerBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        err('invalid_input', 'email or password is missing or malformed'),
        400,
      );
    }

    const policy = validatePolicy(parsed.data.password);
    if (!policy.valid) {
      return c.json(err(policy.code, policy.message), 400);
    }

    // citext columns compare case-insensitively; lower-casing here
    // gives us the same canonical form for environments (pg-mem in
    // tests) that don't have citext.
    const email = parsed.data.email.toLowerCase();

    let passwordHash: string;
    try {
      passwordHash = await hashPassword(parsed.data.password);
    } catch (e) {
      // `validatePolicy` ran above so this branch is essentially
      // unreachable, but a defensive `PasswordPolicyError` mapping
      // keeps us safe if Argon2 itself rejects an exotic input.
      if (e instanceof PasswordPolicyError) {
        return c.json(err(e.code, e.message), 400);
      }
      throw e;
    }

    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(email) = $1`,
        [email],
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        // Requirement 1.9: 409, identical body regardless of whether
        // the existing account is email_verified. Property 18 covers
        // the byte-equal obligation; emitting the same envelope here
        // (no metadata that could leak verification state) satisfies
        // it without depending on response post-processing.
        return c.json(
          err('email_already_registered', 'this email cannot be used'),
          409,
        );
      }

      const userId = randomUUID();
      await client.query(
        `INSERT INTO users (id, email, password_hash, role, display_name)
         VALUES ($1, $2, $3, 'user', $4)`,
        [userId, email, passwordHash, parsed.data.display_name ?? null],
      );

      const { tokenRaw } = await issueVerificationToken({
        client,
        userId,
        now: clock(),
        tokenBytes,
      });

      await client.query('COMMIT');

      await deliver(sendEmail, logger, { email, token: tokenRaw, userId });

      // Grant 3 free trial sessions (10 min each) as signup bonus.
      try {
        await client.query('BEGIN');
        await appendLedgerEntry(client, {
          userId,
          sessionDelta: 3,
          lifetimeFlagSet: 'unchanged',
          reason: 'signup_bonus',
          note: '3 free trial sessions (10 min each)',
        });
        await client.query('COMMIT');
      } catch (err) {
        // Trial grant failure must not roll back the user creation.
        // The user can still register; an admin can grant sessions later.
        await safeRollback(client);
        logger.warn('signup_bonus_grant_failed', {
          user_id: userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return c.json(
        { user_id: userId, status: 'pending_verification' as const },
        200,
      );
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
  });

  router.post('/auth/verify-email', async (c) => {
    const raw = await readJson(c.req.raw);
    if (raw === null) {
      return c.json(err('invalid_json', 'request body must be JSON'), 400);
    }
    const parsed = verifyEmailBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        err('invalid_input', 'token is required'),
        400,
      );
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
           FROM email_verifications
          WHERE token_hash = $1`,
        [tokenHash],
      );

      const row = tokenRow.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return c.json(
          err('invalid_token', 'verification token is invalid'),
          400,
        );
      }

      if (row.used_at !== null) {
        await client.query('ROLLBACK');
        // Same code as missing token: the token has been consumed and
        // is no longer a valid bearer.
        return c.json(
          err('invalid_token', 'verification token is invalid'),
          400,
        );
      }

      const expiresAt = toDate(row.expires_at);
      if (expiresAt.getTime() <= now.getTime()) {
        await client.query('ROLLBACK');
        return c.json(
          err('token_expired', 'verification token has expired'),
          400,
        );
      }

      await client.query(
        `UPDATE email_verifications SET used_at = $1 WHERE id = $2`,
        [now.toISOString(), row.id],
      );
      // COALESCE preserves the original verification timestamp on
      // re-verification so we can answer "when was this account first
      // verified" from a single column.
      await client.query(
        `UPDATE users
            SET email_verified_at = COALESCE(email_verified_at, $1)
          WHERE id = $2`,
        [now.toISOString(), row.user_id],
      );

      await client.query('COMMIT');
      return c.json({ verified: true as const }, 200);
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
  });

  router.post('/auth/resend-verification', async (c) => {
    const raw = await readJson(c.req.raw);
    if (raw === null) {
      return c.json(err('invalid_json', 'request body must be JSON'), 400);
    }
    const parsed = resendBody.safeParse(raw);
    // For malformed input we still return the success-shape body to
    // prevent the response from leaking whether an account exists. The
    // response envelope `{sent: true}` is the same shape returned for
    // every other terminal branch in this handler.
    if (!parsed.success) {
      return c.json({ sent: true as const }, 200);
    }

    const email = parsed.data.email.toLowerCase();
    const now = clock();

    const client = await deps.pool.connect();
    try {
      const userResult = await client.query<{
        id: string;
        email_verified_at: Date | string | null;
      }>(
        `SELECT id, email_verified_at FROM users WHERE LOWER(email) = $1`,
        [email],
      );

      const user = userResult.rows[0];
      if (!user) {
        return c.json({ sent: true as const }, 200);
      }
      if (user.email_verified_at !== null) {
        // Account is already verified; nothing to send. Returning the
        // success shape (rather than e.g. 409) prevents an attacker
        // from distinguishing verified from unverified addresses.
        return c.json({ sent: true as const }, 200);
      }

      // Rate limit: at most RESEND_RATE_LIMIT_COUNT verification rows
      // created for this user in the last RESEND_RATE_LIMIT_WINDOW_MS.
      const windowStart = new Date(
        now.getTime() - RESEND_RATE_LIMIT_WINDOW_MS,
      );
      const countResult = await client.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count
           FROM email_verifications
          WHERE user_id = $1
            AND created_at > $2`,
        [user.id, windowStart.toISOString()],
      );
      const recent = Number(countResult.rows[0]?.count ?? 0);
      if (recent >= RESEND_RATE_LIMIT_COUNT) {
        // Silently drop and return the success shape. Surfacing a 429
        // here would let an attacker who already knows the address is
        // unverified fingerprint other usage; keeping the envelope
        // identical preserves Property 18-style indistinguishability.
        logger.info('verification_email_resend_throttled', {
          user_id: user.id,
        });
        return c.json({ sent: true as const }, 200);
      }

      await client.query('BEGIN');
      const { tokenRaw } = await issueVerificationToken({
        client,
        userId: user.id,
        now,
        tokenBytes,
      });
      await client.query('COMMIT');

      await deliver(sendEmail, logger, {
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

  return router;
}

interface IssueTokenInput {
  readonly client: PoolClient;
  readonly userId: string;
  readonly now: Date;
  readonly tokenBytes: number;
}

/**
 * Generate a fresh verification token, store its SHA-256 hash, and
 * return the raw token to the caller for delivery. The raw token is
 * never persisted; only its hash is stored, so a database read does
 * not yield a usable bearer credential.
 */
async function issueVerificationToken(
  input: IssueTokenInput,
): Promise<{ readonly tokenRaw: string }> {
  const tokenRaw = randomBytes(input.tokenBytes).toString('base64url');
  const tokenHash = sha256Hex(tokenRaw);
  const expiresAt = new Date(
    input.now.getTime() + VERIFICATION_TOKEN_TTL_MS,
  );

  await input.client.query(
    `INSERT INTO email_verifications
       (id, user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomUUID(),
      input.userId,
      tokenHash,
      expiresAt.toISOString(),
      input.now.toISOString(),
    ],
  );

  return { tokenRaw };
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
    // Nothing to do; the caller's `finally` will release the client.
  }
}

async function deliver(
  send: VerificationEmailSender,
  logger: Logger,
  input: { readonly email: string; readonly token: string; readonly userId: string },
): Promise<void> {
  try {
    await send(input);
  } catch (err) {
    // A failed email send must never roll back the user creation; the
    // user can request a resend. Log the failure (with the token
    // redacted by name) so operators can see the delivery problem.
    logger.warn('verification_email_send_failed', {
      user_id: input.userId,
      email: input.email,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
