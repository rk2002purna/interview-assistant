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

// ---------------------------------------------------------------------------
// Model analytics (GET /admin/usage/models) types & helpers
// ---------------------------------------------------------------------------

/** A single provider/model pair from the routing config. */
interface RoutingEntry {
  readonly provider: string;
  readonly model: string;
}

/** Shape of the `model_routing` app_config value. */
interface RoutingConfig {
  readonly textPrimary: RoutingEntry;
  readonly textFallback: RoutingEntry;
  readonly visionPrimary: RoutingEntry;
  readonly visionFallback: RoutingEntry;
}

/**
 * Default routing, mirrored from `admin/model-routing-routes.ts`. Used to
 * classify primary vs fallback usage when no config row is present.
 */
const DEFAULT_MODEL_ROUTING: RoutingConfig = {
  textPrimary: { provider: 'gemini', model: 'gemini-flash-latest' },
  textFallback: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  visionPrimary: { provider: 'gemini', model: 'gemini-flash-latest' },
  visionFallback: { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
};

/** Per-model aggregated summary returned by /admin/usage/models. */
interface ModelSummary {
  model_id: string;
  provider: string | null;
  operation_type: string;
  role: 'primary' | 'fallback' | 'unknown';
  total: number;
  success: number;
  failed: number;
}

/** A failed-call breakdown row returned by /admin/usage/models. */
interface ErrorRow {
  model_id: string;
  provider: string | null;
  operation_type: string;
  upstream_http_status: number | null;
  count: number;
  last_seen: string;
}

/**
 * Derive the provider name from a stored `model_id`. The desktop client
 * sends the slug prefixed with the provider (e.g. "groq/llama-3.3-70b"),
 * so the segment before the first "/" is the provider.
 */
function deriveProvider(modelId: string): string | null {
  const slashIdx = modelId.indexOf('/');
  if (slashIdx < 0) return null;
  const prefix = modelId.slice(0, slashIdx).toLowerCase().trim();
  return prefix.length > 0 ? prefix : null;
}

/**
 * Build a normalized lookup set for routing entries so a stored `model_id`
 * can be matched whether it arrives as "provider/model" or bare "model".
 */
function buildModelSlugSet(entries: readonly RoutingEntry[]): Set<string> {
  const set = new Set<string>();
  for (const e of entries) {
    if (!e) continue;
    const model = (e.model ?? '').toLowerCase().trim();
    const provider = (e.provider ?? '').toLowerCase().trim();
    if (model) set.add(model);
    if (provider && model) set.add(`${provider}/${model}`);
  }
  return set;
}

/**
 * Classify a stored `model_id` as the configured primary or fallback model.
 * Comparison is done both on the full slug and on the bare model name so it
 * is robust to whether the provider prefix was included.
 */
function classifyModelRole(
  modelId: string,
  primary: Set<string>,
  fallback: Set<string>,
): 'primary' | 'fallback' | 'unknown' {
  const full = modelId.toLowerCase().trim();
  const slashIdx = full.indexOf('/');
  const bare = slashIdx >= 0 ? full.slice(slashIdx + 1) : full;
  if (fallback.has(full) || fallback.has(bare)) return 'fallback';
  if (primary.has(full) || primary.has(bare)) return 'primary';
  return 'unknown';
}

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

  // -------------------------------------------------------------------------
  // GET /admin/usage/models
  //
  // Admin-only model-level analytics. Surfaces, for the requested time range:
  //   - which AI models users are calling (grouped by model + operation type)
  //   - success vs failed counts per model
  //   - error breakdown by upstream HTTP status (so failures are visible)
  //   - whether requests are hitting the configured primary or fallback model
  //     (fallback is decided client-side; we classify each usage row against
  //      the stored model_routing config to surface fallback activity)
  //
  // Range must be ≤ 366 days. Non-admin callers receive 403 `forbidden_role`.
  // -------------------------------------------------------------------------
  router.get('/admin/usage/models', async (c) => {
    // --- Admin authentication (identical 403 regardless of token validity) ---
    const authHeader = c.req.header('Authorization');
    const match = authHeader ? /^Bearer\s+(\S+)$/i.exec(authHeader) : null;
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
      if (err instanceof JwtError) {
        return c.json(
          { error: { code: 'forbidden_role', message: 'caller does not have the required role' } },
          403,
        );
      }
      throw err;
    }

    // --- Parse and validate query parameters (same rules as /admin/usage) ---
    const now = getNow();
    const fromParam = c.req.query('from');
    const toParam = c.req.query('to');

    let fromDate: Date;
    let toDate: Date;

    if (fromParam) {
      const parsed = new Date(fromParam);
      if (isNaN(parsed.getTime())) {
        return c.json(
          { error: { code: 'invalid_range', message: 'invalid from date format' } },
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
          { error: { code: 'invalid_range', message: 'invalid to date format' } },
          400,
        );
      }
      toDate = parsed;
    } else {
      toDate = now;
    }

    if (fromDate.getTime() >= toDate.getTime()) {
      return c.json(
        { error: { code: 'invalid_range', message: 'from must be before to' } },
        400,
      );
    }

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

    // --- Load model routing config so we can classify primary vs fallback ---
    let routing: RoutingConfig = DEFAULT_MODEL_ROUTING;
    try {
      const cfg = await deps.pool.query<{ value: string }>(
        `SELECT value FROM app_config WHERE key = 'model_routing' LIMIT 1`,
      );
      if (cfg.rows[0]?.value) {
        routing = { ...DEFAULT_MODEL_ROUTING, ...JSON.parse(cfg.rows[0].value) };
      }
    } catch {
      // Fall back to defaults if the config row is missing or malformed.
    }
    const primarySlugs = buildModelSlugSet([routing.textPrimary, routing.visionPrimary]);
    const fallbackSlugs = buildModelSlugSet([routing.textFallback, routing.visionFallback]);

    // --- Aggregate usage by model / operation / status / upstream status ---
    const sql = `
      SELECT model_id,
             operation_type,
             status,
             upstream_http_status,
             COUNT(*)::int AS count,
             MAX(ts)       AS last_seen
        FROM usage
       WHERE ts >= $1
         AND ts <= $2
       GROUP BY model_id, operation_type, status, upstream_http_status
    `;
    const result = await deps.pool.query<{
      model_id: string;
      operation_type: string;
      status: string;
      upstream_http_status: number | null;
      count: number;
      last_seen: Date | string;
    }>(sql, [fromDate.toISOString(), toDate.toISOString()]);

    // Build per-model summaries and an error breakdown.
    const modelMap = new Map<string, ModelSummary>();
    const errors: ErrorRow[] = [];
    let total = 0;
    let totalSuccess = 0;
    let totalFailed = 0;

    for (const row of result.rows) {
      const provider = deriveProvider(row.model_id);
      const role = classifyModelRole(row.model_id, primarySlugs, fallbackSlugs);
      const key = `${row.model_id}__${row.operation_type}`;

      let summary = modelMap.get(key);
      if (!summary) {
        summary = {
          model_id: row.model_id,
          provider,
          operation_type: row.operation_type,
          role,
          total: 0,
          success: 0,
          failed: 0,
        };
        modelMap.set(key, summary);
      }
      summary.total += row.count;
      total += row.count;
      if (row.status === 'success') {
        summary.success += row.count;
        totalSuccess += row.count;
      } else {
        summary.failed += row.count;
        totalFailed += row.count;
        errors.push({
          model_id: row.model_id,
          provider,
          operation_type: row.operation_type,
          upstream_http_status: row.upstream_http_status,
          count: row.count,
          last_seen:
            row.last_seen instanceof Date
              ? row.last_seen.toISOString()
              : new Date(row.last_seen).toISOString(),
        });
      }
    }

    const models = Array.from(modelMap.values()).sort((a, b) => b.total - a.total);
    errors.sort((a, b) => b.count - a.count);

    // Fallback vs primary call volume across all classified rows.
    const fallbackCount = models
      .filter((m) => m.role === 'fallback')
      .reduce((sum, m) => sum + m.total, 0);
    const primaryCount = models
      .filter((m) => m.role === 'primary')
      .reduce((sum, m) => sum + m.total, 0);

    return c.json({
      models,
      errors,
      routing,
      totals: {
        total,
        success: totalSuccess,
        failed: totalFailed,
        primary: primaryCount,
        fallback: fallbackCount,
      },
    });
  });

  return router;
}
