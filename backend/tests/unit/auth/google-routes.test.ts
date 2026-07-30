/**
 * Unit tests for POST /auth/google.
 *
 * The Google ID-token verifier is injected (deps.verifyGoogleIdToken) so these
 * tests exercise the user upsert branches and token issuance without contacting
 * Google. The Postgres pool is mocked; query dispatch is by SQL content so the
 * assertions are resilient to statement ordering.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  buildAuthGoogleRouter,
  GoogleAuthError,
  type GoogleIdentity,
} from '../../../src/auth/google-routes.js';

// signAccessToken needs a secret; set one for the whole file.
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-value-for-google-routes-unit-tests-1234567890';
});

interface Scenario {
  byGoogleSub?: Record<string, unknown> | undefined;
  byEmail?: Record<string, unknown> | undefined;
  fresh: { role: string; display_name: string | null; email: string };
}

function createMockPool(scenario: Scenario) {
  const calls = { insertUser: 0, linkUpdate: 0, insertRefresh: 0 };

  const query = vi.fn(async (sql: string) => {
    if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
    if (sql.includes('FROM users WHERE google_sub')) {
      return { rows: scenario.byGoogleSub ? [scenario.byGoogleSub] : [] };
    }
    if (sql.includes('FROM users WHERE LOWER(email)')) {
      return { rows: scenario.byEmail ? [scenario.byEmail] : [] };
    }
    if (sql.includes('UPDATE users') && sql.includes('google_sub')) {
      calls.linkUpdate++;
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO users')) {
      calls.insertUser++;
      return { rows: [] };
    }
    if (sql.includes('SELECT role, display_name, email FROM users WHERE id')) {
      return { rows: [scenario.fresh] };
    }
    if (sql.includes('INSERT INTO refresh_tokens')) {
      calls.insertRefresh++;
      return { rows: [] };
    }
    return { rows: [] };
  });

  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), query } as any;
  return { pool, calls, client };
}

function makeRequest(router: ReturnType<typeof buildAuthGoogleRouter>, body: unknown) {
  return router.request('/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_IDENTITY: GoogleIdentity = {
  sub: 'google-sub-123',
  email: 'user@example.com',
  emailVerified: true,
  name: 'Test User',
};

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

describe('POST /auth/google', () => {
  it('creates a new user when neither google_sub nor email matches', async () => {
    const { pool, calls } = createMockPool({
      fresh: { role: 'user', display_name: 'Test User', email: 'user@example.com' },
    });
    const router = buildAuthGoogleRouter({
      pool,
      verifyGoogleIdToken: async () => VALID_IDENTITY,
    });

    const res = await makeRequest(router, { id_token: 'x', client_id: CLIENT_ID });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(typeof json.access_token).toBe('string');
    expect((json.access_token as string).split('.').length).toBe(3); // JWT
    expect(typeof json.refresh_token).toBe('string');
    expect(json.role).toBe('user');
    expect(json.expires_in).toBe(3600);
    expect(calls.insertUser).toBe(1);
    expect(calls.linkUpdate).toBe(0);
    expect(calls.insertRefresh).toBe(1);
  });

  it('links Google to an existing account matched by email (no new user)', async () => {
    const { pool, calls } = createMockPool({
      byEmail: { id: 'user-2', email: 'user@example.com', role: 'admin', display_name: null },
      fresh: { role: 'admin', display_name: null, email: 'user@example.com' },
    });
    const router = buildAuthGoogleRouter({
      pool,
      verifyGoogleIdToken: async () => VALID_IDENTITY,
    });

    const res = await makeRequest(router, { id_token: 'x', client_id: CLIENT_ID });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.role).toBe('admin');
    expect(calls.linkUpdate).toBe(1);
    expect(calls.insertUser).toBe(0);
    expect(calls.insertRefresh).toBe(1);
  });

  it('signs in an existing account matched by google_sub', async () => {
    const { pool, calls } = createMockPool({
      byGoogleSub: { id: 'user-3', email: 'user@example.com', role: 'user', display_name: 'Existing' },
      fresh: { role: 'user', display_name: 'Existing', email: 'user@example.com' },
    });
    const router = buildAuthGoogleRouter({
      pool,
      verifyGoogleIdToken: async () => VALID_IDENTITY,
    });

    const res = await makeRequest(router, { id_token: 'x', client_id: CLIENT_ID });
    expect(res.status).toBe(200);
    expect(calls.insertUser).toBe(0);
    expect(calls.linkUpdate).toBe(0);
    expect(calls.insertRefresh).toBe(1);
  });

  it('rejects an unverified Google email with 403', async () => {
    const { pool } = createMockPool({
      fresh: { role: 'user', display_name: null, email: 'user@example.com' },
    });
    const router = buildAuthGoogleRouter({
      pool,
      verifyGoogleIdToken: async () => ({ ...VALID_IDENTITY, emailVerified: false }),
    });

    const res = await makeRequest(router, { id_token: 'x', client_id: CLIENT_ID });
    expect(res.status).toBe(403);
    const json = await res.json() as { error?: { code?: string } };
    expect(json.error?.code).toBe('email_not_verified');
  });

  it('returns 401 when token verification fails', async () => {
    const { pool } = createMockPool({
      fresh: { role: 'user', display_name: null, email: 'user@example.com' },
    });
    const router = buildAuthGoogleRouter({
      pool,
      verifyGoogleIdToken: async () => {
        throw new GoogleAuthError('invalid_google_token', 'bad token');
      },
    });

    const res = await makeRequest(router, { id_token: 'x', client_id: CLIENT_ID });
    expect(res.status).toBe(401);
  });

  it('returns 503 when Google is not configured on the server', async () => {
    const { pool } = createMockPool({
      fresh: { role: 'user', display_name: null, email: 'user@example.com' },
    });
    const router = buildAuthGoogleRouter({
      pool,
      verifyGoogleIdToken: async () => {
        throw new GoogleAuthError('google_not_configured', 'not configured');
      },
    });

    const res = await makeRequest(router, { id_token: 'x', client_id: CLIENT_ID });
    expect(res.status).toBe(503);
  });

  it('rejects invalid input (missing id_token) with 400', async () => {
    const { pool } = createMockPool({
      fresh: { role: 'user', display_name: null, email: 'user@example.com' },
    });
    const router = buildAuthGoogleRouter({
      pool,
      verifyGoogleIdToken: async () => VALID_IDENTITY,
    });

    const res = await makeRequest(router, { client_id: CLIENT_ID });
    expect(res.status).toBe(400);
  });
});
