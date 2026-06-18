import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';

/**
 * Unit tests for `POST /sessions/:id/end`.
 *
 * Validates: Requirement 8.6 — allows an authenticated user to end their
 * own active interview session. Verifies ownership and active status,
 * writes `ended_at` and `ended_reason='ended_by_user'`. No refund.
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
    status text NOT NULL CHECK (status IN ('active','ended','expired')),
    started_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    ended_at timestamptz NULL,
    ended_reason text NULL CHECK (
      ended_reason IS NULL
      OR ended_reason IN ('ended_by_user','expired','signed_out')
    ),
    CONSTRAINT interview_sessions_ended_consistency
      CHECK (
        (status = 'active' AND ended_at IS NULL AND ended_reason IS NULL)
        OR (status IN ('ended','expired') AND ended_at IS NOT NULL)
      )
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
const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-session-end-routes-12345';
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
    await client.query(
      `INSERT INTO users (id, email, role) VALUES ($1, $2, $3)`,
      [OTHER_USER_ID, 'other@example.com', 'user'],
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

describe('POST /sessions/:id/end', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const app = buildApp({ pool: ctx.pool });
    const res = await app.request(`/sessions/${SESSION_ID}/end`, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  it('returns 401 for malformed Authorization header', async () => {
    const app = buildApp({ pool: ctx.pool });
    const res = await app.request(`/sessions/${SESSION_ID}/end`, {
      method: 'POST',
      headers: { Authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  it('returns 404 when session does not exist', async () => {
    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const nonExistentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const res = await app.request(`/sessions/${nonExistentId}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session_not_found');
  });

  it('returns 404 when session belongs to another user', async () => {
    // Insert an active session owned by OTHER_USER_ID
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at)
         VALUES ($1, $2, 'active', '2024-06-15T10:00:00Z', '2024-06-15T11:30:00Z')`,
        [SESSION_ID, OTHER_USER_ID],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken(USER_ID); // Authenticated as USER_ID
    const res = await app.request(`/sessions/${SESSION_ID}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session_not_found');
  });

  it('returns 409 when session is already ended', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at, ended_at, ended_reason)
         VALUES ($1, $2, 'ended', '2024-06-15T10:00:00Z', '2024-06-15T11:30:00Z', '2024-06-15T10:30:00Z', 'ended_by_user')`,
        [SESSION_ID, USER_ID],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request(`/sessions/${SESSION_ID}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session_not_active');
  });

  it('returns 409 when session is expired', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at, ended_at, ended_reason)
         VALUES ($1, $2, 'expired', '2024-06-15T10:00:00Z', '2024-06-15T11:30:00Z', '2024-06-15T11:30:00Z', 'expired')`,
        [SESSION_ID, USER_ID],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request(`/sessions/${SESSION_ID}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('session_not_active');
  });

  it('successfully ends an active session owned by the caller', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at)
         VALUES ($1, $2, 'active', '2024-06-15T10:00:00Z', '2024-06-15T11:30:00Z')`,
        [SESSION_ID, USER_ID],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request(`/sessions/${SESSION_ID}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; session_id: string; ended_at: string };
    expect(body.ok).toBe(true);
    expect(body.session_id).toBe(SESSION_ID);
    expect(body.ended_at).toBeDefined();
    // ended_at should be a valid ISO date string
    expect(new Date(body.ended_at).toISOString()).toBe(body.ended_at);
  });

  it('sets status to ended and ended_reason to ended_by_user in the database', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at)
         VALUES ($1, $2, 'active', '2024-06-15T10:00:00Z', '2024-06-15T11:30:00Z')`,
        [SESSION_ID, USER_ID],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    await app.request(`/sessions/${SESSION_ID}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    // Verify the database state
    const result = await ctx.pool.query(
      `SELECT status, ended_at, ended_reason FROM interview_sessions WHERE id = $1`,
      [SESSION_ID],
    );
    const row = result.rows[0] as { status: string; ended_at: Date; ended_reason: string };
    expect(row.status).toBe('ended');
    expect(row.ended_at).not.toBeNull();
    expect(row.ended_reason).toBe('ended_by_user');
  });

  it('does not issue a refund (no ledger entry created)', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at)
         VALUES ($1, $2, 'active', '2024-06-15T10:00:00Z', '2024-06-15T11:30:00Z')`,
        [SESSION_ID, USER_ID],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    await app.request(`/sessions/${SESSION_ID}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    // Verify no ledger entry was created for this session end
    const result = await ctx.pool.query(
      `SELECT COUNT(*) as count FROM entitlement_ledger WHERE user_id = $1`,
      [USER_ID],
    );
    expect(Number((result.rows[0] as { count: string }).count)).toBe(0);
  });
});
