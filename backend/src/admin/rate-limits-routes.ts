import { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import { writeAudit } from '../log/audit.js';

/**
 * Admin rate-limit override HTTP routes.
 *
 *   PATCH /admin/rate-limits/:user_id — set per-user rate limit overrides
 *
 * Validates: Requirements 12.4.
 *
 * Per-user overrides take precedence over the default rate limits at
 * lookup time. Each value must be an integer in [0, 100000]. A `null`
 * value clears the override for that field (reverts to default).
 *
 * The endpoint upserts into `rate_limit_overrides` and writes an
 * `audit_log` entry recording the previous and new values in the same
 * transaction.
 */

export interface AdminRateLimitsRouterDeps {
  /** Postgres pool used for the transactional upsert. */
  readonly pool: Pool;
}

/**
 * Validation schema for PATCH /admin/rate-limits/:user_id.
 *
 * Each field is optional. When present, it must be an integer in [0, 100000]
 * or null (to clear the override). At least one field must be provided.
 */
const rateLimitOverrideSchema = z
  .object({
    ai_per_minute: z
      .number({
        invalid_type_error: 'ai_per_minute must be a number',
      })
      .int('ai_per_minute must be an integer')
      .min(0, 'ai_per_minute must be >= 0')
      .max(100000, 'ai_per_minute must be <= 100000')
      .nullable()
      .optional(),
    ai_per_day: z
      .number({
        invalid_type_error: 'ai_per_day must be a number',
      })
      .int('ai_per_day must be an integer')
      .min(0, 'ai_per_day must be >= 0')
      .max(100000, 'ai_per_day must be <= 100000')
      .nullable()
      .optional(),
    session_start_per_hour: z
      .number({
        invalid_type_error: 'session_start_per_hour must be a number',
      })
      .int('session_start_per_hour must be an integer')
      .min(0, 'session_start_per_hour must be >= 0')
      .max(100000, 'session_start_per_hour must be <= 100000')
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.ai_per_minute !== undefined ||
      data.ai_per_day !== undefined ||
      data.session_start_per_hour !== undefined,
    { message: 'at least one override field must be provided' },
  );

export function buildAdminRateLimitsRouter(deps: AdminRateLimitsRouterDeps): Hono {
  const router = new Hono();

  router.patch('/admin/rate-limits/:user_id', async (c) => {
    // Inline admin auth gate.
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    const targetUserId = c.req.param('user_id');

    // Validate UUID format for the target user id.
    if (!isValidUuid(targetUserId)) {
      return c.json(
        { error: { code: 'invalid_user_id', message: 'user_id must be a valid UUID' } },
        400,
      );
    }

    // Parse and validate request body.
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: 'invalid_request_body',
            message: 'request body must be valid JSON',
          },
        },
        400,
      );
    }

    const parsed = rateLimitOverrideSchema.safeParse(raw);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return c.json(
        {
          error: {
            code: 'invalid_request_body',
            message: firstIssue?.message ?? 'invalid request body',
          },
        },
        400,
      );
    }

    const { ai_per_minute, ai_per_day, session_start_per_hour } = parsed.data;

    // Single transaction: read previous values, upsert, audit.
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      // Read previous override values (if any).
      const prevResult = await client.query<{
        ai_per_min: number | null;
        ai_per_day: number | null;
        session_per_hour: number | null;
      }>(
        `SELECT ai_per_min, ai_per_day, session_per_hour
           FROM rate_limit_overrides
          WHERE user_id = $1`,
        [targetUserId],
      );

      const previousValues = prevResult.rows[0] ?? {
        ai_per_min: null,
        ai_per_day: null,
        session_per_hour: null,
      };

      // Compute new values: only update fields that were provided.
      const newAiPerMin =
        ai_per_minute !== undefined ? ai_per_minute : previousValues.ai_per_min;
      const newAiPerDay =
        ai_per_day !== undefined ? ai_per_day : previousValues.ai_per_day;
      const newSessionPerHour =
        session_start_per_hour !== undefined
          ? session_start_per_hour
          : previousValues.session_per_hour;

      // Upsert into rate_limit_overrides.
      await client.query(
        `INSERT INTO rate_limit_overrides (user_id, ai_per_min, ai_per_day, session_per_hour, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id)
         DO UPDATE SET
           ai_per_min = $2,
           ai_per_day = $3,
           session_per_hour = $4,
           updated_at = now()`,
        [targetUserId, newAiPerMin, newAiPerDay, newSessionPerHour],
      );

      // Write audit log entry within the same transaction.
      await writeAudit(client, {
        actor: { userId: auth.sub },
        target: { userId: targetUserId, resource: `rate_limit_overrides:${targetUserId}` },
        eventType: 'rate_limit_override_change',
        outcome: 'success',
        metadata: {
          previous: {
            ai_per_minute: previousValues.ai_per_min,
            ai_per_day: previousValues.ai_per_day,
            session_start_per_hour: previousValues.session_per_hour,
          },
          new: {
            ai_per_minute: newAiPerMin,
            ai_per_day: newAiPerDay,
            session_start_per_hour: newSessionPerHour,
          },
        },
      });

      await client.query('COMMIT');

      return c.json({
        ok: true,
        overrides: {
          ai_per_minute: newAiPerMin,
          ai_per_day: newAiPerDay,
          session_start_per_hour: newSessionPerHour,
        },
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors; surface the original below.
      }
      throw err;
    } finally {
      client.release();
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The indistinguishable 403 response used for all non-admin cases. */
const RATE_LIMITS_FORBIDDEN = {
  status: 403 as const,
  errorBody: {
    error: {
      code: 'forbidden',
      message: 'admin access required',
    },
  },
};

interface AdminAuthSuccess {
  sub: string;
  role: 'admin';
  client_id: string;
}

interface AuthFailure {
  status: 403;
  errorBody: { error: { code: string; message: string } };
}

/**
 * Inline authentication + role gate. Returns 403 for every non-admin case.
 */
async function authenticateAdmin(
  authorization: string | undefined,
): Promise<AdminAuthSuccess | AuthFailure> {
  if (!authorization) return RATE_LIMITS_FORBIDDEN;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) return RATE_LIMITS_FORBIDDEN;
  try {
    const claims = await verifyAccess(match[1]!);
    if (claims.role !== 'admin') return RATE_LIMITS_FORBIDDEN;
    return { sub: claims.sub, role: 'admin', client_id: claims.client_id };
  } catch (err) {
    if (err instanceof JwtError) return RATE_LIMITS_FORBIDDEN;
    throw err;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}
