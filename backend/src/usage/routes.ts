/**
 * Usage HTTP routes.
 *
 * Exposes:
 *   `GET /me/usage`    — per Requirements 9.2, 9.3, 9.4
 *   `GET /admin/usage` — per Requirements 9.6, 9.7
 *
 * /me/usage:
 * - Default range: last 30 days
 * - Max range: 92 days
 * - Default page_size: 50, max: 200, min: 1
 * - Reverse-chronological order with cursor-based (keyset) pagination
 * - Returns 400 `invalid_range_or_page_size` for invalid params
 *
 * /admin/usage:
 * - Admin-only (role=admin required, returns 403 for non-admin)
 * - Max range: 366 days
 * - Returns aggregated counts grouped by user_id, operation_type, calendar_day_utc
 * - Returns 400 for invalid range
 *
 * Authentication is performed inline via `verifyAccess` following the
 * same pattern as other routers (e.g. `src/entitlement/routes.ts`).
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { JwtError, verifyAccess } from '../auth/jwt.js';

export interface UsageRouterDeps {
  /** Postgres pool for read queries. */
  readonly pool: Pool;
  /** Clock injection for testing. Defaults to wall clock. */
  readonly now?: () => Date;
}

/** Default range in days when `from`/`to` are omitted. */
const DEFAULT_RANGE_DAYS = 30;
/** Maximum allowed range span in days. */
const MAX_RANGE_DAYS = 92;
/** Default page size. */
const DEFAULT_PAGE_SIZE = 50;
/** Maximum allowed page size. */
const MAX_PAGE_SIZE = 200;
/** Minimum allowed page size. */
const MIN_PAGE_SIZE = 1;
/** Maximum allowed range span in days for admin usage aggregation. */
const ADMIN_MAX_RANGE_DAYS = 366;

/** Shape of a usage row returned from the database. */
interface UsageRow {
  id: string;
  user_id: string;
  session_id: string;
  ts: Date | string;
  operation_type: string;
  model_id: string;
  input_tokens: number | null;
  input_image_count: number | null;
  output_tokens: number | null;
  status: string;
  upstream_http_status: number | null;
  idempotency_key: string | null;
}

/**
 * Build a Hono sub-app exposing usage routes. The returned router
 * is intended to be mounted at the root of the main app.
 */
export function buildUsageRouter(deps: UsageRouterDeps): Hono {
  const router = new Hono();
  const getNow = deps.now ?? (() => new Date());

  router.get('/me/usage', async (c) => {
    // --- Authentication ---
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

    let userId: string;
    try {
      const claims = await verifyAccess(match[1]!);
      userId = claims.sub;
    } catch (err) {
      const code = err instanceof JwtError ? err.code : 'unauthenticated';
      const message = err instanceof Error ? err.message : 'invalid token';
      return c.json({ error: { code, message } }, 401);
    }

    // --- Parse and validate query parameters ---
    const now = getNow();

    const fromParam = c.req.query('from');
    const toParam = c.req.query('to');
    const cursorParam = c.req.query('cursor');
    const pageSizeParam = c.req.query('page_size');

    // Parse page_size
    let pageSize = DEFAULT_PAGE_SIZE;
    if (pageSizeParam !== undefined && pageSizeParam !== '') {
      const parsed = Number(pageSizeParam);
      if (!Number.isInteger(parsed) || parsed < MIN_PAGE_SIZE || parsed > MAX_PAGE_SIZE) {
        return c.json(
          {
            error: {
              code: 'invalid_range_or_page_size',
              message: `page_size must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`,
            },
          },
          400,
        );
      }
      pageSize = parsed;
    }

    // Parse from/to dates
    let fromDate: Date;
    let toDate: Date;

    if (fromParam) {
      const parsed = new Date(fromParam);
      if (isNaN(parsed.getTime())) {
        return c.json(
          {
            error: {
              code: 'invalid_range_or_page_size',
              message: 'invalid from date format',
            },
          },
          400,
        );
      }
      fromDate = parsed;
    } else {
      fromDate = new Date(now.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
    }

    if (toParam) {
      const parsed = new Date(toParam);
      if (isNaN(parsed.getTime())) {
        return c.json(
          {
            error: {
              code: 'invalid_range_or_page_size',
              message: 'invalid to date format',
            },
          },
          400,
        );
      }
      toDate = parsed;
    } else {
      toDate = now;
    }

    // Validate: from must be before to
    if (fromDate.getTime() >= toDate.getTime()) {
      return c.json(
        {
          error: {
            code: 'invalid_range_or_page_size',
            message: 'from must be before to',
          },
        },
        400,
      );
    }

    // Validate: range must not exceed MAX_RANGE_DAYS
    const rangeDays = (toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000);
    if (rangeDays > MAX_RANGE_DAYS) {
      return c.json(
        {
          error: {
            code: 'invalid_range_or_page_size',
            message: `date range must not exceed ${MAX_RANGE_DAYS} days`,
          },
        },
        400,
      );
    }

    // Validate cursor format (must be a UUID if provided)
    if (cursorParam !== undefined && cursorParam !== '') {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(cursorParam)) {
        return c.json(
          {
            error: {
              code: 'invalid_range_or_page_size',
              message: 'cursor must be a valid UUID',
            },
          },
          400,
        );
      }
    }

    // --- Build and execute query ---
    // Fetch page_size + 1 to determine if there are more results.
    const limit = pageSize + 1;
    let sql: string;
    let params: unknown[];

    if (cursorParam) {
      // Keyset pagination: fetch rows with id < cursor
      // We order by ts DESC, id DESC for stable ordering.
      sql = `
        SELECT id, user_id, session_id, ts, operation_type, model_id,
               input_tokens, input_image_count, output_tokens, status,
               upstream_http_status, idempotency_key
          FROM usage
         WHERE user_id = $1
           AND ts >= $2
           AND ts <= $3
           AND id < $4
         ORDER BY ts DESC, id DESC
         LIMIT $5
      `;
      params = [userId, fromDate.toISOString(), toDate.toISOString(), cursorParam, limit];
    } else {
      sql = `
        SELECT id, user_id, session_id, ts, operation_type, model_id,
               input_tokens, input_image_count, output_tokens, status,
               upstream_http_status, idempotency_key
          FROM usage
         WHERE user_id = $1
           AND ts >= $2
           AND ts <= $3
         ORDER BY ts DESC, id DESC
         LIMIT $4
      `;
      params = [userId, fromDate.toISOString(), toDate.toISOString(), limit];
    }

    const result = await deps.pool.query<UsageRow>(sql, params);
    const rows = result.rows;

    // Determine if there's a next page
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;

    // Build response
    const responseItems = items.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
      operation_type: row.operation_type,
      model_id: row.model_id,
      input_tokens: row.input_tokens,
      input_image_count: row.input_image_count,
      output_tokens: row.output_tokens,
      status: row.status,
      upstream_http_status: row.upstream_http_status,
      idempotency_key: row.idempotency_key,
    }));

    const nextCursor = hasMore ? items[items.length - 1]!.id : null;

    return c.json({
      items: responseItems,
      next_cursor: nextCursor,
    });
  });

  // -------------------------------------------------------------------------
  // GET /admin/usage — Requirements 9.6, 9.7
  //
  // Admin-only aggregated usage. Returns totals grouped by user_id,
  // operation_type, and calendar day (UTC). Range must be ≤ 366 days.
  // Non-admin callers receive 403 `forbidden_role`.
  // -------------------------------------------------------------------------
  router.get('/admin/usage', async (c) => {
    // --- Admin authentication (R9.7: non-admin → 403) ---
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      return c.json(
        { error: { code: 'forbidden_role', message: 'caller does not have the required role' } },
        403,
      );
    }
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!match) {
      return c.json(
        { error: { code: 'forbidden_role', message: 'caller does not have the required role' } },
        403,
      );
    }

    try {
      const claims = await verifyAccess(match[1]!);
      if (claims.role !== 'admin') {
        return c.json(
          { error: { code: 'forbidden_role', message: 'caller does not have the required role' } },
          403,
        );
      }
    } catch (err) {
      // Per R2.3: identical 403 regardless of token validity for admin endpoints
      if (err instanceof JwtError) {
        return c.json(
          { error: { code: 'forbidden_role', message: 'caller does not have the required role' } },
          403,
        );
      }
      throw err;
    }

    // --- Parse and validate query parameters ---
    const now = getNow();
    const fromParam = c.req.query('from');
    const toParam = c.req.query('to');

    let fromDate: Date;
    let toDate: Date;

    if (fromParam) {
      const parsed = new Date(fromParam);
      if (isNaN(parsed.getTime())) {
        return c.json(
          {
            error: {
              code: 'invalid_range',
              message: 'invalid from date format',
            },
          },
          400,
        );
      }
      fromDate = parsed;
    } else {
      // Default to last 30 days if not specified
      fromDate = new Date(now.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
    }

    if (toParam) {
      const parsed = new Date(toParam);
      if (isNaN(parsed.getTime())) {
        return c.json(
          {
            error: {
              code: 'invalid_range',
              message: 'invalid to date format',
            },
          },
          400,
        );
      }
      toDate = parsed;
    } else {
      toDate = now;
    }

    // Validate: from must be before to
    if (fromDate.getTime() >= toDate.getTime()) {
      return c.json(
        {
          error: {
            code: 'invalid_range',
            message: 'from must be before to',
          },
        },
        400,
      );
    }

    // Validate: range must not exceed ADMIN_MAX_RANGE_DAYS (366)
    const rangeDays = (toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000);
    if (rangeDays > ADMIN_MAX_RANGE_DAYS) {
      return c.json(
        {
          error: {
            code: 'invalid_range',
            message: `date range must not exceed ${ADMIN_MAX_RANGE_DAYS} days`,
          },
        },
        400,
      );
    }

    // --- Execute aggregation query ---
    // GROUP BY user_id, operation_type, calendar_day_utc per R9.6
    const sql = `
      SELECT user_id,
             operation_type,
             (ts AT TIME ZONE 'UTC')::date AS calendar_day_utc,
             COUNT(*)::int AS operation_count
        FROM usage
       WHERE ts >= $1
         AND ts <= $2
       GROUP BY user_id, operation_type, (ts AT TIME ZONE 'UTC')::date
       ORDER BY calendar_day_utc DESC, user_id, operation_type
    `;
    const params = [fromDate.toISOString(), toDate.toISOString()];

    const result = await deps.pool.query<{
      user_id: string;
      operation_type: string;
      calendar_day_utc: Date | string;
      operation_count: number;
    }>(sql, params);

    const items = result.rows.map((row) => ({
      user_id: row.user_id,
      operation_type: row.operation_type,
      calendar_day_utc:
        row.calendar_day_utc instanceof Date
          ? row.calendar_day_utc.toISOString().slice(0, 10)
          : String(row.calendar_day_utc).slice(0, 10),
      operation_count: row.operation_count,
    }));

    return c.json({ items });
  });

  return router;
}
