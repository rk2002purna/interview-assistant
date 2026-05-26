import { Hono } from 'hono';
import type { Pool } from 'pg';
import { JwtError, verifyAccess } from '../auth/jwt.js';

/**
 * Admin audit log HTTP routes.
 *
 *   GET /admin/audit-log — paginated, filterable audit log viewer
 *
 * Validates: Requirements 14.4.
 *
 * Returns audit log entries in reverse-chronological order with
 * cursor-based (keyset) pagination. Supports optional filters:
 *   - actor: filter by actor_user_id (UUID)
 *   - target: filter by target_user_id (UUID)
 *   - event_type: filter by event_type (string)
 *   - from / to: date range filter on ts
 *
 * The endpoint is admin-only (role=admin required).
 */

export interface AdminAuditLogRouterDeps {
  /** Postgres pool for read queries. */
  readonly pool: Pool;
}

/** Default page size. */
const DEFAULT_PAGE_SIZE = 50;
/** Maximum allowed page size. */
const MAX_PAGE_SIZE = 200;
/** Minimum allowed page size. */
const MIN_PAGE_SIZE = 1;

/** Shape of an audit_log row returned from the database. */
interface AuditLogRow {
  id: string;
  ts: Date | string;
  actor_user_id: string | null;
  target_user_id: string | null;
  target_resource: string | null;
  event_type: string;
  outcome: string;
  reason_code: string | null;
  metadata: Record<string, unknown>;
}

export function buildAdminAuditLogRouter(deps: AdminAuditLogRouterDeps): Hono {
  const router = new Hono();

  router.get('/admin/audit-log', async (c) => {
    // Inline admin auth gate.
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    // --- Parse and validate query parameters ---
    const cursorParam = c.req.query('cursor');
    const pageSizeParam = c.req.query('page_size');
    const actorParam = c.req.query('actor');
    const targetParam = c.req.query('target');
    const eventTypeParam = c.req.query('event_type');
    const fromParam = c.req.query('from');
    const toParam = c.req.query('to');

    // Parse page_size
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

    // Validate actor UUID if provided
    if (actorParam !== undefined && actorParam !== '' && !isValidUuid(actorParam)) {
      return c.json(
        {
          error: {
            code: 'invalid_filter',
            message: 'actor must be a valid UUID',
          },
        },
        400,
      );
    }

    // Validate target UUID if provided
    if (targetParam !== undefined && targetParam !== '' && !isValidUuid(targetParam)) {
      return c.json(
        {
          error: {
            code: 'invalid_filter',
            message: 'target must be a valid UUID',
          },
        },
        400,
      );
    }

    // Parse from/to dates if provided
    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    if (fromParam !== undefined && fromParam !== '') {
      const parsed = new Date(fromParam);
      if (isNaN(parsed.getTime())) {
        return c.json(
          {
            error: {
              code: 'invalid_filter',
              message: 'invalid from date format',
            },
          },
          400,
        );
      }
      fromDate = parsed;
    }

    if (toParam !== undefined && toParam !== '') {
      const parsed = new Date(toParam);
      if (isNaN(parsed.getTime())) {
        return c.json(
          {
            error: {
              code: 'invalid_filter',
              message: 'invalid to date format',
            },
          },
          400,
        );
      }
      toDate = parsed;
    }

    // Validate: from must be before to when both are provided
    if (fromDate && toDate && fromDate.getTime() >= toDate.getTime()) {
      return c.json(
        {
          error: {
            code: 'invalid_filter',
            message: 'from must be before to',
          },
        },
        400,
      );
    }

    // Validate cursor format (must be a UUID if provided)
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

    // --- Build and execute query ---
    // Fetch page_size + 1 to determine if there are more results.
    const limit = pageSize + 1;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Apply filters
    if (actorParam) {
      conditions.push(`actor_user_id = $${paramIndex}`);
      params.push(actorParam);
      paramIndex++;
    }

    if (targetParam) {
      conditions.push(`target_user_id = $${paramIndex}`);
      params.push(targetParam);
      paramIndex++;
    }

    if (eventTypeParam) {
      conditions.push(`event_type = $${paramIndex}`);
      params.push(eventTypeParam);
      paramIndex++;
    }

    if (fromDate) {
      conditions.push(`ts >= $${paramIndex}`);
      params.push(fromDate.toISOString());
      paramIndex++;
    }

    if (toDate) {
      conditions.push(`ts <= $${paramIndex}`);
      params.push(toDate.toISOString());
      paramIndex++;
    }

    // Cursor-based pagination: use (ts, id) for stable ordering.
    // The cursor is the id of the last item on the previous page.
    // We fetch rows that come after the cursor in reverse-chronological order.
    // We use separate comparisons instead of row-value syntax for broader
    // compatibility (some in-memory Postgres emulators don't support tuple casts).
    if (cursorParam) {
      conditions.push(
        `(ts < (SELECT ts FROM audit_log WHERE id = $${paramIndex}) OR (ts = (SELECT ts FROM audit_log WHERE id = $${paramIndex}) AND id < $${paramIndex}))`,
      );
      params.push(cursorParam);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
      SELECT id, ts, actor_user_id, target_user_id, target_resource,
             event_type, outcome, reason_code, metadata
        FROM audit_log
        ${whereClause}
       ORDER BY ts DESC, id DESC
       LIMIT $${paramIndex}
    `;
    params.push(limit);

    const result = await deps.pool.query<AuditLogRow>(sql, params);
    const rows = result.rows;

    // Determine if there's a next page
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;

    // Build response
    const responseItems = items.map((row) => ({
      id: row.id,
      ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
      actor: row.actor_user_id,
      target: row.target_user_id,
      target_resource: row.target_resource,
      event_type: row.event_type,
      outcome: row.outcome,
      reason_code: row.reason_code,
      metadata: row.metadata,
    }));

    const nextCursor = hasMore ? items[items.length - 1]!.id : null;

    return c.json({
      items: responseItems,
      next_cursor: nextCursor,
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The indistinguishable 403 response used for all non-admin cases. */
const AUDIT_LOG_FORBIDDEN = {
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
  if (!authorization) return AUDIT_LOG_FORBIDDEN;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) return AUDIT_LOG_FORBIDDEN;
  try {
    const claims = await verifyAccess(match[1]!);
    if (claims.role !== 'admin') return AUDIT_LOG_FORBIDDEN;
    return { sub: claims.sub, role: 'admin', client_id: claims.client_id };
  } catch (err) {
    if (err instanceof JwtError) return AUDIT_LOG_FORBIDDEN;
    throw err;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}
