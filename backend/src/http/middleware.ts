/**
 * HTTP middleware chain for the Backend API.
 *
 * The chain shape (and the order in which `buildApp` mounts these
 * pieces) is fixed by the design's cross-cutting middleware diagram:
 *
 *     X-Client-Id  ->  X-Build-Version  ->  JWT verify (non-public)
 *       ->  Role gate (admin routes only)  ->  Rate limit
 *
 * Each function in this file produces a single Hono `MiddlewareHandler`
 * that owns one of those stages. They are split rather than combined so
 * that:
 *
 *   - Public routes (`/auth/*`, `/packs`, `/webhooks/razorpay`,
 *     `/health`) can mount only the headers gates and skip JWT.
 *   - Admin routes can layer `requireRole('admin')` on top of the same
 *     `jwtAuth` instance used by user routes.
 *   - Tests can exercise each gate in isolation against a Hono app
 *     without standing up the full route table.
 *
 * Every gate that rejects a request returns the uniform error envelope
 * documented in the design's "Backend Error Handling Patterns" section:
 *
 *     { "error": { "code": "<stable_code>", "message": "<human>",
 *                  "details"?: { ... } } }
 *
 * No gate mutates persistent state on rejection: gating happens before
 * the route handler runs, so "no state change" (Properties 22, 14) is
 * structurally guaranteed. The one exception is the optional
 * `onClientIdMismatch` callback wired into `jwtAuth`, which the caller
 * uses to revoke both tokens and append an `audit_log` row in the same
 * transaction (Requirement 13.5); that side effect is part of the
 * rejection itself, not part of any handler.
 *
 * Design references:
 *   - Requirements 2.2, 2.3 (admin role gate, indistinguishable 403)
 *   - Requirements 12.3 (rate-limit -> 429 with Retry-After)
 *   - Requirements 13.1, 13.2 (X-Client-Id presence + UUIDv4 format)
 *   - Requirements 13.5 (client_id mismatch -> 401 + audit + revoke)
 *   - Requirements 13.6 (X-Build-Version below minimum -> 426)
 */

import type { Context, MiddlewareHandler } from 'hono';
import {
  verifyAccess,
  type AccessTokenClaims,
  type Role,
  JwtError,
  TokenExpiredError,
} from '../auth/jwt.js';

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * Uniform error response shape returned by every gate on rejection.
 *
 * `code` is a stable machine-readable identifier from the design's
 * Error Code table (e.g. `missing_client_id`, `forbidden_role`). The
 * `message` is human-readable and safe to surface in clients. `details`
 * is reserved for structured supplementary information such as
 * `retry_after` on rate-limit responses or `min_build_version` on 426.
 */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

/**
 * Build a JSON `Response` carrying an error envelope.
 *
 * Returning a raw `Response` (rather than going through `c.json`)
 * sidesteps Hono's typed status union, which restricts custom statuses
 * like 426 in some versions, and gives us direct control over the
 * `Retry-After` header on 429 responses.
 */
function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const envelope: ErrorEnvelope = {
    error: details === undefined ? { code, message } : { code, message, details },
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  }
  return new Response(JSON.stringify(envelope), { status, headers });
}

// ---------------------------------------------------------------------------
// Context variable typing
// ---------------------------------------------------------------------------

/**
 * Variables published on the Hono context by middlewares in this file.
 * Handlers can read them via `c.get('claims')` / `c.get('userId')`
 * etc. The map is intentionally narrow so handlers can rely on
 * presence after the corresponding gate has run.
 */
export interface MiddlewareVariables {
  /** v4 UUID extracted from `X-Client-Id`. Set by `clientIdGate`. */
  clientId: string;
  /** Raw `X-Build-Version` header value. Set by `buildVersionGate`. */
  buildVersion: string;
  /** Verified access-token claims. Set by `jwtAuth`. */
  claims: AccessTokenClaims;
  /** Convenience aliases of `claims.sub` / `claims.role`. */
  userId: string;
  role: Role;
}

type MiddlewareContext = Context<{ Variables: MiddlewareVariables }>;
type Handler = MiddlewareHandler<{ Variables: MiddlewareVariables }>;

// ---------------------------------------------------------------------------
// 1. X-Client-Id gate (Requirements 13.1, 13.2)
// ---------------------------------------------------------------------------

/**
 * RFC 4122 v4 UUID. Case-insensitive; matches both lower- and upper-
 * case hex digits because the spec allows clients to choose their
 * preferred case (Requirement 13.1: "version 4 UUID" without further
 * normalization).
 */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Reject any request that does not present a valid v4 UUID
 * `X-Client-Id` header. On success, publishes the value as
 * `c.var.clientId` for downstream gates.
 */
export function clientIdGate(): Handler {
  return async (c, next) => {
    const value = c.req.header('X-Client-Id');
    if (typeof value !== 'string' || value.length === 0) {
      return errorResponse(
        400,
        'missing_client_id',
        'X-Client-Id header is required',
      );
    }
    if (!UUID_V4_RE.test(value)) {
      return errorResponse(
        400,
        'missing_client_id',
        'X-Client-Id header is not a valid v4 UUID',
      );
    }
    c.set('clientId', value);
    await next();
  };
}

// ---------------------------------------------------------------------------
// 2. X-Build-Version gate (Requirement 13.6)
// ---------------------------------------------------------------------------

type SemverTuple = readonly [number, number, number];

/**
 * Parse a semver `MAJOR.MINOR.PATCH` prefix, ignoring any pre-release
 * or build metadata suffix. Returns `null` when the input is not a
 * recognizable semver. Pre-release suffixes are intentionally ignored
 * (`1.2.3-alpha` is treated as `1.2.3`) because the design only
 * compares numeric versions and clients in the wild often embed
 * channel suffixes.
 */
function parseSemver(value: string): SemverTuple | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  ) {
    return null;
  }
  return [major, minor, patch] as const;
}

function compareSemver(a: SemverTuple, b: SemverTuple): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

export interface BuildVersionGateOptions {
  /**
   * Minimum supported build version. When omitted, the gate reads
   * `process.env.MIN_BUILD_VERSION` once per request. Tests prefer the
   * explicit form so they can vary the threshold without touching the
   * environment.
   */
  readonly minVersion?: string;
}

/**
 * Reject any request whose `X-Build-Version` header is missing or
 * whose semver value compares below the configured minimum. Successful
 * requests publish the raw header on `c.var.buildVersion`.
 */
export function buildVersionGate(options: BuildVersionGateOptions = {}): Handler {
  return async (c, next) => {
    const minRaw =
      options.minVersion ?? process.env['MIN_BUILD_VERSION'] ?? '0.0.0';
    const minParsed = parseSemver(minRaw);
    if (!minParsed) {
      throw new Error(
        `MIN_BUILD_VERSION is not a valid semver: ${JSON.stringify(minRaw)}`,
      );
    }

    const value = c.req.header('X-Build-Version');
    if (typeof value !== 'string' || value.length === 0) {
      return errorResponse(
        426,
        'client_upgrade_required',
        'X-Build-Version header is required',
        { min_build_version: minRaw },
      );
    }
    const parsed = parseSemver(value);
    if (!parsed || compareSemver(parsed, minParsed) < 0) {
      return errorResponse(
        426,
        'client_upgrade_required',
        'client build version is below the minimum supported version',
        { min_build_version: minRaw },
      );
    }
    c.set('buildVersion', value);
    await next();
  };
}

// ---------------------------------------------------------------------------
// 3. JWT auth + client_id match (Requirements 7.2, 13.5)
// ---------------------------------------------------------------------------

/**
 * Side-effect callback invoked exactly once when a Session_Token's
 * `client_id` claim disagrees with the value presented in the
 * `X-Client-Id` header. Implementations are expected to:
 *
 *   1. Open a transaction.
 *   2. Revoke the refresh token row matching `(userId, jti)` (or all
 *      refresh tokens for the user; the design permits both).
 *   3. Append an `audit_log` row with `reason_code = 'client_id_mismatch'`
 *      including `presentingClientId` and `issuingClientId` in the
 *      metadata (Requirement 13.5).
 *   4. Commit.
 *
 * The middleware awaits the callback before returning the 401 so the
 * audit row commits in the same logical request as the rejection.
 * Errors thrown by the handler are logged by the implementation but
 * do not change the 401 response: rejecting the request is the
 * primary obligation; persisting the audit is best-effort retried by
 * the implementation if needed.
 */
export type ClientIdMismatchHandler = (input: {
  readonly userId: string;
  readonly presentingClientId: string;
  readonly issuingClientId: string;
  readonly jti: string;
}) => Promise<void>;

export interface JwtAuthOptions {
  readonly onClientIdMismatch?: ClientIdMismatchHandler;
}

/**
 * Verify the `Authorization: Bearer <token>` header, populate
 * `c.var.claims`, `c.var.userId`, `c.var.role`, and reject mismatches
 * between the verified `client_id` claim and the value already
 * accepted by `clientIdGate`. Must run after `clientIdGate`; if it
 * does not, mismatch detection silently degrades because the comparand
 * falls back to whatever the client sends on this single request.
 */
export function jwtAuth(options: JwtAuthOptions = {}): Handler {
  return async (c, next) => {
    const authz = c.req.header('Authorization');
    if (typeof authz !== 'string' || !authz.startsWith('Bearer ')) {
      return errorResponse(
        401,
        'unauthenticated',
        'missing or malformed Authorization header',
      );
    }
    const token = authz.slice('Bearer '.length).trim();
    if (token.length === 0) {
      return errorResponse(401, 'unauthenticated', 'bearer token is empty');
    }

    let claims: AccessTokenClaims;
    let jti: string | undefined;
    try {
      claims = await verifyAccess(token);
      // The verified payload is opaque to verifyAccess (it returns the
      // identity claims only) so re-decode for jti when we need to
      // audit a mismatch. Decoding without verifying is safe here
      // because `verifyAccess` already validated the signature.
      jti = decodeJtiUnsafe(token);
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        return errorResponse(401, 'unauthenticated', 'token expired');
      }
      if (err instanceof JwtError) {
        return errorResponse(401, 'unauthenticated', 'invalid token');
      }
      throw err;
    }

    // `clientIdGate` runs before this middleware in the canonical chain
    // and writes the validated header to `c.var.clientId`. Falling back
    // to the raw header keeps the middleware self-contained when used
    // without `clientIdGate` (still safe: the value will not match a
    // different `client_id` claim, so the rejection still fires).
    const presenting =
      (c.get('clientId') as string | undefined) ??
      c.req.header('X-Client-Id') ??
      '';
    if (presenting !== claims.client_id) {
      if (options.onClientIdMismatch) {
        try {
          await options.onClientIdMismatch({
            userId: claims.sub,
            presentingClientId: presenting,
            issuingClientId: claims.client_id,
            jti: jti ?? '',
          });
        } catch {
          // Continue with the rejection; the side-effect handler is
          // responsible for its own logging and retries.
        }
      }
      return errorResponse(
        401,
        'client_id_mismatch',
        'session token client_id does not match X-Client-Id',
      );
    }

    c.set('claims', claims);
    c.set('userId', claims.sub);
    c.set('role', claims.role);
    await next();
  };
}

/**
 * Best-effort `jti` decode for already-verified tokens. We decode the
 * payload segment as base64url JSON without re-verifying because the
 * caller has just succeeded a `verifyAccess` over the same string.
 * Returns `undefined` if the payload doesn't carry a string `jti`.
 */
function decodeJtiUnsafe(token: string): string | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const payloadSegment = parts[1];
  if (!payloadSegment) return undefined;
  try {
    const padded = payloadSegment + '='.repeat((4 - (payloadSegment.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    const obj = JSON.parse(json) as { jti?: unknown };
    return typeof obj.jti === 'string' ? obj.jti : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 4. Role gate (Requirements 2.2, 2.3)
// ---------------------------------------------------------------------------

/**
 * Reject the request unless the verified token's role claim equals
 * `required`. Must run after `jwtAuth`. Returns the byte-equal 403
 * `forbidden_role` envelope regardless of whether the underlying
 * resource exists, satisfying the indistinguishability obligation in
 * Requirement 2.3 (and Property 14).
 */
export function requireRole(required: Role): Handler {
  return async (c, next) => {
    const claims = c.get('claims') as AccessTokenClaims | undefined;
    if (!claims || claims.role !== required) {
      return errorResponse(
        403,
        'forbidden_role',
        'caller does not have the required role',
      );
    }
    await next();
  };
}

// ---------------------------------------------------------------------------
// 5. Rate limit (Requirement 12.3)
// ---------------------------------------------------------------------------

/**
 * Categories tracked by the rate-limit store. Mirrors the CHECK
 * constraint on `rate_events.kind` in migration 0006 so any kind we
 * surface here is one the limiter can actually persist.
 */
export type RateLimitKind =
  | 'ai_op'
  | 'session_start'
  | 'login_attempt'
  | 'login_success';

/**
 * Per-call decision returned by the limiter. `retryAfterSeconds` is
 * required when `allowed` is false; the middleware surfaces it both
 * in the `Retry-After` HTTP header and in `error.details.retry_after`.
 * When the limiter cannot estimate a wait time (rare: usually because
 * the window is empty), it should return `1`.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

/**
 * Dependency injected into `rateLimit`. Task 11.1 will produce a
 * Postgres-backed implementation reading from `rate_events`; this
 * interface is the seam between that implementation and the
 * middleware so the chain can be unit-tested in isolation today.
 *
 * The contract:
 *   - `check` is called once per gated request. Implementations both
 *     record the event and decide whether the request is allowed; the
 *     middleware does not split the read and write phases.
 *   - When `allowed` is true the request proceeds.
 *   - When `allowed` is false the middleware returns 429 immediately;
 *     no further state changes occur at the application layer.
 */
export interface RateLimiter {
  check(input: {
    readonly userId: string;
    readonly kind: RateLimitKind;
    readonly ip?: string;
  }): Promise<RateLimitDecision>;
}

export interface RateLimitOptions {
  readonly limiter: RateLimiter;
  readonly kind: RateLimitKind;
}

/**
 * Reject the request when `limiter.check` denies it. Reads `userId`
 * from the context (set by `jwtAuth`); if no user is present the
 * middleware fails closed with an unauthenticated response rather than
 * silently bypassing the limiter, which would otherwise let unsigned
 * requests through any limit.
 */
export function rateLimit(options: RateLimitOptions): Handler {
  return async (c, next) => {
    const userId = c.get('userId') as string | undefined;
    if (!userId) {
      return errorResponse(
        401,
        'unauthenticated',
        'rate limit requires an authenticated request',
      );
    }
    const ip = extractClientIp(c);
    const decision = await options.limiter.check({
      userId,
      kind: options.kind,
      ...(ip !== undefined ? { ip } : {}),
    });
    if (!decision.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil(decision.retryAfterSeconds ?? 1),
      );
      return errorResponse(
        429,
        'rate_limited',
        'rate limit exceeded',
        { retry_after: retryAfter },
        { 'Retry-After': String(retryAfter) },
      );
    }
    await next();
  };
}

/**
 * Extract a best-effort client IP for rate-limit accounting. Prefers
 * `X-Forwarded-For` (first hop) when present; falls back to
 * `X-Real-Ip`. Returns `undefined` when neither header is set; the
 * limiter is responsible for tolerating missing IPs (the design's
 * `rate_events.ip` column is nullable).
 */
function extractClientIp(c: MiddlewareContext): string | undefined {
  const xff = c.req.header('X-Forwarded-For');
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const real = c.req.header('X-Real-Ip');
  if (typeof real === 'string' && real.length > 0) return real;
  return undefined;
}
