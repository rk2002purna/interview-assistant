import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';

/**
 * Unit tests for `GET /me/session/active`.
 *
 * Validates: Requirement 8.7 — returns the authenticated user's current
 * active Interview Session including session_id, started_at, expires_at,
 * and remaining_seconds, or HTTP 404 with error code `no_active_session`
 * if no session is active.
 */

const INIT_SQL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    role text NOT NULL
  );

  CREATE TABLE interview_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    status text NOT NULL,
    started_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    ended_at timestamptz NULL,
    ended_reason text NULL
  );

  CREATE UNIQUE INDEX one_active_session_per_user
    ON interview_sessions (user_id)
    WHERE status = 'active';

  CREATE TABLE entitlement_ledger (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    ts timestamptz NOT NULL DEFAULT now(),
    session_delta integer NOT NULL,
    lifetime_flag_set text NOT NULL,
    reason text NOT NULL,
    razorpay_payment_id text NULL,
    interview_session_id uuid NULL,
    acting_admin_id uuid NULL,
    resulting_session_count integer NOT NULL,
    resulting_lifetime_flag boolean NOT NULL,
    note text NULL
  );

  CREATE INDEX entitlement_ledger_user_ts_idx
    ON entitlement_ledger (user_id, ts DESC);
`;

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-session-routes-12345';
  ctx = await createPgMem({ initSql: INIT_SQL });
});

afterAll(async () => {
  await ctx.stop();
  if (originalSecret === undefined) {
    delete process.env['JWT_SECRET'];
  } else {
    process.env['JWT_SECRET'] = originalSecret;
  }
});

beforeEach(() => {
  restore = ctx.snapshot();
  return ctx.withClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, email, role) VALUES ($1, $2, $3)`,
      [USER_ID, 'user@example.com', 'user'],
    );
  });
});

afterEach(() => {
  restore();
});

async function getToken(userId = USER_ID): Promise<string> {
  const { token } = await signAccessToken({
    sub: userId,
    role: 'user',
    clientId: CLIENT_ID,
  });
  return token;
}

describe('GET /me/session/active', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const app = buildApp({ pool: ctx.pool });
    const res = await app.request('/me/session/active');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  it('returns 401 for malformed Authorization header', async () => {
    const app = buildApp({ pool: ctx.pool });
    const res = await app.request('/me/session/active', {
      headers: { Authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  it('returns 404 with no_active_session when user has no active session', async () => {
    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/me/session/active', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('no_active_session');
    expect(body.error.message).toBe('no active interview session');
  });

  it('returns 404 when user only has ended sessions', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at, ended_at, ended_reason)
         VALUES ($1, $2, 'ended', '2024-01-01T10:00:00Z', '2024-01-01T11:30:00Z', '2024-01-01T10:30:00Z', 'ended_by_user')`,
        [SESSION_ID, USER_ID],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/me/session/active', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('no_active_session');
  });

  it('returns active session with remaining_seconds', async () => {
    const startedAt = new Date('2024-06-15T10:00:00Z');
    const expiresAt = new Date('2024-06-15T11:30:00Z'); // 90 min later
    const now = new Date('2024-06-15T10:30:00Z'); // 30 min into session → 60 min remaining

    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at)
         VALUES ($1, $2, 'active', $3, $4)`,
        [SESSION_ID, USER_ID, startedAt.toISOString(), expiresAt.toISOString()],
      );
    });

    const app = buildApp({ pool: ctx.pool, now: () => now });
    const token = await getToken();
    const res = await app.request('/me/session/active', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      session_id: SESSION_ID,
      started_at: startedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      remaining_seconds: 3600, // 60 minutes = 3600 seconds
    });
  });

  it('returns remaining_seconds as 0 when session has expired but status not yet updated', async () => {
    const startedAt = new Date('2024-06-15T10:00:00Z');
    const expiresAt = new Date('2024-06-15T11:30:00Z');
    // Now is past expires_at but status hasn't been swept yet
    const now = new Date('2024-06-15T11:35:00Z');

    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at)
         VALUES ($1, $2, 'active', $3, $4)`,
        [SESSION_ID, USER_ID, startedAt.toISOString(), expiresAt.toISOString()],
      );
    });

    const app = buildApp({ pool: ctx.pool, now: () => now });
    const token = await getToken();
    const res = await app.request('/me/session/active', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { remaining_seconds: number };
    expect(body.remaining_seconds).toBe(0);
  });

  it('does not return another user\'s active session', async () => {
    const otherUserId = '33333333-3333-4333-8333-333333333333';
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO users (id, email, role) VALUES ($1, $2, $3)`,
        [otherUserId, 'other@example.com', 'user'],
      );
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at)
         VALUES ($1, $2, 'active', '2024-06-15T10:00:00Z', '2024-06-15T11:30:00Z')`,
        ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', otherUserId],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/me/session/active', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('no_active_session');
  });
});
