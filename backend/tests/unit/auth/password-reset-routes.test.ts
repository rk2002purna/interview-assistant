import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { createHash } from 'node:crypto';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { PASSWORD_RESET_TOKEN_TTL_MS } from '../../../src/auth/password-reset-routes.js';

/**
 * Tests for `POST /auth/password-reset/request` and
 * `POST /auth/password-reset/confirm`.
 *
 * Validates: Requirements 1.3.
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

  CREATE TABLE email_verifications (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE password_resets (
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

const VALID_PASSWORD = 'Sup3r$ecretPass!';
const NEW_PASSWORD = 'N3wP@ssword!xyz';
const NOW = new Date('2025-01-15T12:00:00Z');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const USER_EMAIL = 'user@example.com';
const USER_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$abc$def';

let ctx: PgMemContext;
let restore: () => void;

beforeAll(async () => {
  ctx = await createPgMem({ initSql: INIT_SQL });
});

afterAll(async () => {
  await ctx.stop();
});

beforeEach(async () => {
  restore = ctx.snapshot();
  // Insert a test user for most tests.
  await ctx.withClient((c) =>
    c.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'user')`,
      [USER_ID, USER_EMAIL, USER_PASSWORD_HASH],
    ),
  );
});

afterEach(() => {
  restore();
});

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('POST /auth/password-reset/request', () => {
  it('returns {sent: true} when user exists and creates a password_resets row', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/password-reset/request', { email: USER_EMAIL }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });

    // Verify a password_resets row was created.
    const rows = await ctx.withClient((c) =>
      c.query<{ user_id: string; expires_at: string; used_at: string | null }>(
        `SELECT user_id, expires_at, used_at FROM password_resets WHERE user_id = $1`,
        [USER_ID],
      ),
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.user_id).toBe(USER_ID);
    expect(rows.rows[0]!.used_at).toBeNull();

    // Verify TTL is 60 minutes.
    const expiry = new Date(rows.rows[0]!.expires_at).getTime();
    expect(expiry).toBe(NOW.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);
  });

  it('returns {sent: true} for non-existent emails (no enumeration)', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/password-reset/request', { email: 'nobody@example.com' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });

    // No password_resets row should be created.
    const rows = await ctx.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM password_resets`,
      ),
    );
    expect(Number(rows.rows[0]!.count)).toBe(0);
  });

  it('returns {sent: true} for malformed JSON input', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      new Request('http://test/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
  });

  it('returns {sent: true} for invalid email format', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/password-reset/request', { email: 'not-an-email' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
  });

  it('treats emails case-insensitively', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/password-reset/request', { email: 'USER@EXAMPLE.COM' }),
    );

    expect(res.status).toBe(200);

    const rows = await ctx.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM password_resets WHERE user_id = $1`,
        [USER_ID],
      ),
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });
});

describe('POST /auth/password-reset/confirm', () => {
  const TOKEN_RAW = 'test-reset-token-abcdefghijklmnopqrstuvwxyz01234';

  async function insertResetToken(opts?: {
    expiresAt?: Date;
    usedAt?: Date | null;
    tokenRaw?: string;
  }): Promise<void> {
    const raw = opts?.tokenRaw ?? TOKEN_RAW;
    const tokenHash = sha256Hex(raw);
    const expiresAt = opts?.expiresAt ?? new Date(NOW.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);
    const usedAt = opts?.usedAt ?? null;

    await ctx.withClient((c) =>
      c.query(
        `INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          '22222222-2222-4222-8222-222222222222',
          USER_ID,
          tokenHash,
          expiresAt.toISOString(),
          usedAt?.toISOString() ?? null,
          NOW.toISOString(),
        ],
      ),
    );
  }

  it('resets the password with a valid token', async () => {
    await insertResetToken();

    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/password-reset/confirm', {
        token: TOKEN_RAW,
        new_password: NEW_PASSWORD,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reset: true });

    // Verify the user's password_hash was updated.
    const userRow = await ctx.withClient((c) =>
      c.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [USER_ID],
      ),
    );
    expect(userRow.rows[0]!.password_hash).not.toBe(USER_PASSWORD_HASH);
    expect(userRow.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);

    // Verify the token was marked as used.
    const tokenRow = await ctx.withClient((c) =>
      c.query<{ used_at: string | null }>(
        `SELECT used_at FROM password_resets WHERE user_id = $1`,
        [USER_ID],
      ),
    );
    expect(tokenRow.rows[0]!.used_at).not.toBeNull();
  });

  it('rejects unknown tokens with invalid_token', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/password-reset/confirm', {
        token: 'nonexistent-token',
        new_password: NEW_PASSWORD,
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_token');
  });

  it('rejects already-used tokens with invalid_token', async () => {
    await insertResetToken({ usedAt: new Date(NOW.getTime() - 10_000) });

    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/password-reset/confirm', {
        token: TOKEN_RAW,
        new_password: NEW_PASSWORD,
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_token');
  });

  it('rejects expired tokens with token_expired', async () => {
    await insertResetToken({
      expiresAt: new Date(NOW.getTime() - 1000), // expired 1 second ago
    });

    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/password-reset/confirm', {
        token: TOKEN_RAW,
        new_password: NEW_PASSWORD,
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('token_expired');
  });

  it('rejects new passwords that violate the policy', async () => {
    await insertResetToken();

    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/password-reset/confirm', {
        token: TOKEN_RAW,
        new_password: 'short',
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toMatch(/^password_/);

    // Verify the user's password was NOT changed.
    const userRow = await ctx.withClient((c) =>
      c.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [USER_ID],
      ),
    );
    expect(userRow.rows[0]!.password_hash).toBe(USER_PASSWORD_HASH);
  });

  it('rejects malformed JSON with invalid_json', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      new Request('http://test/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_json');
  });

  it('rejects missing fields with invalid_input', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/password-reset/confirm', { token: TOKEN_RAW }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  });
});
