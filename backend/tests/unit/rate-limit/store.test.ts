/**
 * Unit tests for `src/rate-limit/store.ts`.
 *
 * Validates: Requirements 12.1, 12.2, 12.3.
 *
 * The tests are split into three groups:
 *
 *   1. {@link computeDecision} - pure tests with no DB or store.
 *      Drive Retry-After arithmetic, multi-window selection, and the
 *      `[1, 86400]` clamp from Property 19.
 *   2. `PostgresRateLimitStore` - against pg-mem with the migration-
 *      0006 schema. Exercises insert-then-count semantics and
 *      multi-window aggregation through the same SQL the production
 *      code runs.
 *   3. `PostgresRateLimiter` end-to-end - composes the limiter on top
 *      of the store and asserts the (k+1)-th call reaches HTTP 429
 *      semantics with the expected Retry-After.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_RATE_LIMITS,
  MAX_RETRY_AFTER_SECONDS,
  PostgresRateLimitStore,
  PostgresRateLimiter,
  computeDecision,
  type RateLimitObservation,
  type RateLimitStore,
} from '../../../src/rate-limit/store.js';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';

// rate_events table only - this is the single table the store reads
// and writes. The schema mirrors migration 0006 verbatim aside from
// foreign keys (the store only ever touches `rate_events`).
const RATE_EVENTS_DDL = `
  CREATE TABLE rate_events (
    user_id uuid        NOT NULL,
    ts      timestamptz NOT NULL,
    kind    text        NOT NULL CHECK (kind IN (
              'ai_op', 'session_start', 'login_attempt', 'login_success'
            )),
    ip      inet        NULL,
    PRIMARY KEY (user_id, ts, kind)
  );
  CREATE INDEX rate_events_user_kind_ts_idx
    ON rate_events (user_id, kind, ts DESC);
`;

// ---------------------------------------------------------------------------
// computeDecision (pure)
// ---------------------------------------------------------------------------

describe('computeDecision', () => {
  const NOW = new Date('2025-01-01T00:00:00.000Z');

  it('allows when every observation is at or below its limit', () => {
    const obs: RateLimitObservation[] = [
      { window: { windowSeconds: 60, limit: 60 }, count: 60, oldestTs: new Date(NOW.getTime() - 30_000) },
      { window: { windowSeconds: 86_400, limit: 1000 }, count: 800, oldestTs: new Date(NOW.getTime() - 1000) },
    ];
    expect(computeDecision(NOW, obs)).toEqual({ allowed: true });
  });

  it('rejects with retry equal to remaining seconds until oldest leaves the window', () => {
    // Oldest counted event at NOW - 50s, window is 60s -> retry in 10s.
    const obs: RateLimitObservation[] = [
      {
        window: { windowSeconds: 60, limit: 60 },
        count: 61,
        oldestTs: new Date(NOW.getTime() - 50_000),
      },
    ];
    const decision = computeDecision(NOW, obs);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(10);
  });

  it('returns at least 1 second when the oldest event has already crossed the boundary', () => {
    // remaining < 1s -> clamp to 1.
    const obs: RateLimitObservation[] = [
      {
        window: { windowSeconds: 60, limit: 1 },
        count: 2,
        oldestTs: new Date(NOW.getTime() - 60_500), // -0.5s remaining
      },
    ];
    expect(computeDecision(NOW, obs).retryAfterSeconds).toBe(1);
  });

  it('caps Retry-After at 86400 seconds (Property 19 / R12.3)', () => {
    const obs: RateLimitObservation[] = [
      {
        window: { windowSeconds: MAX_RETRY_AFTER_SECONDS * 10, limit: 0 },
        count: 1,
        oldestTs: NOW,
      },
    ];
    const d = computeDecision(NOW, obs);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeLessThanOrEqual(MAX_RETRY_AFTER_SECONDS);
    expect(d.retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it('returns the largest Retry-After when multiple windows are exceeded', () => {
    const obs: RateLimitObservation[] = [
      {
        window: { windowSeconds: 60, limit: 1 },
        count: 2,
        oldestTs: new Date(NOW.getTime() - 50_000), // 10s
      },
      {
        window: { windowSeconds: 86_400, limit: 1 },
        count: 2,
        oldestTs: new Date(NOW.getTime() - 60_000), // 86_340s
      },
    ];
    expect(computeDecision(NOW, obs).retryAfterSeconds).toBe(86_340);
  });

  it('still rejects when oldestTs is missing (defensive)', () => {
    const obs: RateLimitObservation[] = [
      { window: { windowSeconds: 60, limit: 0 }, count: 1, oldestTs: null },
    ];
    expect(computeDecision(NOW, obs)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('uses ceil(seconds) so fractional remainders never underflow to zero', () => {
    const obs: RateLimitObservation[] = [
      {
        window: { windowSeconds: 60, limit: 1 },
        count: 2,
        oldestTs: new Date(NOW.getTime() - 59_001), // 0.999s remaining
      },
    ];
    expect(computeDecision(NOW, obs).retryAfterSeconds).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PostgresRateLimitStore (pg-mem)
// ---------------------------------------------------------------------------

describe('PostgresRateLimitStore', () => {
  let ctx: PgMemContext;

  beforeAll(async () => {
    ctx = await createPgMem({ initSql: RATE_EVENTS_DDL });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  afterEach(async () => {
    await ctx.pool.query('DELETE FROM rate_events');
  });

  it('inserts the event and counts it (insert-then-count)', async () => {
    const store = new PostgresRateLimitStore(ctx.pool);
    const now = new Date('2025-06-01T12:00:00Z');
    const obs = await store.recordAndCount({
      userId: randomUUID(),
      kind: 'ai_op',
      now,
      windows: [{ windowSeconds: 60, limit: 60 }],
    });
    expect(obs).toHaveLength(1);
    expect(obs[0]!.count).toBe(1);
    expect(obs[0]!.oldestTs).toEqual(now);
  });

  it('counts only events inside the rolling window', async () => {
    const store = new PostgresRateLimitStore(ctx.pool);
    const userId = randomUUID();
    const now = new Date('2025-06-01T12:00:00Z');

    // Pre-populate: 2 events 30s ago (in-window for 60s), 1 event 70s
    // ago (out-of-window for 60s but in-window for 86400s).
    await ctx.pool.query(
      `INSERT INTO rate_events (user_id, ts, kind, ip) VALUES
         ($1, $2::timestamptz, 'ai_op', NULL),
         ($1, $3::timestamptz, 'ai_op', NULL),
         ($1, $4::timestamptz, 'ai_op', NULL)`,
      [
        userId,
        new Date(now.getTime() - 30_000).toISOString(),
        new Date(now.getTime() - 31_000).toISOString(),
        new Date(now.getTime() - 70_000).toISOString(),
      ],
    );

    const obs = await store.recordAndCount({
      userId,
      kind: 'ai_op',
      now,
      windows: [
        { windowSeconds: 60, limit: 60 },
        { windowSeconds: 86_400, limit: 1000 },
      ],
    });

    // After insert-then-count: 60s window sees 3 (the two recent + the
    // new), 24h window sees 4.
    expect(obs[0]!.count).toBe(3);
    expect(obs[1]!.count).toBe(4);
    // 60s oldest = the 31s-ago event. 24h oldest = the 70s-ago event.
    expect(obs[0]!.oldestTs!.getTime()).toBe(now.getTime() - 31_000);
    expect(obs[1]!.oldestTs!.getTime()).toBe(now.getTime() - 70_000);
  });

  it('isolates events per (user, kind)', async () => {
    const store = new PostgresRateLimitStore(ctx.pool);
    const a = randomUUID();
    const b = randomUUID();
    const now = new Date('2025-06-01T12:00:00Z');

    await store.recordAndCount({ userId: a, kind: 'ai_op', now, windows: [] });
    await store.recordAndCount({ userId: a, kind: 'ai_op', now: new Date(now.getTime() + 1), windows: [] });
    await store.recordAndCount({ userId: a, kind: 'session_start', now: new Date(now.getTime() + 2), windows: [] });

    const obs = await store.recordAndCount({
      userId: a,
      kind: 'ai_op',
      now: new Date(now.getTime() + 10),
      windows: [{ windowSeconds: 60, limit: 60 }],
    });
    // 2 prior ai_op + the new one = 3. session_start is not counted.
    expect(obs[0]!.count).toBe(3);

    // User b has zero history regardless of user a's traffic.
    const obsB = await store.recordAndCount({
      userId: b,
      kind: 'ai_op',
      now: new Date(now.getTime() + 11),
      windows: [{ windowSeconds: 60, limit: 60 }],
    });
    expect(obsB[0]!.count).toBe(1);
  });

  it('returns an empty observation array when no windows are requested but still inserts the event', async () => {
    const store = new PostgresRateLimitStore(ctx.pool);
    const userId = randomUUID();
    const now = new Date('2025-06-01T12:00:00Z');
    const obs = await store.recordAndCount({ userId, kind: 'login_success', now, windows: [] });
    expect(obs).toEqual([]);
    const r = await ctx.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM rate_events WHERE user_id = $1`,
      [userId],
    );
    expect(r.rows[0]!.c).toBe(1);
  });

  it('persists the supplied IP', async () => {
    const store = new PostgresRateLimitStore(ctx.pool);
    const userId = randomUUID();
    const now = new Date('2025-06-01T12:00:00Z');
    await store.recordAndCount({
      userId,
      kind: 'login_success',
      ip: '203.0.113.7',
      now,
      windows: [],
    });
    const r = await ctx.pool.query<{ ip: string | null }>(
      `SELECT ip::text AS ip FROM rate_events WHERE user_id = $1`,
      [userId],
    );
    expect(r.rows[0]!.ip).toBe('203.0.113.7');
  });

  it('tolerates a duplicate (user_id, ts, kind) insert via ON CONFLICT DO NOTHING', async () => {
    const store = new PostgresRateLimitStore(ctx.pool);
    const userId = randomUUID();
    const now = new Date('2025-06-01T12:00:00Z');
    await store.recordAndCount({ userId, kind: 'ai_op', now, windows: [] });
    await expect(
      store.recordAndCount({ userId, kind: 'ai_op', now, windows: [] }),
    ).resolves.toBeDefined();
    const r = await ctx.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM rate_events WHERE user_id=$1`,
      [userId],
    );
    expect(r.rows[0]!.c).toBe(1);
  });

  it('rejects invalid window descriptors', async () => {
    const store = new PostgresRateLimitStore(ctx.pool);
    const userId = randomUUID();
    const now = new Date('2025-06-01T12:00:00Z');
    await expect(
      store.recordAndCount({
        userId,
        kind: 'ai_op',
        now,
        windows: [{ windowSeconds: 0, limit: 1 }],
      }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      store.recordAndCount({
        userId,
        kind: 'ai_op',
        now,
        windows: [{ windowSeconds: 60, limit: -1 }],
      }),
    ).rejects.toThrow(/non-negative integer/);
  });
});

// ---------------------------------------------------------------------------
// PostgresRateLimiter end-to-end
// ---------------------------------------------------------------------------

class StaticClockStore implements RateLimitStore {
  // In-memory store backing the limiter so the test exercises the
  // limiter's policy without needing the pg-mem context.
  private events: Array<{ userId: string; kind: string; ts: Date; ip?: string | null }> = [];
  async recordAndCount(input: {
    userId: string;
    kind: string;
    ip?: string | null;
    now: Date;
    windows: ReadonlyArray<{ windowSeconds: number; limit: number }>;
  }): Promise<ReadonlyArray<RateLimitObservation>> {
    this.events.push({ userId: input.userId, kind: input.kind, ts: input.now, ip: input.ip ?? null });
    return input.windows.map((w) => {
      const cutoff = input.now.getTime() - w.windowSeconds * 1000;
      const inWindow = this.events.filter(
        (e) =>
          e.userId === input.userId && e.kind === input.kind && e.ts.getTime() > cutoff,
      );
      const oldest = inWindow.reduce<Date | null>(
        (a, e) => (a === null || e.ts < a ? e.ts : a),
        null,
      );
      return { window: w, count: inWindow.length, oldestTs: oldest };
    });
  }
}

describe('PostgresRateLimiter (with default config)', () => {
  it('allows the first 60 ai_op requests and rejects the 61st with Retry-After', async () => {
    const store = new StaticClockStore();
    let now = new Date('2025-06-01T00:00:00Z').getTime();
    const limiter = new PostgresRateLimiter({ store, now: () => new Date(now) });
    const userId = randomUUID();

    for (let i = 0; i < 60; i++) {
      const d = await limiter.check({ userId, kind: 'ai_op' });
      expect(d.allowed).toBe(true);
      now += 100; // 100ms apart, all inside the 60s window
    }
    const denied = await limiter.check({ userId, kind: 'ai_op' });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('rejects the 6th session_start within an hour with Retry-After near the window edge', async () => {
    const store = new StaticClockStore();
    let now = new Date('2025-06-01T00:00:00Z').getTime();
    const limiter = new PostgresRateLimiter({ store, now: () => new Date(now) });
    const userId = randomUUID();

    for (let i = 0; i < 5; i++) {
      const d = await limiter.check({ userId, kind: 'session_start' });
      expect(d.allowed).toBe(true);
      now += 60_000; // one per minute
    }
    const denied = await limiter.check({ userId, kind: 'session_start' });
    expect(denied.allowed).toBe(false);
    // Oldest counted = 5 minutes ago, window = 60 minutes -> retry ~3300s.
    expect(denied.retryAfterSeconds).toBe(60 * 60 - 5 * 60);
  });

  it('reports the per-day window when the per-minute window has reset', async () => {
    const store = new StaticClockStore();
    let now = new Date('2025-06-01T00:00:00Z').getTime();
    const limiter = new PostgresRateLimiter({ store, now: () => new Date(now) });
    const userId = randomUUID();

    // Burn 1000 ai_ops spread across ~16 hours so the per-min cap
    // never kicks in (one every 60s) and every event stays well
    // inside the 24-hour rolling window.
    for (let i = 0; i < 1000; i++) {
      const d = await limiter.check({ userId, kind: 'ai_op' });
      expect(d.allowed).toBe(true);
      now += 60_000; // 60s apart
    }
    const denied = await limiter.check({ userId, kind: 'ai_op' });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(86_400);
  });

  it('records login_success events even though there is no rolling-window cap', async () => {
    const store = new StaticClockStore();
    const limiter = new PostgresRateLimiter({ store });
    const userId = randomUUID();
    for (let i = 0; i < 100; i++) {
      const d = await limiter.check({ userId, kind: 'login_success', ip: '198.51.100.1' });
      expect(d.allowed).toBe(true);
    }
  });

  it('exposes the documented defaults from Requirements 12.1 and 12.2', () => {
    expect(DEFAULT_RATE_LIMITS.ai_op.map((w) => w.windowSeconds)).toEqual([60, 86_400]);
    expect(DEFAULT_RATE_LIMITS.ai_op.map((w) => w.limit)).toEqual([60, 1000]);
    expect(DEFAULT_RATE_LIMITS.session_start.map((w) => w.windowSeconds)).toEqual([3600]);
    expect(DEFAULT_RATE_LIMITS.session_start.map((w) => w.limit)).toEqual([5]);
  });
});

describe('PostgresRateLimiter construction', () => {
  it('throws when store is missing', () => {
    expect(() => new PostgresRateLimiter({} as never)).toThrow(/store is required/);
  });

  it('rejects an invalid override config', () => {
    expect(
      () =>
        new PostgresRateLimiter({
          store: new StaticClockStore(),
          config: {
            ...DEFAULT_RATE_LIMITS,
            ai_op: [{ windowSeconds: -1, limit: 5 }],
          },
        }),
    ).toThrow(/positive integer/);
  });
});
