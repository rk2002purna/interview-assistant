/**
 * API request logging middleware.
 *
 * Emits exactly one structured JSON line per HTTP request so every API
 * call is captured for operational troubleshooting: which endpoint was
 * hit, the outcome status, how long it took, who made it, and a stable
 * error code when it failed. On EC2 these stdout lines are shipped to
 * CloudWatch Logs by the CloudWatch agent, so the request trail lives in
 * AWS (with a retention policy) and never consumes Neon storage.
 *
 * What is deliberately NOT logged (see `../log/logger.ts` redaction):
 *   - request or response bodies
 *   - request headers (Authorization, Cookie, ...)
 *   - query strings (may carry reset tokens, one-time codes, ...)
 *   - access/refresh tokens or provider keys
 *   - exception messages or stack traces
 *
 * The record carries only low-cardinality, non-secret operational fields:
 *   request_id, method, route (matched template), path (no query string),
 *   status, latency_ms, outcome, actor_user_id, client_id, ip, error_code.
 *
 * Every response is tagged with an `X-Request-Id` header so a user- or
 * client-reported failure can be matched to its exact server-side line.
 *
 * This middleware is registered as the outermost handler in `buildApp`,
 * so it observes CORS preflights, matched routes, 404s, and handlers that
 * throw (which the app-level `onError` converts to a 500). It never throws
 * into the request path: a logging failure must not turn a good response
 * into an error.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { Logger, type LogLevel } from '../log/logger.js';
import { verifyAccess } from '../auth/jwt.js';

/** Context variable published by this middleware for downstream handlers. */
export interface RequestLogVariables {
  /** Correlation id, also emitted as the `X-Request-Id` response header. */
  requestId: string;
}

export interface RequestLoggerOptions {
  /**
   * Logger used to emit records. Defaults to a process-wide structured
   * logger whose minimum level is read once from `LOG_LEVEL` (default
   * `info`). Tests inject a memory-sink logger to assert on records.
   */
  readonly logger?: Logger;
  /**
   * Exact request paths to skip (no record emitted). Defaults to
   * `['/health']` so liveness probes do not flood the log.
   */
  readonly skipPaths?: readonly string[];
  /**
   * Skip CORS preflight (`OPTIONS`) requests. Default `true` to keep the
   * signal-to-noise ratio (and CloudWatch ingestion cost) down.
   */
  readonly skipOptions?: boolean;
  /** Monotonic clock for latency measurement (tests). Default `performance.now`. */
  readonly now?: () => number;
}

const DEFAULT_SKIP_PATHS: readonly string[] = ['/health'];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lazily-created default logger. Kept module-scoped so all requests share
 * one instance (and one resolved level) rather than reconstructing per
 * request.
 */
let defaultLogger: Logger | undefined;

function getDefaultLogger(): Logger {
  if (!defaultLogger) {
    const raw = process.env['LOG_LEVEL'];
    const minLevel: LogLevel =
      raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error'
        ? raw
        : 'info';
    defaultLogger = new Logger({ minLevel });
  }
  return defaultLogger;
}

/**
 * Map an HTTP status to a stable, machine-readable error code. This is a
 * coarse classification derived purely from the status line, never from a
 * response body or exception, so it is always safe to persist.
 */
function statusToErrorCode(status: number): string | null {
  if (status < 400) return null;
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthenticated';
    case 402:
      return 'payment_required';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 405:
      return 'method_not_allowed';
    case 409:
      return 'conflict';
    case 422:
      return 'unprocessable_entity';
    case 426:
      return 'client_upgrade_required';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal_error' : 'client_error';
  }
}

/** Read a context variable without tripping Hono's typed-key constraint. */
function getVar(c: Context, key: string): unknown {
  try {
    return (c.get as unknown as (k: string) => unknown)(key);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort client IP for the log record. Prefers the first hop of
 * `X-Forwarded-For`, then `X-Real-Ip`. Returns `null` when neither is
 * present. Behind the EC2 load balancer / reverse proxy these headers are
 * set by the proxy; treat the value as advisory, not authenticated.
 */
function extractClientIp(c: Context): string | null {
  const xff = c.req.header('X-Forwarded-For');
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header('X-Real-Ip');
  if (typeof real === 'string' && real.length > 0) return real;
  return null;
}

/**
 * Resolve the acting user without ever logging the token itself.
 *
 * Fast path: a downstream auth gate already verified the token and
 * published `userId`/`claims` on the context. Fallback: for routes that
 * authenticate inline (e.g. the admin routers) the context vars are not
 * set, so re-verify the bearer token best-effort. Verification failures
 * yield a `null` actor rather than attributing a spoofable identity.
 */
async function resolveActor(
  c: Context,
): Promise<{ userId: string | null; clientId: string | null }> {
  const ctxUserId = getVar(c, 'userId');
  const ctxClaims = getVar(c, 'claims') as { client_id?: string } | undefined;
  const ctxClientId = getVar(c, 'clientId');
  const headerClientId = c.req.header('X-Client-Id') ?? null;

  if (typeof ctxUserId === 'string' && ctxUserId.length > 0) {
    return {
      userId: ctxUserId,
      clientId:
        ctxClaims?.client_id ??
        (typeof ctxClientId === 'string' ? ctxClientId : headerClientId),
    };
  }

  const authz = c.req.header('Authorization');
  if (typeof authz === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(authz);
    if (match?.[1]) {
      try {
        const claims = await verifyAccess(match[1]);
        return { userId: claims.sub, clientId: claims.client_id };
      } catch {
        // Anonymous, expired, or invalid — leave actor null.
      }
    }
  }

  return {
    userId: null,
    clientId: typeof ctxClientId === 'string' ? ctxClientId : headerClientId,
  };
}

/**
 * Build the request-logging middleware.
 */
export function requestLogger(
  options: RequestLoggerOptions = {},
): MiddlewareHandler {
  const logger = options.logger ?? getDefaultLogger();
  const skipPaths = options.skipPaths ?? DEFAULT_SKIP_PATHS;
  const skipOptions = options.skipOptions ?? true;
  const clock = options.now ?? (() => performance.now());

  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;

    // Correlation id: honor a valid incoming id (from a trusted proxy),
    // otherwise mint one. Reject non-UUID incoming values to bound the
    // field and prevent log injection.
    const incoming = c.req.header('X-Request-Id');
    const requestId =
      incoming && UUID_RE.test(incoming) ? incoming : randomUUID();
    c.set('requestId', requestId);
    // Applies to responses built via c.json/c.text; raw Response returns
    // are patched again after next().
    c.header('X-Request-Id', requestId);

    // Skip health probes and preflights, but still tag them with the id.
    if ((skipOptions && method === 'OPTIONS') || skipPaths.includes(path)) {
      await next();
      try {
        c.res.headers.set('X-Request-Id', requestId);
      } catch {
        // Response headers immutable in some adapters; id is best-effort.
      }
      return;
    }

    const start = clock();
    let threw = false;
    try {
      await next();
    } catch (err) {
      threw = true;
      const latencyMs = Math.max(0, Math.round(clock() - start));
      const actor = await resolveActor(c);
      logger.error('http_request', {
        request_id: requestId,
        method,
        route: null,
        path,
        status: 500,
        latency_ms: latencyMs,
        outcome: 'failure',
        actor_user_id: actor.userId,
        client_id: actor.clientId,
        ip: extractClientIp(c),
        error_code: 'internal_error',
      });
      throw err; // let app-level onError produce the 500 response
    }

    if (threw) return;

    const latencyMs = Math.max(0, Math.round(clock() - start));
    try {
      c.res.headers.set('X-Request-Id', requestId);
    } catch {
      // best-effort
    }

    const status = c.res.status;
    const routePath = c.req.routePath;
    const route = routePath && routePath !== '/*' ? routePath : null;
    const outcome = status >= 400 ? 'failure' : 'success';
    const actor = await resolveActor(c);

    const fields = {
      request_id: requestId,
      method,
      route,
      path,
      status,
      latency_ms: latencyMs,
      outcome,
      actor_user_id: actor.userId,
      client_id: actor.clientId,
      ip: extractClientIp(c),
      error_code: statusToErrorCode(status),
    };

    if (status >= 500) {
      logger.error('http_request', fields);
    } else if (status >= 400) {
      logger.warn('http_request', fields);
    } else {
      logger.info('http_request', fields);
    }
  };
}
