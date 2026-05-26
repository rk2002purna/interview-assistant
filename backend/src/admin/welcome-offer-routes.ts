import { Hono } from 'hono';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import { writeAudit } from '../log/audit.js';

/**
 * Admin Welcome_Offer HTTP routes.
 *
 * Implements:
 *   - `GET  /admin/welcome-offer`   - read the singleton row
 *   - `PATCH /admin/welcome-offer`  - update `enabled` and/or `ends_at`
 *
 * Requirements:
 *   - R5.7  Admin updates of the Welcome_Offer enabled flag or end
 *           timestamp persist and append an Audit_Log entry containing
 *           the acting Admin's user id, previous values, new values,
 *           and a UTC timestamp.
 *   - R5.10 Companion to the Admin_Dashboard UI; the API surface here
 *           returns the previous/new values needed for the dashboard's
 *           confirmation dialog (R11.8).
 *   - R11.8 The admin response includes both previous and new values
 *           on a successful update.
 *
 * The router is split into its own file (separate from the admin packs
 * router built in task 5.3) so the two tasks can land in parallel
 * without touching the same file.
 *
 * The middleware chain in `src/http/middleware.ts` exists but is not
 * yet mounted globally on the app (task 4.x will wire it). Until then
 * this router does its own minimal Authorization + role check inline,
 * mirroring `src/packs/routes.ts`. When the global chain lands the
 * inline auth helper will be removed in favour of `c.get('claims')`.
 */

/** The welcome_offer row written and read by these routes. */
interface WelcomeOfferRow {
  enabled: boolean;
  ends_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Wire-format welcome offer returned by both endpoints. */
export interface WelcomeOfferResponse {
  enabled: boolean;
  ends_at: string;
  created_at: string;
  updated_at: string;
}

/** Body of the successful PATCH response. */
export interface WelcomeOfferUpdateResponse {
  welcome_offer: WelcomeOfferResponse;
  previous: { enabled: boolean; ends_at: string };
  new: { enabled: boolean; ends_at: string };
}

export interface WelcomeOfferRouterDeps {
  /** Postgres pool used to run the read and the update transaction. */
  readonly pool: Pool;
}

/**
 * PATCH body: at least one of `enabled` and `ends_at` MUST be supplied.
 *
 * `ends_at` is accepted as an ISO 8601 string (the same wire format the
 * GET endpoint emits) and parsed into a `Date` before persisting. We
 * validate the parse result rather than relying on Zod's `datetime()`
 * because that helper rejects timezone offsets other than `Z`; admins
 * legitimately submit values from a date-time picker that may include
 * `+05:30` or other offsets.
 */
const PatchBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    ends_at: z
      .string()
      .min(1, 'ends_at must be a non-empty ISO 8601 string')
      .max(64, 'ends_at must be a non-empty ISO 8601 string')
      .refine((v) => !Number.isNaN(new Date(v).getTime()), {
        message: 'ends_at must be a valid ISO 8601 timestamp',
      })
      .optional(),
  })
  .strict()
  .refine(
    (body) => body.enabled !== undefined || body.ends_at !== undefined,
    { message: 'request body must include at least one of `enabled` or `ends_at`' },
  );

export function buildAdminWelcomeOfferRouter(
  deps: WelcomeOfferRouterDeps,
): Hono {
  const router = new Hono();

  router.get('/admin/welcome-offer', async (c) => {
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    const client = await deps.pool.connect();
    try {
      const row = await readWelcomeOffer(client);
      if (!row) {
        return c.json(
          {
            error: {
              code: 'welcome_offer_missing',
              message: 'welcome_offer singleton row is not present',
            },
          },
          500,
        );
      }
      return c.json({ welcome_offer: toResponse(row) });
    } finally {
      client.release();
    }
  });

  router.patch('/admin/welcome-offer', async (c) => {
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    let parsedBody: unknown;
    try {
      parsedBody = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: 'invalid_body',
            message: 'request body must be valid JSON',
          },
        },
        400,
      );
    }

    const result = PatchBodySchema.safeParse(parsedBody);
    if (!result.success) {
      const issue = result.error.issues[0];
      return c.json(
        {
          error: {
            code: 'invalid_welcome_offer_update',
            message: issue ? issue.message : 'invalid request body',
            details: issue ? { path: issue.path, message: issue.message } : undefined,
          },
        },
        400,
      );
    }

    const { enabled: enabledPatch, ends_at: endsAtPatch } = result.data;
    const newEndsAt =
      endsAtPatch !== undefined ? new Date(endsAtPatch) : undefined;

    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the singleton row so a concurrent PATCH cannot interleave
      // between the read and the write; this also guarantees the
      // `previous` values we record in the audit row are the ones that
      // existed immediately before our update.
      const existing = await readWelcomeOfferForUpdate(client);
      if (!existing) {
        await client.query('ROLLBACK');
        return c.json(
          {
            error: {
              code: 'welcome_offer_missing',
              message: 'welcome_offer singleton row is not present',
            },
          },
          500,
        );
      }

      const previous = {
        enabled: existing.enabled,
        ends_at: toIsoString(existing.ends_at),
      };

      const nextEnabled =
        enabledPatch !== undefined ? enabledPatch : existing.enabled;
      const nextEndsAt = newEndsAt ?? toDate(existing.ends_at);

      // Short-circuit: if the patch is a no-op, skip the UPDATE and the
      // audit row. R5.7 requires an audit entry on every change; a
      // request that does not change anything is not a change.
      const isNoop =
        nextEnabled === existing.enabled &&
        nextEndsAt.getTime() === toDate(existing.ends_at).getTime();
      if (isNoop) {
        await client.query('ROLLBACK');
        return c.json({
          welcome_offer: toResponse(existing),
          previous,
          new: previous,
        } satisfies WelcomeOfferUpdateResponse);
      }

      const updated = await client.query<WelcomeOfferRow>(
        `UPDATE welcome_offer
            SET enabled = $1,
                ends_at = $2,
                updated_at = now()
          WHERE id = 1
        RETURNING enabled, ends_at, created_at, updated_at`,
        [nextEnabled, nextEndsAt.toISOString()],
      );

      const row = updated.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return c.json(
          {
            error: {
              code: 'welcome_offer_missing',
              message: 'welcome_offer singleton row is not present',
            },
          },
          500,
        );
      }

      const next = {
        enabled: row.enabled,
        ends_at: toIsoString(row.ends_at),
      };

      // Audit row in the same transaction (R5.7, R11.8). previous + new
      // values are recorded so the Admin_Dashboard can render the
      // confirmation prompt and so reviewers can reconstruct the
      // change without joining against version history.
      await writeAudit(client, {
        actor: { userId: auth.sub },
        target: { resource: 'welcome_offer' },
        eventType: 'welcome_offer_update',
        outcome: 'success',
        metadata: { previous, new: next },
      });

      await client.query('COMMIT');

      return c.json({
        welcome_offer: toResponse(row),
        previous,
        new: next,
      } satisfies WelcomeOfferUpdateResponse);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Connection might already be in a bad state; nothing to do.
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

async function readWelcomeOffer(
  client: PoolClient,
): Promise<WelcomeOfferRow | undefined> {
  const result = await client.query<WelcomeOfferRow>(
    `SELECT enabled, ends_at, created_at, updated_at
       FROM welcome_offer
      WHERE id = 1`,
  );
  return result.rows[0];
}

async function readWelcomeOfferForUpdate(
  client: PoolClient,
): Promise<WelcomeOfferRow | undefined> {
  const result = await client.query<WelcomeOfferRow>(
    `SELECT enabled, ends_at, created_at, updated_at
       FROM welcome_offer
      WHERE id = 1
        FOR UPDATE`,
  );
  return result.rows[0];
}

function toResponse(row: WelcomeOfferRow): WelcomeOfferResponse {
  return {
    enabled: row.enabled,
    ends_at: toIsoString(row.ends_at),
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIsoString(value: Date | string): string {
  return toDate(value).toISOString();
}

interface AdminAuthSuccess {
  sub: string;
  role: 'admin';
  client_id: string;
}

interface AdminAuthFailure {
  status: 401 | 403;
  errorBody: { error: { code: string; message: string } };
}

/**
 * Inline authentication + role gate used until the global middleware
 * chain is mounted. Mirrors the pattern in `src/packs/routes.ts` but
 * adds the admin role check (R2.2 / R2.3). Returns the byte-equal 403
 * envelope regardless of whether the caller is unauthenticated or
 * authenticated as a non-admin, satisfying the indistinguishability
 * obligation in R2.3.
 */
async function authenticateAdmin(
  authorization: string | undefined,
): Promise<AdminAuthSuccess | AdminAuthFailure> {
  const forbidden: AdminAuthFailure = {
    status: 403,
    errorBody: {
      error: {
        code: 'forbidden_role',
        message: 'caller does not have the required role',
      },
    },
  };

  if (!authorization) {
    return forbidden;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) {
    return forbidden;
  }
  try {
    const claims = await verifyAccess(match[1]!);
    if (claims.role !== 'admin') {
      return forbidden;
    }
    return { sub: claims.sub, role: 'admin', client_id: claims.client_id };
  } catch (err) {
    if (err instanceof JwtError) {
      return forbidden;
    }
    throw err;
  }
}
