import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import { writeAudit } from '../log/audit.js';

/**
 * Admin Pack_Catalog HTTP routes.
 *
 *   GET   /admin/packs          — list every Pack (active and inactive)
 *   PATCH /admin/packs/:slug    — update editable fields with full
 *                                 validation and an audit row
 *
 * Validates: Requirements 5.5, 5.6, 11.6, 11.7.
 *
 * The router is built as a standalone Hono sub-app so the global
 * middleware chain (`src/http/middleware.ts`, task 3.5) can layer
 * `clientIdGate → buildVersionGate → jwtAuth → requireRole('admin')`
 * on top once the chain is wired up application-wide. Until then the
 * router performs its own bearer-token + admin-role check inline,
 * mirroring the convention established by `src/packs/routes.ts`.
 *
 * Pack deactivation guard (Requirement 11.7): rejects deactivation
 * when ≥ 1 pending purchases exist; surfaces count in error
 * `details.pending_orders_count`.
 */

const SLUG_VALUES = ['starter', 'pro', 'lifetime'] as const;
type Slug = (typeof SLUG_VALUES)[number];

/** Maximum monetary amount per Requirement 5.1 (100,000,000 paise). */
const MAX_PAISE = 100_000_000;

export interface AdminPacksRouterDeps {
  /** Postgres pool used for catalog reads and the transactional update. */
  readonly pool: Pool;
}

/** Wire-format pack returned by `GET /admin/packs`. */
export interface AdminPackResponse {
  slug: string;
  display_name: string;
  description: string;
  mrp_paise: number;
  welcome_price_paise: number;
  /**
   * `floor((mrp - welcome) / mrp * 100)` per Requirement 5.9. Provided so
   * the Admin_Dashboard does not have to recompute it client-side.
   */
  discount_percent: number;
  session_count: number | null;
  is_lifetime: boolean;
  active: boolean;
  updated_at: string;
}

interface PackRow {
  slug: string;
  display_name: string;
  description: string;
  mrp_paise: string | number;
  welcome_price_paise: string | number;
  session_count: number | null;
  is_lifetime: boolean;
  active: boolean;
  updated_at: Date | string;
}

/**
 * Zod schema for PATCH bodies. Every field is optional; the post-merge
 * validation step in `validateMerged` enforces the cross-field
 * invariants from Requirement 5.5 (welcome < MRP, lifetime XOR
 * session_count, ranges).
 *
 * Strict mode rejects unknown keys so a typo in the request body
 * cannot silently no-op (R5.6: an invalid update is rejected with HTTP
 * 400 and an indication of the offending field).
 */
const patchBodySchema = z
  .object({
    display_name: z
      .string()
      .min(1, { message: 'display_name must be 1..50 characters' })
      .max(50, { message: 'display_name must be 1..50 characters' })
      .optional(),
    description: z
      .string()
      .min(1, { message: 'description must be 1..500 characters' })
      .max(500, { message: 'description must be 1..500 characters' })
      .optional(),
    mrp_paise: z
      .number()
      .int({ message: 'mrp_paise must be an integer' })
      .gt(0, { message: 'mrp_paise must be in (0, 100000000]' })
      .lte(MAX_PAISE, { message: 'mrp_paise must be in (0, 100000000]' })
      .optional(),
    welcome_price_paise: z
      .number()
      .int({ message: 'welcome_price_paise must be an integer' })
      .gte(0, { message: 'welcome_price_paise must be >= 0' })
      .lte(MAX_PAISE, { message: 'welcome_price_paise must be <= 100000000' })
      .optional(),
    session_count: z
      .number()
      .int({ message: 'session_count must be a positive integer' })
      .gt(0, { message: 'session_count must be a positive integer' })
      .nullable()
      .optional(),
    is_lifetime: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();

type PatchBody = z.infer<typeof patchBodySchema>;

interface MergedPack {
  display_name: string;
  description: string;
  mrp_paise: number;
  welcome_price_paise: number;
  session_count: number | null;
  is_lifetime: boolean;
  active: boolean;
}

interface ValidationFailure {
  readonly field: string;
  readonly message: string;
}

export function buildAdminPacksRouter(deps: AdminPacksRouterDeps): Hono {
  const router = new Hono();

  router.get('/admin/packs', async (c) => {
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    const result = await deps.pool.query<PackRow>(
      `SELECT slug,
              display_name,
              description,
              mrp_paise,
              welcome_price_paise,
              session_count,
              is_lifetime,
              active,
              updated_at
         FROM packs`,
    );

    const ordered = [...result.rows].sort(
      (a, b) => packOrderIndex(a.slug) - packOrderIndex(b.slug),
    );

    const packs: AdminPackResponse[] = ordered.map(rowToResponse);
    return c.json({ packs });
  });

  router.patch('/admin/packs/:slug', async (c) => {
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    const slug = c.req.param('slug');
    if (!isSlug(slug)) {
      return c.json(
        {
          error: {
            code: 'pack_not_found',
            message: 'pack not found',
          },
        },
        404,
      );
    }

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

    const parsed = patchBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join('.') ?? '<body>';
      return c.json(
        {
          error: {
            code: 'invalid_pack_update',
            message: issue?.message ?? 'invalid pack update',
            details: { field },
          },
        },
        400,
      );
    }
    const body = parsed.data;

    if (Object.keys(body).length === 0) {
      return c.json(
        {
          error: {
            code: 'invalid_pack_update',
            message: 'request body must contain at least one field to update',
            details: { field: '<body>' },
          },
        },
        400,
      );
    }

    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      const currentResult = await client.query<PackRow>(
        `SELECT slug,
                display_name,
                description,
                mrp_paise,
                welcome_price_paise,
                session_count,
                is_lifetime,
                active,
                updated_at
           FROM packs
          WHERE slug = $1
          FOR UPDATE`,
        [slug],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) {
        await client.query('ROLLBACK');
        return c.json(
          {
            error: { code: 'pack_not_found', message: 'pack not found' },
          },
          404,
        );
      }
      const current = rowToMerged(currentRow);
      const merged = applyPatch(current, body);

      const failure = validateMerged(merged);
      if (failure) {
        await client.query('ROLLBACK');
        return c.json(
          {
            error: {
              code: 'invalid_pack_update',
              message: failure.message,
              details: { field: failure.field },
            },
          },
          400,
        );
      }

      // Pack deactivation guard (Requirement 11.7):
      // Reject deactivation when ≥ 1 pending purchases exist for this pack.
      if (current.active && !merged.active) {
        const pendingResult = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM purchases
            WHERE pack_slug = $1
              AND status = 'pending'`,
          [slug],
        );
        const pendingCount = Number(pendingResult.rows[0]?.count ?? '0');
        if (pendingCount > 0) {
          await client.query('ROLLBACK');
          return c.json(
            {
              error: {
                code: 'pack_has_pending_orders',
                message: `Cannot deactivate pack with ${pendingCount} pending order(s)`,
                details: { pending_orders_count: pendingCount },
              },
            },
            409,
          );
        }
      }

      // No-op update if nothing changed: still emit an audit row with
      // identical previous/new values? Spec is silent; we choose to
      // skip the UPDATE and skip the audit row to keep the audit log
      // signal:noise high.
      if (!hasChanges(current, merged)) {
        await client.query('ROLLBACK');
        return c.json({ pack: rowToResponse(currentRow) }, 200);
      }

      const updatedResult = await client.query<PackRow>(
        `UPDATE packs
            SET display_name = $1,
                description = $2,
                mrp_paise = $3,
                welcome_price_paise = $4,
                session_count = $5,
                is_lifetime = $6,
                active = $7,
                updated_at = now()
          WHERE slug = $8
          RETURNING slug,
                    display_name,
                    description,
                    mrp_paise,
                    welcome_price_paise,
                    session_count,
                    is_lifetime,
                    active,
                    updated_at`,
        [
          merged.display_name,
          merged.description,
          merged.mrp_paise,
          merged.welcome_price_paise,
          merged.session_count,
          merged.is_lifetime,
          merged.active,
          slug,
        ],
      );

      // Per Requirement 5.5: audit row records previous and new values.
      await writeAudit(client, {
        actor: { userId: auth.sub },
        target: { resource: `pack:${slug}` },
        eventType: 'pack_update',
        outcome: 'success',
        metadata: {
          slug,
          previous: snapshotForAudit(current),
          new: snapshotForAudit(merged),
        },
      });

      await client.query('COMMIT');

      const updatedRow = updatedResult.rows[0]!;
      return c.json({ pack: rowToResponse(updatedRow) }, 200);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors; surface the original below
      }
      throw err;
    } finally {
      client.release();
    }
  });

  return router;
}

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
 * Inline authentication + role gate used until the global middleware
 * chain is mounted. Returns the byte-equal 403 envelope for every
 * non-admin case (no header, malformed header, invalid token, role !=
 * admin) so the response is identical regardless of whether the
 * targeted resource exists, satisfying Requirement 2.3 / Property 14.
 */
async function authenticateAdmin(
  authorization: string | undefined,
): Promise<AdminAuthSuccess | AuthFailure> {
  const forbidden: AuthFailure = {
    status: 403,
    errorBody: {
      error: { code: 'forbidden_role', message: 'caller does not have the required role' },
    },
  };

  if (!authorization) return forbidden;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) return forbidden;
  try {
    const claims = await verifyAccess(match[1]!);
    if (claims.role !== 'admin') return forbidden;
    return { sub: claims.sub, role: 'admin', client_id: claims.client_id };
  } catch (err) {
    if (err instanceof JwtError) return forbidden;
    throw err;
  }
}

function isSlug(value: string): value is Slug {
  return (SLUG_VALUES as readonly string[]).includes(value);
}

function packOrderIndex(slug: string): number {
  const idx = (SLUG_VALUES as readonly string[]).indexOf(slug);
  return idx === -1 ? SLUG_VALUES.length : idx;
}

function rowToResponse(row: PackRow): AdminPackResponse {
  const mrp = Number(row.mrp_paise);
  const welcome = Number(row.welcome_price_paise);
  return {
    slug: row.slug,
    display_name: row.display_name,
    description: row.description,
    mrp_paise: mrp,
    welcome_price_paise: welcome,
    discount_percent: discountPercent(mrp, welcome),
    session_count: row.session_count,
    is_lifetime: row.is_lifetime,
    active: row.active,
    updated_at:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function rowToMerged(row: PackRow): MergedPack {
  return {
    display_name: row.display_name,
    description: row.description,
    mrp_paise: Number(row.mrp_paise),
    welcome_price_paise: Number(row.welcome_price_paise),
    session_count: row.session_count,
    is_lifetime: row.is_lifetime,
    active: row.active,
  };
}

function applyPatch(current: MergedPack, patch: PatchBody): MergedPack {
  return {
    display_name: patch.display_name ?? current.display_name,
    description: patch.description ?? current.description,
    mrp_paise: patch.mrp_paise ?? current.mrp_paise,
    welcome_price_paise: patch.welcome_price_paise ?? current.welcome_price_paise,
    session_count:
      patch.session_count !== undefined ? patch.session_count : current.session_count,
    is_lifetime: patch.is_lifetime ?? current.is_lifetime,
    active: patch.active ?? current.active,
  };
}

/**
 * Cross-field validation per Requirement 5.5:
 *   - welcome_price_paise strictly less than mrp_paise
 *   - mrp / welcome ranges (already enforced field-wise; rechecked here
 *     for the merged record)
 *   - lifetime XOR session_count: a non-lifetime pack must have a
 *     positive session_count; a lifetime pack must not
 *
 * Returns the first failure as `{ field, message }`, or `null` when
 * the merged record is valid.
 */
function validateMerged(p: MergedPack): ValidationFailure | null {
  if (!Number.isInteger(p.mrp_paise) || p.mrp_paise <= 0 || p.mrp_paise > MAX_PAISE) {
    return { field: 'mrp_paise', message: 'mrp_paise must be in (0, 100000000]' };
  }
  if (
    !Number.isInteger(p.welcome_price_paise) ||
    p.welcome_price_paise < 0 ||
    p.welcome_price_paise > MAX_PAISE
  ) {
    return {
      field: 'welcome_price_paise',
      message: 'welcome_price_paise must be in [0, 100000000]',
    };
  }
  if (p.welcome_price_paise >= p.mrp_paise) {
    return {
      field: 'welcome_price_paise',
      message: 'welcome_price_paise must be strictly less than mrp_paise',
    };
  }
  if (p.is_lifetime) {
    if (p.session_count !== null) {
      return {
        field: 'session_count',
        message: 'session_count must be null when is_lifetime is true',
      };
    }
  } else {
    if (p.session_count === null) {
      return {
        field: 'session_count',
        message: 'session_count is required when is_lifetime is false',
      };
    }
    if (!Number.isInteger(p.session_count) || p.session_count <= 0) {
      return {
        field: 'session_count',
        message: 'session_count must be a positive integer',
      };
    }
  }
  if (p.display_name.length < 1 || p.display_name.length > 50) {
    return { field: 'display_name', message: 'display_name must be 1..50 characters' };
  }
  if (p.description.length < 1 || p.description.length > 500) {
    return { field: 'description', message: 'description must be 1..500 characters' };
  }
  return null;
}

function hasChanges(current: MergedPack, merged: MergedPack): boolean {
  return (
    current.display_name !== merged.display_name ||
    current.description !== merged.description ||
    current.mrp_paise !== merged.mrp_paise ||
    current.welcome_price_paise !== merged.welcome_price_paise ||
    current.session_count !== merged.session_count ||
    current.is_lifetime !== merged.is_lifetime ||
    current.active !== merged.active
  );
}

function snapshotForAudit(p: MergedPack): Record<string, unknown> {
  return {
    display_name: p.display_name,
    description: p.description,
    mrp_paise: p.mrp_paise,
    welcome_price_paise: p.welcome_price_paise,
    session_count: p.session_count,
    is_lifetime: p.is_lifetime,
    active: p.active,
  };
}

function discountPercent(mrp: number, welcome: number): number {
  if (mrp <= 0) return 0;
  return Math.floor(((mrp - welcome) / mrp) * 100);
}

// Re-export for tests that need the same client interface used internally.
export type { PoolClient };
