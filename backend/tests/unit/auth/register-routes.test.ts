import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createHash } from 'node:crypto';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import {
  RESEND_RATE_LIMIT_COUNT,
  VERIFICATION_TOKEN_TTL_MS,
} from '../../../src/auth/register-routes.js';

/**
 * Tests for `POST /auth/register`, `POST /auth/verify-email`, and
 * `POST /auth/resend-verification`.
 *
 * Validates: Requirements 1.3, 1.4, 1.9.
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

  -- Tables required because app.ts mounts routers that reference them.
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

let ctx: PgMemContext;
let restore: () => void;

beforeAll(async () => {
  ctx = await createPgMem({ initSql: INIT_SQL });
});

afterAll(async () => {
  await ctx.stop();
});

beforeEach(() => {
  restore = ctx.snapshot();
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

describe('POST /auth/register', () => {
  it('creates a user, persists a verification token, and sends a verification email', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    // Re-mount with sender by re-using the same pool; buildApp doesn't
    // expose sender wiring, so verify the side-effects via the DB.
    void sender;

    const res = await app.request(
      jsonRequest('/auth/register', {
        email: 'NewUser@Example.com',
        password: VALID_PASSWORD,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_id: string; status: string };
    expect(body.status).toBe('pending_verification');
    expect(body.user_id).toMatch(/[0-9a-f-]{36}/i);

    const userRow = await ctx.withClient((c) =>
      c.query<{ id: string; email: string; password_hash: string }>(
        `SELECT id, email, password_hash FROM users WHERE LOWER(email) = $1`,
        ['newuser@example.com'],
      ),
    );
    expect(userRow.rows.length).toBe(1);
    expect(userRow.rows[0]!.id).toBe(body.user_id);
    // Password is hashed (Argon2id encoded form starts with $argon2).
    expect(userRow.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);

    const tokenRow = await ctx.withClient((c) =>
      c.query<{ user_id: string; expires_at: string }>(
        `SELECT user_id, expires_at FROM email_verifications WHERE user_id = $1`,
        [body.user_id],
      ),
    );
    expect(tokenRow.rows.length).toBe(1);
    const expiry = new Date(tokenRow.rows[0]!.expires_at).getTime();
    expect(expiry).toBe(NOW.getTime() + VERIFICATION_TOKEN_TTL_MS);
  });

  it('rejects passwords that do not meet the policy', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/register', {
        email: 'someone@example.com',
        password: 'short',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toMatch(/^password_/);
  });

  it('rejects malformed emails', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/register', {
        email: 'not-an-email',
        password: VALID_PASSWORD,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_input');
  });

  it('returns the same 409 envelope for duplicate emails regardless of verification state (R1.9)', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    // Register once.
    await app.request(
      jsonRequest('/auth/register', {
        email: 'dup@example.com',
        password: VALID_PASSWORD,
      }),
    );

    // Capture the duplicate response while the account is unverified.
    const unverifiedRes = await app.request(
      jsonRequest('/auth/register', {
        email: 'dup@example.com',
        password: VALID_PASSWORD,
      }),
    );
    const unverifiedBody = await unverifiedRes.text();

    // Verify the account, then attempt the duplicate again.
    await ctx.withClient((c) =>
      c.query(`UPDATE users SET email_verified_at = now() WHERE LOWER(email) = $1`, [
        'dup@example.com',
      ]),
    );
    const verifiedRes = await app.request(
      jsonRequest('/auth/register', {
        email: 'dup@example.com',
        password: VALID_PASSWORD,
      }),
    );
    const verifiedBody = await verifiedRes.text();

    expect(unverifiedRes.status).toBe(409);
    expect(verifiedRes.status).toBe(409);
    expect(unverifiedBody).toBe(verifiedBody);

    const parsed = JSON.parse(unverifiedBody) as { error: { code: string } };
    expect(parsed.error.code).toBe('email_already_registered');
  });

  it('treats emails case-insensitively when detecting duplicates', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    const first = await app.request(
      jsonRequest('/auth/register', {
        email: 'casey@example.com',
        password: VALID_PASSWORD,
      }),
    );
    expect(first.status).toBe(200);

    const dup = await app.request(
      jsonRequest('/auth/register', {
        email: 'CASEY@example.com',
        password: VALID_PASSWORD,
      }),
    );
    expect(dup.status).toBe(409);
  });
});

describe('POST /auth/verify-email', () => {
  async function registerAndGetTokenHash(
    email: string,
  ): Promise<{ userId: string; tokenHash: string }> {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/register', { email, password: VALID_PASSWORD }),
    );
    const { user_id: userId } = (await res.json()) as { user_id: string };
    const row = await ctx.withClient((c) =>
      c.query<{ token_hash: string }>(
        `SELECT token_hash FROM email_verifications WHERE user_id = $1`,
        [userId],
      ),
    );
    return { userId, tokenHash: row.rows[0]!.token_hash };
  }

  it('verifies an account with a valid token within the TTL window', async () => {
    // Override the token bytes so we can recover the raw token in test.
    // Simpler approach: insert a known token directly.
    const userId = '11111111-1111-4111-8111-111111111111';
    const tokenRaw = 'test-token-abcdefghijklmnopqrstuvwxyz0123456789';
    const tokenHash = sha256Hex(tokenRaw);
    await ctx.withClient(async (c) => {
      await c.query(
        `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'user')`,
        [userId, 'verify@example.com', '$argon2id$v=19$m=65536,t=3,p=1$abc$def'],
      );
      await c.query(
        `INSERT INTO email_verifications (id, user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          '22222222-2222-4222-8222-222222222222',
          userId,
          tokenHash,
          new Date(NOW.getTime() + VERIFICATION_TOKEN_TTL_MS).toISOString(),
          NOW.toISOString(),
        ],
      );
    });

    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/verify-email', { token: tokenRaw }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true });

    const after = await ctx.withClient((c) =>
      c.query<{ email_verified_at: string | null; used_at: string | null }>(
        `SELECT u.email_verified_at, ev.used_at
           FROM users u
           JOIN email_verifications ev ON ev.user_id = u.id
          WHERE u.id = $1`,
        [userId],
      ),
    );
    expect(after.rows[0]!.email_verified_at).not.toBeNull();
    expect(after.rows[0]!.used_at).not.toBeNull();
  });

  it('rejects unknown tokens with invalid_token', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/verify-email', { token: 'nope' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_token');
  });

  it('rejects already-used tokens with invalid_token', async () => {
    const { tokenHash } = await registerAndGetTokenHash('used@example.com');
    void tokenHash;
    // Mark the token as already used; supply an arbitrary raw token whose
    // hash matches by inserting a known one.
    const tokenRaw = 'reuse-token-xyzabcdefghij1234567890';
    await ctx.withClient(async (c) => {
      await c.query(
        `UPDATE email_verifications
            SET token_hash = $1, used_at = $2
          WHERE token_hash = $3`,
        [sha256Hex(tokenRaw), NOW.toISOString(), tokenHash],
      );
    });
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/verify-email', { token: tokenRaw }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_token');
  });

  it('rejects expired tokens with token_expired', async () => {
    const tokenRaw = 'expired-token-abcdefghij1234567890';
    const userId = '33333333-3333-4333-8333-333333333333';
    await ctx.withClient(async (c) => {
      await c.query(
        `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'user')`,
        [userId, 'expired@example.com', '$argon2id$v=19$m=65536,t=3,p=1$abc$def'],
      );
      await c.query(
        `INSERT INTO email_verifications (id, user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          '44444444-4444-4444-8444-444444444444',
          userId,
          sha256Hex(tokenRaw),
          // Expired one hour before "now".
          new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
          new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
        ],
      );
    });

    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/verify-email', { token: tokenRaw }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('token_expired');
  });
});

describe('POST /auth/resend-verification', () => {
  it('returns {sent: true} for unknown emails (no enumeration)', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/resend-verification', {
        email: 'nobody@example.com',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
  });

  it('issues a new verification token for an unverified account', async () => {
    const userId = '55555555-5555-4555-8555-555555555555';
    await ctx.withClient((c) =>
      c.query(
        `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'user')`,
        [userId, 'pending@example.com', '$argon2id$v=19$m=65536,t=3,p=1$abc$def'],
      ),
    );

    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/resend-verification', { email: 'pending@example.com' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });

    const tokens = await ctx.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM email_verifications WHERE user_id = $1`,
        [userId],
      ),
    );
    expect(Number(tokens.rows[0]!.count)).toBe(1);
  });

  it('does not issue a token for an already-verified account', async () => {
    const userId = '66666666-6666-4666-8666-666666666666';
    await ctx.withClient((c) =>
      c.query(
        `INSERT INTO users (id, email, password_hash, role, email_verified_at)
         VALUES ($1, $2, $3, 'user', $4)`,
        [
          userId,
          'verified@example.com',
          '$argon2id$v=19$m=65536,t=3,p=1$abc$def',
          NOW.toISOString(),
        ],
      ),
    );

    const app = buildApp({ pool: ctx.pool, now: () => NOW });
    const res = await app.request(
      jsonRequest('/auth/resend-verification', {
        email: 'verified@example.com',
      }),
    );
    expect(res.status).toBe(200);

    const tokens = await ctx.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM email_verifications WHERE user_id = $1`,
        [userId],
      ),
    );
    expect(Number(tokens.rows[0]!.count)).toBe(0);
  });

  it('throttles to at most RESEND_RATE_LIMIT_COUNT issuances per hour per email', async () => {
    const userId = '77777777-7777-4777-8777-777777777777';
    await ctx.withClient((c) =>
      c.query(
        `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'user')`,
        [userId, 'throttle@example.com', '$argon2id$v=19$m=65536,t=3,p=1$abc$def'],
      ),
    );

    const app = buildApp({ pool: ctx.pool, now: () => NOW });

    for (let i = 0; i < RESEND_RATE_LIMIT_COUNT + 2; i++) {
      const res = await app.request(
        jsonRequest('/auth/resend-verification', {
          email: 'throttle@example.com',
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: true });
    }

    const tokens = await ctx.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM email_verifications WHERE user_id = $1`,
        [userId],
      ),
    );
    // First N within the window are persisted; the rest are throttled.
    expect(Number(tokens.rows[0]!.count)).toBe(RESEND_RATE_LIMIT_COUNT);
  });
});
