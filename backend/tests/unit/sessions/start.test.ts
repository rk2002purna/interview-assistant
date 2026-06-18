import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';

/**
 * Unit tests for `POST /sessions/start`.
 *
 * Validates: Requirements 8.1, 8.2, 8.3
 *   - 8.1: session start deducts one credit (or 0 for lifetime)
 *   - 8.2: 402 when no sessions remaining
 *   - 8.3: 409 when user already has an active session
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

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-session-start-12345';
  ctx = await createPgMem({ initSql: INIT_SQL });

  // Register pg functions that pg-mem doesn't support natively.
  // These are no-ops for unit tests (concurrency is not tested here).
  ctx.db.public.registerFunction({
    name: 'hashtextextended',
    args: ['text', 'integer'] as unknown as never,
    returns: 'bigint' as unknown as never,
    implementation: () => 0,
  });
  ctx.db.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: ['bigint'] as unknown as never,
    returns: 'null' as unknown as never,
    implementation: () => null,
  });
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

describe('POST /sessions/start', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const app = buildApp({ pool: ctx.pool });
    const res = await app.request('/sessions/start', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  it('returns 402 when user has no entitlement (no ledger rows)', async () => {
    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/sessions/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('no_sessions_remaining');
  });

  it('returns 402 when user has 0 sessions remaining and is not lifetime', async () => {
    await ctx.withClient(async (client) => {
      // Give user 1 session, then consume it
      await client.query(
        `INSERT INTO entitlement_ledger (id, user_id, session_delta, lifetime_flag_set, reason, resulting_session_count, resulting_lifetime_flag)
         VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01', $1, 1, 'unchanged', 'pack_purchase', 1, false)`,
        [USER_ID],
      );
      await client.query(
        `INSERT INTO entitlement_ledger (id, user_id, session_delta, lifetime_flag_set, reason, resulting_session_count, resulting_lifetime_flag)
         VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02', $1, -1, 'unchanged', 'session_start', 0, false)`,
        [USER_ID],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/sessions/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('no_sessions_remaining');
  });

  it('returns 201 with session details when user has sessions remaining', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO entitlement_ledger (id, user_id, session_delta, lifetime_flag_set, reason, resulting_session_count, resulting_lifetime_flag)
         VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03', $1, 5, 'unchanged', 'pack_purchase', 5, false)`,
        [USER_ID],
      );
    });

    const now = new Date('2024-06-15T10:00:00Z');
    const app = buildApp({ pool: ctx.pool, now: () => now });
    const token = await getToken();
    const res = await app.request('/sessions/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      session_id: string;
      started_at: string;
      expires_at: string;
    };
    expect(body.session_id).toBeDefined();
    expect(body.started_at).toBe('2024-06-15T10:00:00.000Z');
    expect(body.expires_at).toBe('2024-06-15T11:30:00.000Z'); // 90 min later
  });

  it('deducts 1 session credit on successful start', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO entitlement_ledger (id, user_id, session_delta, lifetime_flag_set, reason, resulting_session_count, resulting_lifetime_flag)
         VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee04', $1, 5, 'unchanged', 'pack_purchase', 5, false)`,
        [USER_ID],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    await app.request('/sessions/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    // Check the ledger has a new session_start entry with delta -1
    const result = await ctx.pool.query(
      `SELECT session_delta, reason, resulting_session_count
         FROM entitlement_ledger
        WHERE user_id = $1
        ORDER BY ts DESC, id DESC
        LIMIT 1`,
      [USER_ID],
    );
    const row = result.rows[0] as {
      session_delta: number;
      reason: string;
      resulting_session_count: number;
    };
    expect(row.session_delta).toBe(-1);
    expect(row.reason).toBe('session_start');
    expect(row.resulting_session_count).toBe(4);
  });

  it('does not deduct credit for lifetime users (delta=0)', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO entitlement_ledger (id, user_id, session_delta, lifetime_flag_set, reason, resulting_session_count, resulting_lifetime_flag)
         VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee05', $1, 0, 'set_true', 'lifetime_grant', 0, true)`,
        [USER_ID],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/sessions/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(201);

    // Check the ledger entry has delta 0
    const result = await ctx.pool.query(
      `SELECT session_delta, reason, resulting_session_count, resulting_lifetime_flag
         FROM entitlement_ledger
        WHERE user_id = $1 AND reason = 'session_start'
        ORDER BY ts DESC, id DESC
        LIMIT 1`,
      [USER_ID],
    );
    const row = result.rows[0] as {
      session_delta: number;
      reason: string;
      resulting_session_count: number;
      resulting_lifetime_flag: boolean;
    };
    expect(row.session_delta).toBe(0);
    expect(row.resulting_session_count).toBe(0);
    expect(row.resulting_lifetime_flag).toBe(true);
  });

  it('returns 409 when user already has an active session', async () => {
    const existingSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const expiresAt = new Date('2024-06-15T11:30:00Z');

    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO entitlement_ledger (id, user_id, session_delta, lifetime_flag_set, reason, resulting_session_count, resulting_lifetime_flag)
         VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee06', $1, 5, 'unchanged', 'pack_purchase', 5, false)`,
        [USER_ID],
      );
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at)
         VALUES ($1, $2, 'active', '2024-06-15T10:00:00Z', $3)`,
        [existingSessionId, USER_ID, expiresAt.toISOString()],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/sessions/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: {
        code: string;
        details: { active_session_id: string; expires_at: string };
      };
    };
    expect(body.error.code).toBe('session_already_active');
    expect(body.error.details.active_session_id).toBe(existingSessionId);
    expect(body.error.details.expires_at).toBe(expiresAt.toISOString());
  });

  it('allows starting a session when previous session is ended', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO entitlement_ledger (id, user_id, session_delta, lifetime_flag_set, reason, resulting_session_count, resulting_lifetime_flag)
         VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee07', $1, 5, 'unchanged', 'pack_purchase', 5, false)`,
        [USER_ID],
      );
      await client.query(
        `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at, ended_at, ended_reason)
         VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', $1, 'ended', '2024-06-15T08:00:00Z', '2024-06-15T09:30:00Z', '2024-06-15T08:45:00Z', 'ended_by_user')`,
        [USER_ID],
      );
    });

    const app = buildApp({ pool: ctx.pool });
    const token = await getToken();
    const res = await app.request('/sessions/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(201);
  });

  it('creates an interview_sessions row with status active', async () => {
    await ctx.withClient(async (client) => {
      await client.query(
        `INSERT INTO entitlement_ledger (id, user_id, session_delta, lifetime_flag_set, reason, resulting_session_count, resulting_lifetime_flag)
         VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee08', $1, 3, 'unchanged', 'pack_purchase', 3, false)`,
        [USER_ID],
      );
    });

    const now = new Date('2024-06-15T10:00:00Z');
    const app = buildApp({ pool: ctx.pool, now: () => now });
    const token = await getToken();
    const res = await app.request('/sessions/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session_id: string };

    // Verify the row in interview_sessions
    const result = await ctx.pool.query(
      `SELECT status, started_at, expires_at FROM interview_sessions WHERE id = $1`,
      [body.session_id],
    );
    const row = result.rows[0] as {
      status: string;
      started_at: Date;
      expires_at: Date;
    };
    expect(row.status).toBe('active');
    expect(new Date(row.started_at).toISOString()).toBe('2024-06-15T10:00:00.000Z');
    expect(new Date(row.expires_at).toISOString()).toBe('2024-06-15T11:30:00.000Z');
  });
});
