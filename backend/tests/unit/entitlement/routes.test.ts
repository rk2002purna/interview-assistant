import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';

/**
 * Unit tests for `GET /me/entitlement`.
 *
 * Validates: Requirement 6.4 — serves the authenticated user's current
 * entitlement by reading the latest ledger row's resulting_* columns.
 * Returns {session_count: 0, lifetime_flag: false} when no entries exist.
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

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-entitlement-routes-12345';
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

describe('GET /me/entitlement', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const app = buildApp({ pool: ctx.pool });
    const res = await app.request('/me/entitlement');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  it('returns 401 for malformed Authorization header', async () => {
    const app = buildApp({ pool: ctx.pool });
    const res = await app.request('/me/entitlement', {
      headers: { Authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  it('returns {session_count: 0, lifetime_flag: false} when no ledger entries exist', async () => {
    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/me/entitlement', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ session_count: 0, lifetime_flag: false });
  });

  it('returns the latest ledger row resulting_* values', async () => {
    await ctx.withClient(async (client) => {
      // Insert two ledger entries; the latest one should be returned.
      await client.query(
        `INSERT INTO entitlement_ledger
          (id, user_id, ts, session_delta, lifetime_flag_set, reason, resulting_session_count, resulting_lifetime_flag)
         VALUES
          ($1, $2, '2024-01-01T00:00:00Z', 5, 'unchanged', 'pack_purchase', 5, false),
          ($3, $2, '2024-01-02T00:00:00Z', 10, 'unchanged', 'pack_purchase', 15, false)`,
        [
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          USER_ID,
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        ],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/me/entitlement', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ session_count: 15, lifetime_flag: false });
  });

  it('returns lifetime_flag: true when the latest row has it set', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO entitlement_ledger
          (id, user_id, ts, session_delta, lifetime_flag_set, reason, resulting_session_count, resulting_lifetime_flag)
         VALUES ($1, $2, '2024-01-01T00:00:00Z', 0, 'set_true', 'lifetime_grant', 0, true)`,
        [
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          USER_ID,
        ],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/me/entitlement', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ session_count: 0, lifetime_flag: true });
  });

  it('does not return another user\'s entitlement', async () => {
    const otherUserId = '33333333-3333-4333-8333-333333333333';
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO users (id, email, role) VALUES ($1, $2, $3)`,
        [otherUserId, 'other@example.com', 'user'],
      );
      await client.query(
        `INSERT INTO entitlement_ledger
          (id, user_id, ts, session_delta, lifetime_flag_set, reason, resulting_session_count, resulting_lifetime_flag)
         VALUES ($1, $2, '2024-01-01T00:00:00Z', 100, 'unchanged', 'pack_purchase', 100, false)`,
        [
          'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          otherUserId,
        ],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/me/entitlement', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Our user has no entries, so should get the default.
    expect(body).toEqual({ session_count: 0, lifetime_flag: false });
  });
});
