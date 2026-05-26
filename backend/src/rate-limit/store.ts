/**
 * Rolling-window rate limiter store.
 *
 * Implements Requirement 12.1, 12.2, 12.3 and the
 * "Rate limiting in Postgres" architectural decision in design.md:
 *
 *   "Rate limiting in Postgres using a small `rate_events` table with
 *    rolling windows computed by `count(*) WHERE ts > now() - interval`
 *    plus an index on `(user_id, ts)`."
 *
 * The module exports three things, layered:
 *
 *   1. {@link RateLimitStore} - a narrow seam describing "record one
 *      event for a (user, kind) pair, then return the count and the
 *      oldest timestamp inside one or more rolling windows ending at
 *      `now`". Pure mechanics: knows nothing about default limits.
 *
 *   2. {@link PostgresRateLimitStore} - the production implementation
 *      backed by the `rate_events` table created in migration 0006.
 *      Inserts then counts in a single short pool checkout; the table's
 *      `(user_id, kind, ts DESC)` index makes both operations index-only.
 *
 *   3. {@link PostgresRateLimiter} - adapts a `RateLimitStore` to the
 *      {@link RateLimiter} contract consumed by the HTTP middleware. It
 *      owns the default windows from Requirement 12.1/12.2 (60/min,
 *      1000/day for AI; 5/hour for session_start) and computes the
 *      `Retry-After` value from the oldest counted event per
 *      Requirement 12.3.
 *
 * Per-user overrides (Requirement 12.4, task 11.3) layer on top by
 * supplying a custom `RateLimitConfig` per request; this module does
 * not read `rate_limit_overrides` directly so the override path can be
 * added without changing the store contract.
 *
 * Insert-then-count semantics
 * ---------------------------
 *
 * The store inserts the event *before* counting. This matches Property
 * 19's "the (k+1)-th request ... receives HTTP 429": the rejected
 * request itself is part of the count that decides its own fate, which
 * is the simplest formulation that still keeps a flooding attacker
 * rate-limited (their rejected requests continue to advance the
 * rolling window). Requirement 12.3 explicitly says rate-limited
 * requests "SHALL NOT consume Entitlement or forward the request to
 * the upstream provider" - both are guaranteed by the middleware,
 * which short-circuits before the route handler runs; counting the
 * event itself does not affect either entitlement or upstream calls.
 *
 * Validates: Requirements 12.1, 12.2, 12.3.
 */

import type { Pool, PoolClient } from 'pg';
import type { RateLimitKind, RateLimiter, RateLimitDecision } from '../http/middleware.js';

// ---------------------------------------------------------------------------
// Window descriptor
// ---------------------------------------------------------------------------

/**
 * A single rolling-window rate-limit rule.
 *
 *   - `windowSeconds`: width of the rolling window in seconds. Must be
 *     a positive integer; the design's largest documented window is
 *     86_400 seconds (24 hours, AI per-day cap).
 *   - `limit`: the maximum number of events of the corresponding kind
 *     allowed inside the window. A non-negative integer; `0` means
 *     "every request is rejected" and is occasionally useful for
 *     emergency lockdown via overrides (Requirement 12.4 permits 0).
 *
 * Both fields are validated by {@link assertValidWindow} when a
 * configuration is installed.
 */
export interface RateLimitWindow {
  readonly windowSeconds: number;
  readonly limit: number;
}

/**
 * One window's view of the user's recent activity, returned by the
 * store after recording the new event. `count` includes the row that
 * was just inserted (insert-then-count). `oldestTs` is the timestamp
 * of the oldest event still inside the window, or `null` only when no
 * event matches the window (which cannot happen post-insert; included
 * defensively for empty-window callers in tests).
 */
export interface RateLimitObservation {
  readonly window: RateLimitWindow;
  readonly count: number;
  readonly oldestTs: Date | null;
}

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/**
 * Input to {@link RateLimitStore.recordAndCount}. The same `now` value
 * is used both for the inserted row's timestamp and for computing each
 * window's cutoff `now - windowSeconds`. Callers that want the server
 * clock to drive the timestamp can pass `new Date()`; tests inject a
 * deterministic clock.
 */
export interface RecordAndCountInput {
  readonly userId: string;
  readonly kind: RateLimitKind;
  /** Optional client IP recorded alongside the event (used by R12.5). */
  readonly ip?: string | null;
  /** Wall-clock `now` used for the insert and for window cutoffs. */
  readonly now: Date;
  /** Rolling windows to evaluate. May be empty (the call still inserts). */
  readonly windows: ReadonlyArray<RateLimitWindow>;
}

/**
 * Narrow seam between the rate-limit middleware and the persistence
 * layer. Production code wires {@link PostgresRateLimitStore}; tests
 * can supply an in-memory implementation.
 */
export interface RateLimitStore {
  /**
   * Record one event for `(userId, kind)` at `now` and return one
   * observation per requested window. Implementations MUST count the
   * just-inserted row (insert-then-count) so the (k+1)-th call
   * deterministically sees `count = limit + 1` when `limit` events
   * already exist inside the window.
   */
  recordAndCount(input: RecordAndCountInput): Promise<ReadonlyArray<RateLimitObservation>>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

/**
 * Postgres-backed {@link RateLimitStore} implementation backed by the
 * `rate_events` table from migration 0006. Each `recordAndCount` call
 * checks out a single client, performs `INSERT ... ON CONFLICT DO
 * NOTHING` followed by one count query per window, and releases the
 * client.
 *
 * The `ON CONFLICT (user_id, ts, kind) DO NOTHING` clause defends
 * against the rare collision of two events with byte-identical
 * timestamps (the schema's PK `(user_id, ts, kind)` would otherwise
 * raise a unique-violation). When a conflict occurs the row already
 * present is what gets counted, which is the desired behavior: from
 * the limiter's perspective both calls happened "at the same instant",
 * and only one event needs to be persisted to record that.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async recordAndCount(input: RecordAndCountInput): Promise<ReadonlyArray<RateLimitObservation>> {
    assertValidNow(input.now);
    for (const w of input.windows) assertValidWindow(w);

    const client = await this.pool.connect();
    try {
      return await runRecordAndCount(client, input);
    } finally {
      client.release();
    }
  }
}

/**
 * Inner SQL routine, exported for testing against a checked-out
 * client (e.g. when composing with another transaction). Production
 * callers go through {@link PostgresRateLimitStore.recordAndCount}.
 */
export async function runRecordAndCount(
  client: PoolClient,
  input: RecordAndCountInput,
): Promise<ReadonlyArray<RateLimitObservation>> {
  const { userId, kind, ip, now, windows } = input;
  const tsIso = now.toISOString();

  // Insert. ON CONFLICT DO NOTHING tolerates the (extremely rare)
  // duplicate-timestamp collision; the existing row already covers
  // the event for counting purposes.
  await client.query(
    `INSERT INTO rate_events (user_id, ts, kind, ip)
       VALUES ($1, $2::timestamptz, $3, $4)
     ON CONFLICT (user_id, ts, kind) DO NOTHING`,
    [userId, tsIso, kind, ip ?? null],
  );

  if (windows.length === 0) return [];

  const observations: RateLimitObservation[] = [];
  for (const w of windows) {
    // Cutoff is computed in JS so the SQL is a simple parameterized
    // comparison (`ts > $3`), which pg-mem and Postgres both index
    // against `(user_id, kind, ts DESC)` from migration 0006.
    const cutoffIso = new Date(now.getTime() - w.windowSeconds * 1000).toISOString();
    const res = await client.query<{ c: number | string; oldest: string | null }>(
      `SELECT count(*)::int AS c, MIN(ts) AS oldest
         FROM rate_events
        WHERE user_id = $1
          AND kind    = $2
          AND ts      > $3::timestamptz`,
      [userId, kind, cutoffIso],
    );
    const row = res.rows[0];
    const count = row ? Number(row.c) : 0;
    const oldestTs = row && row.oldest ? new Date(row.oldest) : null;
    observations.push({ window: w, count, oldestTs });
  }
  return observations;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Per-kind rolling-window configuration. Each kind may carry zero or
 * more windows; the limiter rejects a request when *any* window's
 * count strictly exceeds its `limit` after the insert.
 *
 * The default values mirror Requirements 12.1 and 12.2 verbatim:
 *
 *   - `ai_op`        : 60 events / 60 s     AND 1000 events / 86_400 s
 *   - `session_start`:  5 events / 3_600 s
 *   - `login_attempt`:  unlimited (handled by the lockout state
 *                       machine in `Auth_Service`, Requirement 1.5).
 *   - `login_success`:  unlimited (the suspicious-velocity audit in
 *                       Requirement 12.5 lives in the auth path, not
 *                       this gate; this kind is included so callers
 *                       may still record events for that detector).
 */
export interface RateLimitConfig {
  readonly ai_op: ReadonlyArray<RateLimitWindow>;
  readonly session_start: ReadonlyArray<RateLimitWindow>;
  readonly login_attempt: ReadonlyArray<RateLimitWindow>;
  readonly login_success: ReadonlyArray<RateLimitWindow>;
}

/** Default rate-limit configuration per Requirements 12.1 and 12.2. */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = Object.freeze({
  ai_op: Object.freeze([
    Object.freeze({ windowSeconds: 60, limit: 60 }),
    Object.freeze({ windowSeconds: 86_400, limit: 1000 }),
  ]) as ReadonlyArray<RateLimitWindow>,
  session_start: Object.freeze([
    Object.freeze({ windowSeconds: 3600, limit: 5 }),
  ]) as ReadonlyArray<RateLimitWindow>,
  login_attempt: Object.freeze([]) as ReadonlyArray<RateLimitWindow>,
  login_success: Object.freeze([]) as ReadonlyArray<RateLimitWindow>,
});

/**
 * Maximum value the limiter will surface as `Retry-After`, in
 * seconds. Caps the value at 86_400 (24 hours) per Requirement 12.3
 * and Property 19 ("integer in `[1, 86400]`").
 */
export const MAX_RETRY_AFTER_SECONDS = 86_400;

// ---------------------------------------------------------------------------
// Limiter
// ---------------------------------------------------------------------------

export interface PostgresRateLimiterOptions {
  readonly store: RateLimitStore;
  /**
   * Per-kind configuration. Defaults to {@link DEFAULT_RATE_LIMITS}.
   * Tests and the override path (task 11.3) supply alternate configs.
   */
  readonly config?: RateLimitConfig;
  /**
   * Clock injection. Defaults to wall clock. The same instant is used
   * for both the inserted row and the window cutoffs so the (k+1)-th
   * request sees the same view of "now" the store does.
   */
  readonly now?: () => Date;
}

/**
 * {@link RateLimiter} implementation that wraps a {@link RateLimitStore}.
 *
 * The implementation is intentionally thin: every decision is derived
 * mechanically from the store's observations using
 * {@link computeDecision}. That keeps the policy (windows, limits,
 * Retry-After arithmetic) outside Postgres and lets the property test
 * (task 11.2) drive the limiter via an in-memory store.
 */
export class PostgresRateLimiter implements RateLimiter {
  private readonly store: RateLimitStore;
  private readonly config: RateLimitConfig;
  private readonly now: () => Date;

  constructor(options: PostgresRateLimiterOptions) {
    if (!options.store) {
      throw new Error('PostgresRateLimiter: store is required');
    }
    const config = options.config ?? DEFAULT_RATE_LIMITS;
    for (const kind of Object.keys(config) as ReadonlyArray<RateLimitKind>) {
      for (const w of config[kind]) assertValidWindow(w);
    }
    this.store = options.store;
    this.config = config;
    this.now = options.now ?? (() => new Date());
  }

  async check(input: {
    readonly userId: string;
    readonly kind: RateLimitKind;
    readonly ip?: string;
  }): Promise<RateLimitDecision> {
    const windows = this.config[input.kind];
    const now = this.now();

    // Even when `windows` is empty we still record the event: the
    // detectors that care about login-velocity (R12.5) and the
    // pruning/aggregation jobs read `rate_events` directly.
    const observations = await this.store.recordAndCount({
      userId: input.userId,
      kind: input.kind,
      ip: input.ip ?? null,
      now,
      windows,
    });

    return computeDecision(now, observations);
  }
}

/**
 * Pure decision function. Given the current time and the observations
 * returned by the store, decide whether the request is allowed and,
 * when it is not, how many seconds remain until the oldest counted
 * event leaves its window.
 *
 * When multiple windows are exceeded simultaneously (rare, but possible
 * when both the per-minute and per-day caps are tight) the limiter
 * returns the *largest* Retry-After across them so a single retry by
 * the client clears every cap.
 */
export function computeDecision(
  now: Date,
  observations: ReadonlyArray<RateLimitObservation>,
): RateLimitDecision {
  let worst: number | null = null;
  for (const obs of observations) {
    if (obs.count <= obs.window.limit) continue;
    const retry = retryAfterSeconds(now, obs);
    if (worst === null || retry > worst) worst = retry;
  }
  if (worst === null) return { allowed: true };
  return { allowed: false, retryAfterSeconds: worst };
}

/**
 * Compute the `Retry-After` integer for a single exceeded window.
 *
 * "the time remaining until the oldest counted request in the window
 * expires" (Requirement 12.3): the oldest event leaves the window at
 * `oldestTs + windowSeconds`. We subtract `now`, divide by 1000, take
 * the ceiling, then clamp into `[1, MAX_RETRY_AFTER_SECONDS]` per
 * Property 19's integer range. When `oldestTs` is missing (impossible
 * post-insert; defensive) we return `1` so the caller still sends a
 * Retry-After.
 */
function retryAfterSeconds(now: Date, obs: RateLimitObservation): number {
  if (!obs.oldestTs) return 1;
  const leaveMs = obs.oldestTs.getTime() + obs.window.windowSeconds * 1000;
  const remainingSeconds = Math.ceil((leaveMs - now.getTime()) / 1000);
  if (!Number.isFinite(remainingSeconds)) return 1;
  if (remainingSeconds < 1) return 1;
  if (remainingSeconds > MAX_RETRY_AFTER_SECONDS) return MAX_RETRY_AFTER_SECONDS;
  return remainingSeconds;
}

// ---------------------------------------------------------------------------
// Override-aware limiter (Requirement 12.4, task 11.3)
// ---------------------------------------------------------------------------

/**
 * Per-user override row shape as stored in `rate_limit_overrides`.
 * NULL values mean "use default".
 */
export interface RateLimitOverrideRow {
  readonly ai_per_min: number | null;
  readonly ai_per_day: number | null;
  readonly session_per_hour: number | null;
}

/**
 * Resolves per-user rate-limit overrides. The production implementation
 * reads from the `rate_limit_overrides` table; tests can supply a stub.
 */
export interface RateLimitOverrideResolver {
  getOverrides(userId: string): Promise<RateLimitOverrideRow | null>;
}

/**
 * Postgres-backed override resolver that reads from `rate_limit_overrides`.
 */
export class PostgresOverrideResolver implements RateLimitOverrideResolver {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async getOverrides(userId: string): Promise<RateLimitOverrideRow | null> {
    const result = await this.pool.query<RateLimitOverrideRow>(
      `SELECT ai_per_min, ai_per_day, session_per_hour
         FROM rate_limit_overrides
        WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  }
}

export interface OverrideAwareRateLimiterOptions {
  readonly store: RateLimitStore;
  readonly overrideResolver: RateLimitOverrideResolver;
  /** Defaults to {@link DEFAULT_RATE_LIMITS}. */
  readonly defaults?: RateLimitConfig;
  /** Clock injection. Defaults to wall clock. */
  readonly now?: () => Date;
}

/**
 * A {@link RateLimiter} that reads per-user overrides from the database
 * at check time and merges them with the default rate-limit config.
 *
 * Per-user overrides take precedence over defaults (Requirement 12.4):
 * when an override value is non-null for a given field, the
 * corresponding window's `limit` is replaced with the override value.
 *
 * Validates: Requirements 12.4.
 */
export class OverrideAwareRateLimiter implements RateLimiter {
  private readonly store: RateLimitStore;
  private readonly overrideResolver: RateLimitOverrideResolver;
  private readonly defaults: RateLimitConfig;
  private readonly now: () => Date;

  constructor(options: OverrideAwareRateLimiterOptions) {
    if (!options.store) {
      throw new Error('OverrideAwareRateLimiter: store is required');
    }
    if (!options.overrideResolver) {
      throw new Error('OverrideAwareRateLimiter: overrideResolver is required');
    }
    this.store = options.store;
    this.overrideResolver = options.overrideResolver;
    this.defaults = options.defaults ?? DEFAULT_RATE_LIMITS;
    this.now = options.now ?? (() => new Date());
  }

  async check(input: {
    readonly userId: string;
    readonly kind: RateLimitKind;
    readonly ip?: string;
  }): Promise<RateLimitDecision> {
    const now = this.now();

    // Look up per-user overrides.
    const overrides = await this.overrideResolver.getOverrides(input.userId);

    // Merge overrides with defaults for the requested kind.
    const windows = this.mergeWindows(input.kind, overrides);

    const observations = await this.store.recordAndCount({
      userId: input.userId,
      kind: input.kind,
      ip: input.ip ?? null,
      now,
      windows,
    });

    return computeDecision(now, observations);
  }

  /**
   * Merge per-user overrides into the default windows for a given kind.
   *
   * Override mapping:
   *   - `ai_per_min`       -> replaces limit on the 60-second ai_op window
   *   - `ai_per_day`       -> replaces limit on the 86400-second ai_op window
   *   - `session_per_hour` -> replaces limit on the 3600-second session_start window
   *
   * When an override is null or the override row is absent, the default
   * limit is used unchanged.
   */
  private mergeWindows(
    kind: RateLimitKind,
    overrides: RateLimitOverrideRow | null,
  ): ReadonlyArray<RateLimitWindow> {
    const defaultWindows = this.defaults[kind];
    if (!overrides) return defaultWindows;

    if (kind === 'ai_op') {
      return defaultWindows.map((w) => {
        if (w.windowSeconds === 60 && overrides.ai_per_min !== null) {
          return { windowSeconds: w.windowSeconds, limit: overrides.ai_per_min };
        }
        if (w.windowSeconds === 86_400 && overrides.ai_per_day !== null) {
          return { windowSeconds: w.windowSeconds, limit: overrides.ai_per_day };
        }
        return w;
      });
    }

    if (kind === 'session_start') {
      return defaultWindows.map((w) => {
        if (w.windowSeconds === 3600 && overrides.session_per_hour !== null) {
          return { windowSeconds: w.windowSeconds, limit: overrides.session_per_hour };
        }
        return w;
      });
    }

    // login_attempt and login_success have no overrides.
    return defaultWindows;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertValidWindow(w: RateLimitWindow): void {
  if (!Number.isInteger(w.windowSeconds) || w.windowSeconds <= 0) {
    throw new Error(
      `RateLimitWindow.windowSeconds must be a positive integer (got ${w.windowSeconds})`,
    );
  }
  if (!Number.isInteger(w.limit) || w.limit < 0) {
    throw new Error(
      `RateLimitWindow.limit must be a non-negative integer (got ${w.limit})`,
    );
  }
}

function assertValidNow(now: Date): void {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('RateLimitStore: `now` must be a valid Date');
  }
}
