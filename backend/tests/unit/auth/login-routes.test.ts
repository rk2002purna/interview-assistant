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
import { hash as hashPassword } from '../../../src/auth/password.js';
import {
  LOCKOUT_THRESHOLD,
  LOCKOUT_DURATION_MS,
  LOCKOUT_WINDOW_MS,
  REFRESH_TOKEN_TTL_MS,
} from '../../../src/auth/login-routes.js';
import { ACCESS_TOKEN_TTL_SECONDS } from '../../../src/auth/jwt.js';

/**
 * Tests for `POST /auth/login`.
 *
 * Validates: Requirements 1.2, 1.5.
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

const VALID_PASSWORD = 'Sup3r$ecretPass!';
const NOW = new Date('2025-01-15T12:00:00Z');
const CLIENT_ID = '550e8400-e29b-41d4-a716-446655440000';

let ctx: PgMemContext;
let restore: () => void;
let passwordHash: string;
const userId = '11111111-1111-1111-1111-111111111111';

beforeAll(async () => {
  process.env['JWT_SECRET'] = 'test-jwt-secret-that-is-long-enough-for-hs256';
  ctx = await createPgMem({ initSql: INIT_SQL });
  passwordHash = await hashPassword(VALID_PASSWORD);
});

afterAll(async () => {
  await ctx.stop();
  delete process.env['JWT_SECRET'];
});

beforeEach(async () => {
  restore = ctx.snapshot();
  // Insert a verified user for login tests.
  await ctx.withClient((c) =>
    c.query(
      `INSERT INTO users (id, email, password_hash, role, email_verified_at)
       VALUES ($1, $2, $3, 'user', $4)`,
      [userId, 'user@example.com', passwordHash, NOW.toISOString()],
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

describe('POST /auth/login', () => {
  it('returns access_token, refresh_token, expires_in, and role on valid credentials', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    const res = await app.request(
      jsonRequest('/auth/login', {
        email: 'user@example.com',
        password: VALID_PASSWORD,
        client_id: CLIENT_ID,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      role: string;
    };
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(body.role).toBe('user');
  });

  it('stores refresh token hash bound to client_id in refresh_tokens table', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    const res = await app.request(
      jsonRequest('/auth/login', {
        email: 'user@example.com',
        password: VALID_PASSWORD,
        client_id: CLIENT_ID,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh_token: string };
    const expectedHash = sha256Hex(body.refresh_token);

    const row = await ctx.withClient((c) =>
      c.query<{ token_hash: string; client_id: string; user_id: string }>(
        `SELECT token_hash, client_id, user_id FROM refresh_tokens WHERE user_id = $1`,
        [userId],
      ),
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0]!.token_hash).toBe(expectedHash);
    expect(row.rows[0]!.client_id).toBe(CLIENT_ID);
  });

  it('rejects with 401 when email does not exist', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    const res = await app.request(
      jsonRequest('/auth/login', {
        email: 'nonexistent@example.com',
        password: VALID_PASSWORD,
        client_id: CLIENT_ID,
      }),
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_credentials');
  });

  it('rejects with 401 when password is incorrect', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    const res = await app.request(
      jsonRequest('/auth/login', {
        email: 'user@example.com',
        password: 'WrongPassword123!',
        client_id: CLIENT_ID,
      }),
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_credentials');
  });

  it('rejects with 403 when email is not verified', async () => {
    // Insert an unverified user.
    const unverifiedId = '22222222-2222-2222-2222-222222222222';
    await ctx.withClient((c) =>
      c.query(
        `INSERT INTO users (id, email, password_hash, role, email_verified_at)
         VALUES ($1, $2, $3, 'user', NULL)`,
        [unverifiedId, 'unverified@example.com', passwordHash],
      ),
    );

    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    const res = await app.request(
      jsonRequest('/auth/login', {
        email: 'unverified@example.com',
        password: VALID_PASSWORD,
        client_id: CLIENT_ID,
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('email_not_verified');
  });

  it('rejects with 400 when request body is invalid', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    const res = await app.request(
      jsonRequest('/auth/login', {
        email: 'user@example.com',
        // missing password and client_id
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  });

  it('rejects with 400 when client_id is not a valid UUID', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    const res = await app.request(
      jsonRequest('/auth/login', {
        email: 'user@example.com',
        password: VALID_PASSWORD,
        client_id: 'not-a-uuid',
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  });

  describe('lockout state machine (R1.5)', () => {
    it('locks account after 5 failed attempts and returns 429 with Retry-After', async () => {
      const app = buildApp({ pool: ctx.pool, now: () => NOW });

      // Make 5 failed attempts.
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        const res = await app.request(
          jsonRequest('/auth/login', {
            email: 'user@example.com',
            password: 'WrongPassword123!',
            client_id: CLIENT_ID,
          }),
        );
        if (i < LOCKOUT_THRESHOLD - 1) {
          expect(res.status).toBe(401);
        } else {
          // The 5th attempt triggers lockout.
          expect(res.status).toBe(429);
          const body = (await res.json()) as { error: { code: string; details?: { retry_after: number } } };
          expect(body.error.code).toBe('account_locked');
          expect(body.error.details?.retry_after).toBe(Math.ceil(LOCKOUT_DURATION_MS / 1000));
          expect(res.headers.get('Retry-After')).toBe(String(Math.ceil(LOCKOUT_DURATION_MS / 1000)));
        }
      }
    });

    it('rejects valid credentials during lockout with 429', async () => {
      const app = buildApp({ pool: ctx.pool, now: () => NOW });

      // Lock the account.
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await app.request(
          jsonRequest('/auth/login', {
            email: 'user@example.com',
            password: 'WrongPassword123!',
            client_id: CLIENT_ID,
          }),
        );
      }

      // Try with correct password during lockout.
      const res = await app.request(
        jsonRequest('/auth/login', {
          email: 'user@example.com',
          password: VALID_PASSWORD,
          client_id: CLIENT_ID,
        }),
      );

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('account_locked');
    });

    it('allows login after lockout expires', async () => {
      let currentTime = NOW;
      const app = buildApp({ pool: ctx.pool, now: () => currentTime });

      // Lock the account.
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await app.request(
          jsonRequest('/auth/login', {
            email: 'user@example.com',
            password: 'WrongPassword123!',
            client_id: CLIENT_ID,
          }),
        );
      }

      // Advance time past lockout.
      currentTime = new Date(NOW.getTime() + LOCKOUT_DURATION_MS + 1000);

      const res = await app.request(
        jsonRequest('/auth/login', {
          email: 'user@example.com',
          password: VALID_PASSWORD,
          client_id: CLIENT_ID,
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { access_token: string };
      expect(body.access_token).toBeTruthy();
    });

    it('resets failed_login_count on successful login', async () => {
      const app = buildApp({ pool: ctx.pool, now: () => NOW });

      // Make 3 failed attempts (below threshold).
      for (let i = 0; i < 3; i++) {
        await app.request(
          jsonRequest('/auth/login', {
            email: 'user@example.com',
            password: 'WrongPassword123!',
            client_id: CLIENT_ID,
          }),
        );
      }

      // Successful login.
      const res = await app.request(
        jsonRequest('/auth/login', {
          email: 'user@example.com',
          password: VALID_PASSWORD,
          client_id: CLIENT_ID,
        }),
      );
      expect(res.status).toBe(200);

      // Verify counter is reset.
      const row = await ctx.withClient((c) =>
        c.query<{ failed_login_count: number }>(
          `SELECT failed_login_count FROM users WHERE id = $1`,
          [userId],
        ),
      );
      expect(row.rows[0]!.failed_login_count).toBe(0);
    });
  });

  it('is case-insensitive for email lookup', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    const res = await app.request(
      jsonRequest('/auth/login', {
        email: 'USER@EXAMPLE.COM',
        password: VALID_PASSWORD,
        client_id: CLIENT_ID,
      }),
    );

    expect(res.status).toBe(200);
  });

  it('returns role=admin for admin users', async () => {
    const adminId = '33333333-3333-3333-3333-333333333333';
    await ctx.withClient((c) =>
      c.query(
        `INSERT INTO users (id, email, password_hash, role, email_verified_at)
         VALUES ($1, $2, $3, 'admin', $4)`,
        [adminId, 'admin@example.com', passwordHash, NOW.toISOString()],
      ),
    );

    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    const res = await app.request(
      jsonRequest('/auth/login', {
        email: 'admin@example.com',
        password: VALID_PASSWORD,
        client_id: CLIENT_ID,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe('admin');
  });

  it('sets refresh token expiry to 30 days from now', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    await app.request(
      jsonRequest('/auth/login', {
        email: 'user@example.com',
        password: VALID_PASSWORD,
        client_id: CLIENT_ID,
      }),
    );

    const row = await ctx.withClient((c) =>
      c.query<{ expires_at: string }>(
        `SELECT expires_at FROM refresh_tokens WHERE user_id = $1`,
        [userId],
      ),
    );
    expect(row.rows.length).toBe(1);
    const expiresAt = new Date(row.rows[0]!.expires_at).getTime();
    expect(expiresAt).toBe(NOW.getTime() + REFRESH_TOKEN_TTL_MS);
  });
});
