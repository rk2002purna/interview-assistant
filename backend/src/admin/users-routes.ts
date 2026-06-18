import { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import { appendLedgerEntry, LedgerError } from '../entitlement/ledger.js';
import { writeAudit } from '../log/audit.js';

/**
 * Admin user management HTTP routes.
 *
 *   GET   /admin/users           — paginated user list with filters
 *   GET   /admin/users/:id       — detailed user record (purchases, sessions,
 *                                  ledger, current entitlement)
 *   PATCH /admin/users/:id/role  — change a user's role with
 *                                  at-least-one-admin guard
 *   POST  /admin/users/:id/entitlement-adjust — manual session grant/revoke
 *
 * Validates: Requirements 2.5, 2.6, 6.5, 11.1, 11.2, 11.3, 11.4, 11.5.
 *
 * The endpoint runs the entire operation (lock, guard, update, audit)
 * inside a single Postgres transaction so the role change and the
 * audit row either both commit or both roll back.
 *
 * The at-least-one-admin invariant is enforced by counting admin rows
 * (excluding the target) while the target row is locked with
 * SELECT FOR UPDATE. If demoting the target would leave zero admins,
 * the request is rejected with 403.
 *
 * Per Requirement 2.6, the same 403 response is returned when:
 *   - The caller is not an admin (handled by inline auth gate)
 *   - The target user does not exist
 *   - The demotion would leave zero admins
 * This satisfies the indistinguishability obligation (R2.3 / Property 14).
 */

export interface AdminUsersRouterDeps {
  /** Postgres pool used for the transactional role change. */
  readonly pool: Pool;
}

/** Default page size for user list (R11.1: at most 50 per page). */
const DEFAULT_PAGE_SIZE = 50;
/** Maximum allowed page size. */
const MAX_PAGE_SIZE = 50;
/** Minimum allowed page size. */
const MIN_PAGE_SIZE = 1;

const roleBodySchema = z
  .object({
    role: z.enum(['user', 'admin'], {
      errorMap: () => ({ message: "role must be 'user' or 'admin'" }),
    }),
  })
  .strict();

/**
 * Validation schema for POST /admin/users/:id/entitlement-adjust.
 *
 * - session_delta: integer in [-1000, 1000], excluding 0
 * - note: non-empty string of 1–500 characters
 */
const entitlementAdjustBodySchema = z
  .object({
    session_delta: z
      .number({
        required_error: 'session_delta is required',
        invalid_type_error: 'session_delta must be a number',
      })
      .int('session_delta must be an integer')
      .min(-1000, 'session_delta must be >= -1000')
      .max(1000, 'session_delta must be <= 1000')
      .refine((v) => v !== 0, { message: 'session_delta must not be 0' }),
    note: z
      .string({
        required_error: 'note is required',
        invalid_type_error: 'note must be a string',
      })
      .min(1, 'note must be at least 1 character')
      .max(500, 'note must be at most 500 characters'),
  })
  .strict();

export function buildAdminUsersRouter(deps: AdminUsersRouterDeps): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /admin/users
  //
  // Paginated user list with filters. Returns at most 50 users per page
  // in reverse chronological order of account creation.
  //
  // Filters:
  //   - email: case-insensitive substring (up to 254 chars)
  //   - role: one of 'user' or 'admin'
  //   - entitlement_state: one of 'none', 'has_sessions', 'lifetime'
  //   - min_sessions / max_sessions: non-negative integer range
  //
  // Validates: Requirement 11.1.
  // -------------------------------------------------------------------------
  router.get('/admin/users', async (c) => {
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    // Parse query parameters
    const cursorParam = c.req.query('cursor');
    const pageSizeParam = c.req.query('page_size');
    const emailParam = c.req.query('email');
    const roleParam = c.req.query('role');
    const entitlementStateParam = c.req.query('entitlement_state');
    const minSessionsParam = c.req.query('min_sessions');
    const maxSessionsParam = c.req.query('max_sessions');

    // Validate page_size
    let pageSize = DEFAULT_PAGE_SIZE;
    if (pageSizeParam !== undefined && pageSizeParam !== '') {
      const parsed = Number(pageSizeParam);
      if (!Number.isInteger(parsed) || parsed < MIN_PAGE_SIZE || parsed > MAX_PAGE_SIZE) {
        return c.json(
          {
            error: {
              code: 'invalid_page_size',
              message: `page_size must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`,
            },
          },
          400,
        );
      }
      pageSize = parsed;
    }

    // Validate email filter length
    if (emailParam !== undefined && emailParam !== '' && emailParam.length > 254) {
      return c.json(
        {
          error: {
            code: 'invalid_filter',
            message: 'email filter must be at most 254 characters',
          },
        },
        400,
      );
    }

    // Validate role filter
    if (roleParam !== undefined && roleParam !== '' && roleParam !== 'user' && roleParam !== 'admin') {
      return c.json(
        {
          error: {
            code: 'invalid_filter',
            message: "role must be 'user' or 'admin'",
          },
        },
        400,
      );
    }

    // Validate entitlement_state filter
    if (
      entitlementStateParam !== undefined &&
      entitlementStateParam !== '' &&
      !['none', 'has_sessions', 'lifetime'].includes(entitlementStateParam)
    ) {
      return c.json(
        {
          error: {
            code: 'invalid_filter',
            message: "entitlement_state must be 'none', 'has_sessions', or 'lifetime'",
          },
        },
        400,
      );
    }

    // Validate min_sessions / max_sessions
    let minSessions: number | undefined;
    let maxSessions: number | undefined;

    if (minSessionsParam !== undefined && minSessionsParam !== '') {
      const parsed = Number(minSessionsParam);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return c.json(
          {
            error: {
              code: 'invalid_filter',
              message: 'min_sessions must be a non-negative integer',
            },
          },
          400,
        );
      }
      minSessions = parsed;
    }

    if (maxSessionsParam !== undefined && maxSessionsParam !== '') {
      const parsed = Number(maxSessionsParam);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return c.json(
          {
            error: {
              code: 'invalid_filter',
              message: 'max_sessions must be a non-negative integer',
            },
          },
          400,
        );
      }
      maxSessions = parsed;
    }

    if (minSessions !== undefined && maxSessions !== undefined && minSessions > maxSessions) {
      return c.json(
        {
          error: {
            code: 'invalid_filter',
            message: 'min_sessions must be less than or equal to max_sessions',
          },
        },
        400,
      );
    }

    // Validate cursor format
    if (cursorParam !== undefined && cursorParam !== '' && !isValidUuid(cursorParam)) {
      return c.json(
        {
          error: {
            code: 'invalid_cursor',
            message: 'cursor must be a valid UUID',
          },
        },
        400,
      );
    }

    // Build query with a lateral join to get the latest entitlement for each user.
    // This allows filtering by entitlement state and session count range.
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Email filter: case-insensitive substring
    if (emailParam) {
      conditions.push(`u.email ILIKE '%' || $${paramIndex} || '%'`);
      params.push(emailParam);
      paramIndex++;
    }

    // Role filter
    if (roleParam) {
      conditions.push(`u.role = $${paramIndex}`);
      params.push(roleParam);
      paramIndex++;
    }

    // Entitlement state filter
    if (entitlementStateParam === 'lifetime') {
      conditions.push(`COALESCE(e.resulting_lifetime_flag, false) = true`);
    } else if (entitlementStateParam === 'has_sessions') {
      conditions.push(`COALESCE(e.resulting_lifetime_flag, false) = false`);
      conditions.push(`COALESCE(e.resulting_session_count, 0) > 0`);
    } else if (entitlementStateParam === 'none') {
      conditions.push(`COALESCE(e.resulting_lifetime_flag, false) = false`);
      conditions.push(`COALESCE(e.resulting_session_count, 0) = 0`);
    }

    // Session count range filter
    if (minSessions !== undefined) {
      conditions.push(`COALESCE(e.resulting_session_count, 0) >= $${paramIndex}`);
      params.push(minSessions);
      paramIndex++;
    }
    if (maxSessions !== undefined) {
      conditions.push(`COALESCE(e.resulting_session_count, 0) <= $${paramIndex}`);
      params.push(maxSessions);
      paramIndex++;
    }

    // Cursor-based pagination: use (created_at, id) for stable ordering.
    if (cursorParam) {
      conditions.push(
        `(u.created_at, u.id) < (SELECT created_at, id FROM users WHERE id = $${paramIndex})`,
      );
      params.push(cursorParam);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = pageSize + 1;

    const sql = `
      SELECT u.id, u.email, u.role, u.email_verified_at, u.created_at,
             COALESCE(e.resulting_session_count, 0) AS session_count,
             COALESCE(e.resulting_lifetime_flag, false) AS lifetime_flag
        FROM users u
        LEFT JOIN LATERAL (
          SELECT resulting_session_count, resulting_lifetime_flag
            FROM entitlement_ledger
           WHERE user_id = u.id
           ORDER BY ts DESC, id DESC
           LIMIT 1
        ) e ON true
        ${whereClause}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT $${paramIndex}
    `;
    params.push(limit);

    const result = await deps.pool.query<{
      id: string;
      email: string;
      role: string;
      email_verified_at: Date | null;
      created_at: Date | string;
      session_count: number | string;
      lifetime_flag: boolean;
    }>(sql, params);

    const rows = result.rows;
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;

    const responseItems = items.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      email_verified: row.email_verified_at !== null,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      session_count: Number(row.session_count),
      lifetime_flag: row.lifetime_flag === true,
    }));

    const nextCursor = hasMore ? items[items.length - 1]!.id : null;

    return c.json({
      items: responseItems,
      next_cursor: nextCursor,
    });
  });

  // -------------------------------------------------------------------------
  // GET /admin/users/:id
  //
  // Detailed user record including purchase history, recent sessions,
  // recent ledger entries, and current entitlement.
  //
  // Validates: Requirement 11.2.
  // -------------------------------------------------------------------------
  router.get('/admin/users/:id', async (c) => {
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    const targetUserId = c.req.param('id');

    if (!isValidUuid(targetUserId)) {
      return c.json(
        { error: { code: 'user_not_found', message: 'user not found' } },
        404,
      );
    }

    // Fetch user record
    const userResult = await deps.pool.query<{
      id: string;
      email: string;
      role: string;
      email_verified_at: Date | null;
      created_at: Date | string;
    }>(
      `SELECT id, email, role, email_verified_at, created_at FROM users WHERE id = $1`,
      [targetUserId],
    );

    if (userResult.rows.length === 0) {
      return c.json(
        { error: { code: 'user_not_found', message: 'user not found' } },
        404,
      );
    }

    const user = userResult.rows[0]!;

    // Fetch all purchases (full history) in reverse chronological order
    const purchasesResult = await deps.pool.query<{
      id: string;
      pack_slug: string;
      effective_price_paise: string | number;
      mrp_at_purchase_paise: string | number;
      status: string;
      razorpay_order_id: string;
      razorpay_payment_id: string | null;
      welcome_offer_applied: boolean;
      created_at: Date | string;
      completed_at: Date | string | null;
    }>(
      `SELECT id, pack_slug, effective_price_paise, mrp_at_purchase_paise,
              status, razorpay_order_id, razorpay_payment_id,
              welcome_offer_applied, created_at, completed_at
         FROM purchases
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [targetUserId],
    );

    // Fetch 50 most recent sessions in reverse chronological order
    const sessionsResult = await deps.pool.query<{
      id: string;
      status: string;
      started_at: Date | string;
      expires_at: Date | string;
      ended_at: Date | string | null;
      ended_reason: string | null;
    }>(
      `SELECT id, status, started_at, expires_at, ended_at, ended_reason
         FROM interview_sessions
        WHERE user_id = $1
        ORDER BY started_at DESC
        LIMIT 50`,
      [targetUserId],
    );

    // Fetch 50 most recent ledger entries in reverse chronological order
    const ledgerResult = await deps.pool.query<{
      id: string;
      ts: Date | string;
      session_delta: number | string;
      lifetime_flag_set: string;
      reason: string;
      razorpay_payment_id: string | null;
      interview_session_id: string | null;
      acting_admin_id: string | null;
      resulting_session_count: number | string;
      resulting_lifetime_flag: boolean;
      note: string | null;
    }>(
      `SELECT id, ts, session_delta, lifetime_flag_set, reason,
              razorpay_payment_id, interview_session_id, acting_admin_id,
              resulting_session_count, resulting_lifetime_flag, note
         FROM entitlement_ledger
        WHERE user_id = $1
        ORDER BY ts DESC, id DESC
        LIMIT 50`,
      [targetUserId],
    );

    // Current entitlement: from the latest ledger row
    const latestLedger = ledgerResult.rows[0];
    const currentEntitlement = latestLedger
      ? {
          session_count: Number(latestLedger.resulting_session_count),
          lifetime_flag: latestLedger.resulting_lifetime_flag === true,
        }
      : { session_count: 0, lifetime_flag: false };

    // Format response
    const response = {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        email_verified: user.email_verified_at !== null,
        created_at: user.created_at instanceof Date ? user.created_at.toISOString() : user.created_at,
      },
      entitlement: currentEntitlement,
      purchases: purchasesResult.rows.map((p) => ({
        id: p.id,
        pack_slug: p.pack_slug,
        effective_price_paise: Number(p.effective_price_paise),
        mrp_at_purchase_paise: Number(p.mrp_at_purchase_paise),
        status: p.status,
        razorpay_order_id: p.razorpay_order_id,
        razorpay_payment_id: p.razorpay_payment_id,
        welcome_offer_applied: p.welcome_offer_applied,
        created_at: p.created_at instanceof Date ? p.created_at.toISOString() : p.created_at,
        completed_at: p.completed_at instanceof Date ? p.completed_at.toISOString() : p.completed_at,
      })),
      sessions: sessionsResult.rows.map((s) => ({
        id: s.id,
        status: s.status,
        started_at: s.started_at instanceof Date ? s.started_at.toISOString() : s.started_at,
        expires_at: s.expires_at instanceof Date ? s.expires_at.toISOString() : s.expires_at,
        ended_at: s.ended_at instanceof Date ? s.ended_at.toISOString() : s.ended_at,
        ended_reason: s.ended_reason,
      })),
      ledger: ledgerResult.rows.map((l) => ({
        id: l.id,
        ts: l.ts instanceof Date ? l.ts.toISOString() : l.ts,
        session_delta: Number(l.session_delta),
        lifetime_flag_set: l.lifetime_flag_set,
        reason: l.reason,
        razorpay_payment_id: l.razorpay_payment_id,
        interview_session_id: l.interview_session_id,
        acting_admin_id: l.acting_admin_id,
        resulting_session_count: Number(l.resulting_session_count),
        resulting_lifetime_flag: l.resulting_lifetime_flag === true,
        note: l.note,
      })),
    };

    return c.json(response);
  });

  router.patch('/admin/users/:id/role', async (c) => {
    // Inline admin auth gate (same pattern as other admin routes).
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    const targetUserId = c.req.param('id');

    // Validate UUID format for the target user id.
    if (!isValidUuid(targetUserId)) {
      return c.json(ROLE_CHANGE_FORBIDDEN.errorBody, ROLE_CHANGE_FORBIDDEN.status);
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

    const parsed = roleBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'invalid_request_body',
            message: parsed.error.issues[0]?.message ?? "role must be 'user' or 'admin'",
          },
        },
        400,
      );
    }

    const newRole = parsed.data.role;

    // Single transaction: lock + guard + apply + audit.
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the target user row to prevent concurrent role changes.
      const targetResult = await client.query<{ id: string; role: string }>(
        `SELECT id, role FROM users WHERE id = $1 FOR UPDATE`,
        [targetUserId],
      );

      const targetRow = targetResult.rows[0];
      if (!targetRow) {
        // Target user does not exist — return indistinguishable 403
        // per Requirement 2.6.
        await client.query('ROLLBACK');
        return c.json(ROLE_CHANGE_FORBIDDEN.errorBody, ROLE_CHANGE_FORBIDDEN.status);
      }

      const previousRole = targetRow.role;

      // If demoting to 'user', enforce at-least-one-admin invariant.
      if (newRole === 'user' && previousRole === 'admin') {
        const countResult = await client.query<{ cnt: string }>(
          `SELECT count(*) AS cnt FROM users WHERE role = 'admin' AND id <> $1`,
          [targetUserId],
        );
        const remainingAdmins = parseInt(countResult.rows[0]?.cnt ?? '0', 10);
        if (remainingAdmins === 0) {
          // Demotion would leave zero admins — reject per R2.6.
          await client.query('ROLLBACK');
          return c.json(ROLE_CHANGE_FORBIDDEN.errorBody, ROLE_CHANGE_FORBIDDEN.status);
        }
      }

      // Apply the role change.
      await client.query(`UPDATE users SET role = $1 WHERE id = $2`, [newRole, targetUserId]);

      // Write audit log entry within the same transaction.
      await writeAudit(client, {
        actor: { userId: auth.sub },
        target: { userId: targetUserId, resource: `user:${targetUserId}` },
        eventType: 'role_change',
        outcome: 'success',
        metadata: {
          previous_role: previousRole,
          new_role: newRole,
        },
      });

      await client.query('COMMIT');

      return c.json({ ok: true, role: newRole });
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

  // -------------------------------------------------------------------------
  // POST /admin/users/:id/entitlement-adjust
  //
  // Manual session grant/revoke by an Admin. Validates session_delta ∈
  // [-1000, 1000] \ {0} and a non-empty reason note of 1–500 chars.
  // Single transaction: ledger insert + audit insert.
  //
  // Validates: Requirements 6.5, 11.3, 11.4, 11.5.
  // -------------------------------------------------------------------------
  router.post('/admin/users/:id/entitlement-adjust', async (c) => {
    // Inline admin auth gate (same pattern as PATCH /admin/users/:id/role).
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    const targetUserId = c.req.param('id');

    // Validate UUID format for the target user id.
    if (!isValidUuid(targetUserId)) {
      return c.json(
        { error: { code: 'user_not_found', message: 'target user not found' } },
        404,
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

    const parsed = entitlementAdjustBodySchema.safeParse(raw);
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

    const { session_delta, note } = parsed.data;

    // Single transaction: verify user exists, ledger insert, audit insert.
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      // Verify target user exists.
      const userResult = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE id = $1`,
        [targetUserId],
      );

      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return c.json(
          { error: { code: 'user_not_found', message: 'target user not found' } },
          404,
        );
      }

      // Append ledger entry with reason 'admin_adjustment'.
      const ledgerResult = await appendLedgerEntry(client, {
        userId: targetUserId,
        sessionDelta: session_delta,
        lifetimeFlagSet: 'unchanged',
        reason: 'admin_adjustment',
        actingAdminId: auth.sub,
        note,
      });

      // Write audit log entry within the same transaction.
      await writeAudit(client, {
        actor: { userId: auth.sub },
        target: { userId: targetUserId, resource: `user:${targetUserId}` },
        eventType: 'entitlement_adjustment',
        outcome: 'success',
        metadata: {
          session_delta,
          note,
          resulting_session_count: ledgerResult.resultingSessionCount,
          resulting_lifetime_flag: ledgerResult.resultingLifetimeFlag,
        },
      });

      await client.query('COMMIT');

      return c.json({
        ok: true,
        resulting_session_count: ledgerResult.resultingSessionCount,
        resulting_lifetime_flag: ledgerResult.resultingLifetimeFlag,
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors; surface the original below.
      }

      // If the ledger rejected due to insufficient balance, surface as 400.
      if (err instanceof LedgerError && err.code === 'no_sessions_remaining') {
        return c.json(
          {
            error: {
              code: 'no_sessions_remaining',
              message:
                'adjustment would cause negative session count for a non-lifetime user',
            },
          },
          400,
        );
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

/** The indistinguishable 403 response used for all rejection cases. */
const ROLE_CHANGE_FORBIDDEN = {
  status: 403 as const,
  errorBody: {
    error: {
      code: 'role_change_not_permitted',
      message: 'role change not permitted',
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
 * Inline authentication + role gate. Returns the byte-equal 403
 * envelope for every non-admin case so the response is identical
 * regardless of whether the targeted resource exists (R2.3 / R2.6).
 */
async function authenticateAdmin(
  authorization: string | undefined,
): Promise<AdminAuthSuccess | AuthFailure> {
  if (!authorization) return ROLE_CHANGE_FORBIDDEN;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) return ROLE_CHANGE_FORBIDDEN;
  try {
    const claims = await verifyAccess(match[1]!);
    if (claims.role !== 'admin') return ROLE_CHANGE_FORBIDDEN;
    return { sub: claims.sub, role: 'admin', client_id: claims.client_id };
  } catch (err) {
    if (err instanceof JwtError) return ROLE_CHANGE_FORBIDDEN;
    throw err;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}
