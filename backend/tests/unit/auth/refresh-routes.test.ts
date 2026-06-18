import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';

/**
 * Tests for `POST /auth/refresh` and `POST /auth/logout`.
 *
 * Validates: Requirements 1.6, 1.7, 1.10, 13.5.
 */

const INIT_SQL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'user',
    email_verified_at timestamptz NULL,
    locked_until timestamptz NULL,
    failed_login_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX users_email_lower_unique ON users (LOWER(email));

  CREATE TABLE refresh_tokens (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    token_hash text NOT NULL,
    client_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX refresh_tokens_token_hash_unique ON refresh_tokens (token_hash);

  CREATE TABLE email_verifications (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE packs (
    slug text PRIMARY KEY,
    display_name text NOT NULL,
    description text NOT NULL,
    mrp_paise bigint NOT NULL,
    welcome_price_paise bigint NOT NULL,
    session_count integer NULL,
    is_lifetime boolean NOT NULL DEFAULT false,
    active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE welcome_offer (
    id integer PRIMARY KEY,
    enabled boolean NOT NULL,
    ends_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE purchases (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    pack_slug text NOT NULL,
    effective_price_paise bigint NOT NULL,
    mrp_at_purchase_paise bigint NOT NULL,
    status text NOT NULL,
    razorpay_order_id text NOT NULL,
    razorpay_payment_id text NULL,
    welcome_offer_applied boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz NULL
  );
  CREATE TABLE audit_log (
    id uuid PRIMARY KEY,
    ts timestamptz NOT NULL DEFAULT now(),
    actor_user_id uuid NULL,
    target_user_id uuid NULL,
    target_resource text NULL,
    event_type text NOT NULL,
    outcome text NOT NULL,
    reason_code text NULL,
    metadata jsonb NOT NULL DEFAULT '{}'
  );
`;

const NOW = new Date('2025-01-15T12:00:00Z');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RAW_REFRESH_TOKEN = 'test-refresh-token-abcdefghijklmnopqrstuvwxyz';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

let ctx: PgMemContext;
let restore: () => void;
let originalJwtSecret: string | undefined;

beforeAll(async () => {
  originalJwtSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-refresh-routes-1';
  ctx = await createPgMem({ initSql: INIT_SQL });
});

afterAll(async () => {
  await ctx.stop();
  if (originalJwtSecret === undefined) {
    delete process.env['JWT_SECRET'];
  } else {
    process.env['JWT_SECRET'] = originalJwtSecret;
  }
});

beforeEach(async () => {
  restore = ctx.snapshot();

  // Seed a user and a valid refresh token.
  await ctx.withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, password_hash, role, email_verified_at)
       VALUES ($1, $2, $3, 'user', $4)`,
      [USER_ID, 'test@example.com', '$argon2id$v=19$m=65536,t=3,p=1$abc$def', NOW.toISOString()],
    );
    await c.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, client_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        USER_ID,
        sha256Hex(RAW_REFRESH_TOKEN),
        CLIENT_ID,
        new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
        NOW.toISOString(),
      ],
    );
  });
});

afterEach(() => {
  restore();
});

function jsonRequest(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /auth/refresh', () => {
  it('issues a new access token for a valid, non-revoked, non-expired refresh token with matching client_id', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest(
        '/auth/refresh',
        { refresh_token: RAW_REFRESH_TOKEN },
        { 'X-Client-Id': CLIENT_ID },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    expect(body.access_token).toBeDefined();
    expect(typeof body.access_token).toBe('string');
    expect(body.access_token.length).toBeGreaterThan(0);
    expect(body.expires_in).toBe(3600);
  });

  it('returns 401 and revokes the token when client_id does not match', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const wrongClientId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const res = await app.request(
      jsonRequest(
        '/auth/refresh',
        { refresh_token: RAW_REFRESH_TOKEN },
        { 'X-Client-Id': wrongClientId },
      ),
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_refresh_token');

    // Verify the token was revoked.
    const tokenRow = await ctx.withClient((c) =>
      c.query<{ revoked_at: string | null }>(
        `SELECT revoked_at FROM refresh_tokens WHERE token_hash = $1`,
        [sha256Hex(RAW_REFRESH_TOKEN)],
      ),
    );
    expect(tokenRow.rows[0]!.revoked_at).not.toBeNull();

    // Verify an audit row was written.
    const auditRow = await ctx.withClient((c) =>
      c.query<{ event_type: string; reason_code: string; metadata: string }>(
        `SELECT event_type, reason_code, metadata FROM audit_log
          WHERE event_type = 'refresh_token_rejected'`,
      ),
    );
    expect(auditRow.rows.length).toBe(1);
    expect(auditRow.rows[0]!.reason_code).toBe('client_id_mismatch');
  });

  it('returns 401 and writes audit when the token is expired', async () => {
    // Insert an expired token.
    const expiredToken = 'expired-refresh-token-xyz';
    await ctx.withClient(async (c) => {
      await c.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, client_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          USER_ID,
          sha256Hex(expiredToken),
          CLIENT_ID,
          new Date(NOW.getTime() - 1000).toISOString(), // expired 1 second ago
          new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        ],
      );
    });

    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest(
        '/auth/refresh',
        { refresh_token: expiredToken },
        { 'X-Client-Id': CLIENT_ID },
      ),
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_refresh_token');

    // Verify the token was revoked.
    const tokenRow = await ctx.withClient((c) =>
      c.query<{ revoked_at: string | null }>(
        `SELECT revoked_at FROM refresh_tokens WHERE token_hash = $1`,
        [sha256Hex(expiredToken)],
      ),
    );
    expect(tokenRow.rows[0]!.revoked_at).not.toBeNull();

    // Verify audit row.
    const auditRow = await ctx.withClient((c) =>
      c.query<{ reason_code: string }>(
        `SELECT reason_code FROM audit_log WHERE event_type = 'refresh_token_rejected'`,
      ),
    );
    expect(auditRow.rows.length).toBe(1);
    expect(auditRow.rows[0]!.reason_code).toBe('token_expired');
  });

  it('returns 401 and writes audit when the token is already revoked', async () => {
    // Revoke the existing token.
    await ctx.withClient(async (c) => {
      await c.query(
        `UPDATE refresh_tokens SET revoked_at = $1 WHERE token_hash = $2`,
        [new Date(NOW.getTime() - 60000).toISOString(), sha256Hex(RAW_REFRESH_TOKEN)],
      );
    });

    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest(
        '/auth/refresh',
        { refresh_token: RAW_REFRESH_TOKEN },
        { 'X-Client-Id': CLIENT_ID },
      ),
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_refresh_token');

    // Verify audit row with reason 'token_revoked'.
    const auditRow = await ctx.withClient((c) =>
      c.query<{ reason_code: string }>(
        `SELECT reason_code FROM audit_log WHERE event_type = 'refresh_token_rejected'`,
      ),
    );
    expect(auditRow.rows.length).toBe(1);
    expect(auditRow.rows[0]!.reason_code).toBe('token_revoked');
  });

  it('returns 401 for an unknown refresh token (no audit row)', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest(
        '/auth/refresh',
        { refresh_token: 'totally-unknown-token' },
        { 'X-Client-Id': CLIENT_ID },
      ),
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_refresh_token');

    // No audit row for unknown tokens.
    const auditRow = await ctx.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'refresh_token_rejected'`,
      ),
    );
    expect(Number(auditRow.rows[0]!.count)).toBe(0);
  });

  it('returns 400 for missing refresh_token in body', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/refresh', {}, { 'X-Client-Id': CLIENT_ID }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  });

  it('returns 400 for non-JSON body', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      new Request('http://test/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-Client-Id': CLIENT_ID },
        body: 'not json',
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_json');
  });
});

describe('POST /auth/logout', () => {
  it('revokes the refresh token and returns {ok: true}', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/logout', { refresh_token: RAW_REFRESH_TOKEN }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Verify the token was revoked.
    const tokenRow = await ctx.withClient((c) =>
      c.query<{ revoked_at: string | null }>(
        `SELECT revoked_at FROM refresh_tokens WHERE token_hash = $1`,
        [sha256Hex(RAW_REFRESH_TOKEN)],
      ),
    );
    expect(tokenRow.rows[0]!.revoked_at).not.toBeNull();
  });

  it('returns {ok: true} for an unknown token (no information leakage)', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/logout', { refresh_token: 'unknown-token-xyz' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns {ok: true} for an already-revoked token (idempotent)', async () => {
    // Revoke the token first.
    await ctx.withClient(async (c) => {
      await c.query(
        `UPDATE refresh_tokens SET revoked_at = $1 WHERE token_hash = $2`,
        [NOW.toISOString(), sha256Hex(RAW_REFRESH_TOKEN)],
      );
    });

    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/logout', { refresh_token: RAW_REFRESH_TOKEN }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 400 for missing refresh_token in body', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/logout', {}),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  });

  it('returns 400 for non-JSON body', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      new Request('http://test/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'not json',
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_json');
  });
});
