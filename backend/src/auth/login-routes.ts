/**
 * Auth_Service login route.
 *
 * This module exposes:
 *
 *   - POST /auth/login  (Requirements 1.2, 1.5, 12.5)
 *
 * The login endpoint implements a lockout state machine:
 *   - 5 invalid attempts within 15 minutes → 15-minute lockout
 *   - During lockout, all attempts are rejected with 429 + Retry-After
 *   - On success: reset failed_login_count, issue access + refresh tokens
 *
 * On successful token issuance, the endpoint also records a
 * `login_success` rate event with the client IP and runs the
 * suspicious-login-velocity detector (Requirement 12.5):
 *   - If more than 10 distinct login_success events from more than 5
 *     distinct IPs within a rolling 60-minute window, emit at most one
 *     `suspicious_login_velocity` audit row per account per rolling hour.
 *
 * Refresh tokens are stored hashed (SHA-256) and bound to the
 * `client_id` supplied in the request body (Requirement 13.5).
 *
 * Design references:
 *   - design.md "Auth_Service" table: POST /auth/login
 *   - design.md "refresh_tokens" data model
 */

import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verify as verifyPassword } from './password.js';
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from './jwt.js';
import { writeAudit } from '../log/audit.js';

/** Lockout threshold: number of failed attempts before lockout. */
export const LOCKOUT_THRESHOLD = 5;
/** Lockout window in milliseconds (15 minutes). */
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
/** Lockout duration in milliseconds (15 minutes). */
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
/** Refresh token TTL in milliseconds (30 days). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Refresh token random byte length before base64url encoding. */
export const REFRESH_TOKEN_BYTES = 32;

/**
 * Suspicious login velocity thresholds (Requirement 12.5):
 *   - More than VELOCITY_EVENT_THRESHOLD distinct login_success events
 *   - From more than VELOCITY_IP_THRESHOLD distinct IPs
 *   - Within a rolling VELOCITY_WINDOW_MS window (60 minutes)
 */
export const VELOCITY_WINDOW_MS = 60 * 60 * 1000;
export const VELOCITY_EVENT_THRESHOLD = 10;
export const VELOCITY_IP_THRESHOLD = 5;

export interface LoginRoutesDeps {
  /** Postgres pool. */
  readonly pool: Pool;
  /** Clock injection for tests; defaults to wall-clock UTC. */
  readonly now?: () => Date;
  /**
   * When true, skip the suspicious-login-velocity detector.
   * Useful for tests that don't need the detector overhead.
   */
  readonly skipVelocityDetector?: boolean;
}

const loginBody = z.object({
  email: z.string().trim().min(1).max(254).email(),
  password: z.string().min(1).max(1024),
  client_id: z.string().uuid(),
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

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const envelope: ErrorBody = err(code, message, details);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  }
  return new Response(JSON.stringify(envelope), { status, headers });
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

/**
 * Extract a best-effort client IP from the incoming request.
 * Prefers `X-Forwarded-For` (first hop), falls back to `X-Real-Ip`.
 */
function extractClientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const real = req.headers.get('x-real-ip');
  if (real && real.length > 0) return real;
  return null;
}

/**
 * Suspicious-login-velocity detector (Requirement 12.5).
 *
 * Records a `login_success` rate event with the client IP, then queries
 * distinct event count and distinct IP count in the last 60 minutes.
 * If thresholds are exceeded, emits at most one `suspicious_login_velocity`
 * audit row per account per rolling hour.
 *
 * This function is fire-and-forget from the login handler's perspective:
 * failures are logged but do not block the login response.
 */
async function detectSuspiciousLoginVelocity(
  client: PoolClient,
  userId: string,
  ip: string | null,
  now: Date,
): Promise<void> {
  const tsIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - VELOCITY_WINDOW_MS).toISOString();

  // 1. Record the login_success rate event with IP.
  await client.query(
    `INSERT INTO rate_events (user_id, ts, kind, ip)
       VALUES ($1, $2::timestamptz, $3, $4)
     ON CONFLICT (user_id, ts, kind) DO NOTHING`,
    [userId, tsIso, 'login_success', ip],
  );

  // 2. Query distinct event count and distinct IP count in the rolling window.
  const statsResult = await client.query<{
    event_count: string;
    ip_count: string;
  }>(
    `SELECT
       COUNT(*)::int AS event_count,
       COUNT(DISTINCT ip)::int AS ip_count
     FROM rate_events
     WHERE user_id = $1
       AND kind = 'login_success'
       AND ts > $2::timestamptz`,
    [userId, cutoffIso],
  );

  const stats = statsResult.rows[0];
  if (!stats) return;

  const eventCount = Number(stats.event_count);
  const ipCount = Number(stats.ip_count);

  // 3. Check thresholds: more than 10 events from more than 5 distinct IPs.
  if (eventCount <= VELOCITY_EVENT_THRESHOLD || ipCount <= VELOCITY_IP_THRESHOLD) {
    return;
  }

  // 4. Check if an audit row already exists for this account in the rolling hour.
  const existingAudit = await client.query<{ id: string }>(
    `SELECT id FROM audit_log
     WHERE target_user_id = $1
       AND event_type = 'suspicious_login_velocity'
       AND ts > $2::timestamptz
     LIMIT 1`,
    [userId, cutoffIso],
  );

  if (existingAudit.rows.length > 0) {
    // Already emitted one audit row in this rolling hour — skip.
    return;
  }

  // 5. Emit the audit row.
  await writeAudit(client, {
    actor: { userId },
    target: { userId },
    eventType: 'suspicious_login_velocity',
    outcome: 'success',
    reasonCode: 'suspicious_login_velocity',
    metadata: {
      event_count: eventCount,
      ip_count: ipCount,
      detection_timestamp: tsIso,
    },
  });
}

/**
 * Build the auth login sub-router. Mount with
 * `app.route('/', buildAuthLoginRouter(deps))`.
 */
export function buildAuthLoginRouter(deps: LoginRoutesDeps): Hono {
  const router = new Hono();
  const clock = deps.now ?? ((): Date => new Date());

  router.post('/auth/login', async (c) => {
    const raw = await readJson(c.req.raw);
    if (raw === null) {
      return c.json(err('invalid_json', 'request body must be JSON'), 400);
    }
    const parsed = loginBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        err('invalid_input', 'email, password, and client_id are required'),
        400,
      );
    }

    const { email: rawEmail, password, client_id: clientId } = parsed.data;
    const email = rawEmail.toLowerCase();
    const now = clock();

    const client = await deps.pool.connect();
    try {
      // Look up user by email.
      const userResult = await client.query<{
        id: string;
        email: string;
        password_hash: string;
        role: string;
        display_name: string | null;
        email_verified_at: string | null;
        locked_until: string | null;
        failed_login_count: number;
      }>(
        `SELECT id, email, password_hash, role, display_name, email_verified_at,
                locked_until, failed_login_count
           FROM users WHERE LOWER(email) = $1`,
        [email],
      );

      const user = userResult.rows[0];
      if (!user) {
        // User not found — return generic invalid_credentials to avoid
        // disclosing whether the email exists.
        return c.json(
          err('invalid_credentials', 'email or password is incorrect'),
          401,
        );
      }

      // Check email verification.
      if (user.email_verified_at === null) {
        return c.json(
          err('email_not_verified', 'email address has not been verified'),
          403,
        );
      }

      // Check lockout state.
      if (user.locked_until !== null) {
        const lockedUntil = new Date(user.locked_until);
        if (lockedUntil.getTime() > now.getTime()) {
          const retryAfterSeconds = Math.ceil(
            (lockedUntil.getTime() - now.getTime()) / 1000,
          );
          return errorResponse(
            429,
            'account_locked',
            'account is temporarily locked due to too many failed login attempts',
            { retry_after: retryAfterSeconds },
            { 'Retry-After': String(retryAfterSeconds) },
          );
        }
        // Lockout has expired — clear it and reset counter.
        await client.query(
          `UPDATE users SET locked_until = NULL, failed_login_count = 0
            WHERE id = $1`,
          [user.id],
        );
        user.failed_login_count = 0;
        user.locked_until = null;
      }

      // Verify password.
      const passwordValid = await verifyPassword(user.password_hash, password);
      if (!passwordValid) {
        // Increment failed login count.
        const newCount = user.failed_login_count + 1;
        if (newCount >= LOCKOUT_THRESHOLD) {
          // Lock the account for LOCKOUT_DURATION_MS.
          const lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
          await client.query(
            `UPDATE users SET failed_login_count = $1, locked_until = $2
              WHERE id = $3`,
            [newCount, lockedUntil.toISOString(), user.id],
          );
          const retryAfterSeconds = Math.ceil(LOCKOUT_DURATION_MS / 1000);
          return errorResponse(
            429,
            'account_locked',
            'account is temporarily locked due to too many failed login attempts',
            { retry_after: retryAfterSeconds },
            { 'Retry-After': String(retryAfterSeconds) },
          );
        } else {
          await client.query(
            `UPDATE users SET failed_login_count = $1 WHERE id = $2`,
            [newCount, user.id],
          );
        }
        return c.json(
          err('invalid_credentials', 'email or password is incorrect'),
          401,
        );
      }

      // Password is valid — reset failed login count.
      await client.query(
        `UPDATE users SET failed_login_count = 0, locked_until = NULL
          WHERE id = $1`,
        [user.id],
      );

      // Issue access token (60 min).
      const accessTokenResult = await signAccessToken({
        sub: user.id,
        role: user.role as 'user' | 'admin',
        clientId,
        email: user.email,
        displayName: user.display_name,
      });

      // Generate refresh token (30 days).
      const refreshTokenRaw = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
      const refreshTokenHash = sha256Hex(refreshTokenRaw);
      const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

      // Store refresh token hash + client_id in refresh_tokens table.
      await client.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, client_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          user.id,
          refreshTokenHash,
          clientId,
          refreshExpiresAt.toISOString(),
          now.toISOString(),
        ],
      );

      // Suspicious-login-velocity detector (Requirement 12.5).
      // Fire-and-forget: errors are swallowed so they don't block login.
      if (!deps.skipVelocityDetector) {
        const clientIp = extractClientIp(c.req.raw);
        try {
          await detectSuspiciousLoginVelocity(client, user.id, clientIp, now);
        } catch {
          // Detection failure must not block the login response.
        }
      }

      return c.json({
        access_token: accessTokenResult.token,
        refresh_token: refreshTokenRaw,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        role: user.role,
        display_name: user.display_name,
      });
    } finally {
      client.release();
    }
  });

  return router;
}
