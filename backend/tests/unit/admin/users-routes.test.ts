import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';
import { DataType } from 'pg-mem';

/**
 * Integration tests for `PATCH /admin/users/:id/role` and
 * `POST /admin/users/:id/entitlement-adjust`.
 *
 * Validates: Requirements 2.5, 2.6, 6.5, 11.3, 11.4, 11.5.
 *
 * Uses pg-mem. The FOR UPDATE lock is parsed as a no-op by pg-mem,
 * which is acceptable for these tests since we are not testing
 * concurrency here — only the transactional logic and guard behavior.
 * `hashtextextended` and `pg_advisory_xact_lock` are registered as
 * no-ops for the same reason.
 */

const INIT_SQL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    password_hash text NOT NULL DEFAULT 'hash',
    role text NOT NULL DEFAULT 'user',
    email_verified_at timestamptz NULL,
    locked_until timestamptz NULL,
    failed_login_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
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
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  );

  CREATE TABLE entitlement_ledger (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    ts timestamptz NOT NULL DEFAULT now(),
    session_delta int NOT NULL,
    lifetime_flag_set text NOT NULL,
    reason text NOT NULL,
    razorpay_payment_id text NULL,
    interview_session_id uuid NULL,
    acting_admin_id uuid NULL,
    resulting_session_count int NOT NULL,
    resulting_lifetime_flag boolean NOT NULL,
    note text NULL
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

  CREATE TABLE interview_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    status text NOT NULL,
    started_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    ended_at timestamptz NULL,
    ended_reason text NULL
  );
`;

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN2_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NONEXISTENT_ID = '99999999-9999-4999-8999-999999999999';

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-admin-users-routes-1';

  // Create pg-mem without initSql so we can register functions first.
  ctx = await createPgMem({});

  // Register pg functions that pg-mem doesn't support natively.
  // These are no-ops for unit tests (concurrency is not tested here).
  ctx.db.public.registerFunction({
    name: 'hashtextextended',
    args: [DataType.text, DataType.bigint],
    returns: DataType.bigint,
    implementation: (text: string) => {
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
      }
      return hash;
    },
  });

  ctx.db.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.bigint],
    returns: DataType.null,
    implementation: () => null,
  });

  // Now run the schema setup.
  ctx.db.public.none(INIT_SQL);
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
});

afterEach(() => {
  restore();
});

/** Seed users for tests. */
async function seedUsers() {
  await ctx.pool.query(
    `INSERT INTO users (id, email, role) VALUES ($1, $2, 'admin')`,
    [ADMIN_ID, 'admin@test.com'],
  );
  await ctx.pool.query(
    `INSERT INTO users (id, email, role) VALUES ($1, $2, 'user')`,
    [USER_ID, 'user@test.com'],
  );
}

async function seedTwoAdmins() {
  await seedUsers();
  await ctx.pool.query(
    `INSERT INTO users (id, email, role) VALUES ($1, $2, 'admin')`,
    [ADMIN2_ID, 'admin2@test.com'],
  );
}

async function makeAdminToken(sub: string = ADMIN_ID): Promise<string> {
  const result = await signAccessToken({ sub, role: 'admin', clientId: CLIENT_ID });
  return result.token;
}

async function makeUserToken(sub: string = USER_ID): Promise<string> {
  const result = await signAccessToken({ sub, role: 'user', clientId: CLIENT_ID });
  return result.token;
}

function patchRole(app: ReturnType<typeof buildApp>, targetId: string, body: unknown, token: string) {
  return app.request(`/admin/users/${targetId}/role`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe('PATCH /admin/users/:id/role', () => {
  describe('authentication and authorization', () => {
    it('returns 403 when no Authorization header is provided', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const res = await app.request(`/admin/users/${USER_ID}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('role_change_not_permitted');
    });

    it('returns 403 when caller is not an admin', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeUserToken();
      const res = await patchRole(app, USER_ID, { role: 'admin' }, token);
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('role_change_not_permitted');
    });
  });

  describe('successful role changes', () => {
    it('promotes a user to admin', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await patchRole(app, USER_ID, { role: 'admin' }, token);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, role: 'admin' });

      // Verify the user's role was actually updated.
      const dbResult = await ctx.pool.query('SELECT role FROM users WHERE id = $1', [USER_ID]);
      expect(dbResult.rows[0]?.role).toBe('admin');
    });

    it('demotes an admin to user when other admins exist', async () => {
      await seedTwoAdmins();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await patchRole(app, ADMIN2_ID, { role: 'user' }, token);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, role: 'user' });

      // Verify the role was updated.
      const dbResult = await ctx.pool.query('SELECT role FROM users WHERE id = $1', [ADMIN2_ID]);
      expect(dbResult.rows[0]?.role).toBe('user');
    });

    it('writes an audit log entry on successful role change', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      await patchRole(app, USER_ID, { role: 'admin' }, token);

      const auditResult = await ctx.pool.query(
        `SELECT * FROM audit_log WHERE event_type = 'role_change'`,
      );
      expect(auditResult.rows.length).toBe(1);
      const row = auditResult.rows[0] as Record<string, unknown>;
      expect(row.actor_user_id).toBe(ADMIN_ID);
      expect(row.target_user_id).toBe(USER_ID);
      expect(row.outcome).toBe('success');
      const metadata = row.metadata as Record<string, unknown>;
      expect(metadata.previous_role).toBe('user');
      expect(metadata.new_role).toBe('admin');
    });
  });

  describe('at-least-one-admin guard', () => {
    it('rejects demotion of the last admin with 403', async () => {
      await seedUsers(); // Only one admin (ADMIN_ID)
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await patchRole(app, ADMIN_ID, { role: 'user' }, token);
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('role_change_not_permitted');

      // Verify the role was NOT changed.
      const dbResult = await ctx.pool.query('SELECT role FROM users WHERE id = $1', [ADMIN_ID]);
      expect(dbResult.rows[0]?.role).toBe('admin');
    });

    it('does not write an audit log entry when demotion is rejected', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      await patchRole(app, ADMIN_ID, { role: 'user' }, token);

      const auditResult = await ctx.pool.query(
        `SELECT * FROM audit_log WHERE event_type = 'role_change'`,
      );
      expect(auditResult.rows.length).toBe(0);
    });
  });

  describe('nonexistent user', () => {
    it('returns 403 for a nonexistent target user (indistinguishable from unauthorized)', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await patchRole(app, NONEXISTENT_ID, { role: 'admin' }, token);
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('role_change_not_permitted');
    });
  });

  describe('input validation', () => {
    it('returns 400 for invalid JSON body', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await app.request(`/admin/users/${USER_ID}/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: 'not json',
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request_body');
    });

    it('returns 400 for invalid role value', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await patchRole(app, USER_ID, { role: 'superadmin' }, token);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request_body');
    });

    it('returns 403 for invalid UUID target id', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await patchRole(app, 'not-a-uuid', { role: 'admin' }, token);
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('role_change_not_permitted');
    });
  });

  describe('no-op role change', () => {
    it('succeeds when setting the same role (user -> user)', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await patchRole(app, USER_ID, { role: 'user' }, token);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, role: 'user' });
    });

    it('succeeds when setting the same role (admin -> admin)', async () => {
      await seedTwoAdmins();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await patchRole(app, ADMIN2_ID, { role: 'admin' }, token);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, role: 'admin' });
    });
  });
});


// ---------------------------------------------------------------------------
// POST /admin/users/:id/entitlement-adjust
// ---------------------------------------------------------------------------

function postEntitlementAdjust(
  app: ReturnType<typeof buildApp>,
  targetId: string,
  body: unknown,
  token: string,
) {
  return app.request(`/admin/users/${targetId}/entitlement-adjust`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /admin/users/:id/entitlement-adjust', () => {
  describe('authentication and authorization', () => {
    it('returns 403 when no Authorization header is provided', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const res = await app.request(`/admin/users/${USER_ID}/entitlement-adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_delta: 5, note: 'grant sessions' }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 403 when caller is not an admin', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeUserToken();
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: 5, note: 'grant' }, token);
      expect(res.status).toBe(403);
    });
  });

  describe('input validation', () => {
    it('returns 400 for invalid JSON body', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await app.request(`/admin/users/${USER_ID}/entitlement-adjust`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: 'not json',
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request_body');
    });

    it('returns 400 when session_delta is 0', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: 0, note: 'test' }, token);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('invalid_request_body');
      expect(body.error.message).toContain('session_delta must not be 0');
    });

    it('returns 400 when session_delta exceeds 1000', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: 1001, note: 'test' }, token);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request_body');
    });

    it('returns 400 when session_delta is below -1000', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: -1001, note: 'test' }, token);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request_body');
    });

    it('returns 400 when session_delta is not an integer', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: 1.5, note: 'test' }, token);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request_body');
    });

    it('returns 400 when note is empty', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: 5, note: '' }, token);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe('invalid_request_body');
      expect(body.error.message).toContain('note must be at least 1 character');
    });

    it('returns 400 when note exceeds 500 characters', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const longNote = 'x'.repeat(501);
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: 5, note: longNote }, token);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request_body');
    });

    it('returns 400 when note is missing', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: 5 }, token);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request_body');
    });

    it('returns 400 when session_delta is missing', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await postEntitlementAdjust(app, USER_ID, { note: 'test' }, token);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request_body');
    });
  });

  describe('target user not found', () => {
    it('returns 404 for a nonexistent target user', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await postEntitlementAdjust(app, NONEXISTENT_ID, { session_delta: 5, note: 'grant' }, token);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('user_not_found');
    });

    it('returns 404 for an invalid UUID', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await postEntitlementAdjust(app, 'not-a-uuid', { session_delta: 5, note: 'grant' }, token);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('user_not_found');
    });
  });

  describe('successful adjustments', () => {
    it('grants sessions and returns resulting state', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: 10, note: 'bonus grant' }, token);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; resulting_session_count: number; resulting_lifetime_flag: boolean };
      expect(body.ok).toBe(true);
      expect(body.resulting_session_count).toBe(10);
      expect(body.resulting_lifetime_flag).toBe(false);
    });

    it('revokes sessions and returns resulting state', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();

      // First grant some sessions
      await postEntitlementAdjust(app, USER_ID, { session_delta: 20, note: 'initial grant' }, token);

      // Then revoke some
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: -5, note: 'partial revoke' }, token);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; resulting_session_count: number; resulting_lifetime_flag: boolean };
      expect(body.ok).toBe(true);
      expect(body.resulting_session_count).toBe(15);
      expect(body.resulting_lifetime_flag).toBe(false);
    });

    it('writes a ledger entry with correct fields', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      await postEntitlementAdjust(app, USER_ID, { session_delta: 7, note: 'test grant' }, token);

      const ledgerResult = await ctx.pool.query(
        `SELECT * FROM entitlement_ledger WHERE user_id = $1`,
        [USER_ID],
      );
      expect(ledgerResult.rows.length).toBe(1);
      const row = ledgerResult.rows[0] as Record<string, unknown>;
      expect(row.session_delta).toBe(7);
      expect(row.reason).toBe('admin_adjustment');
      expect(row.acting_admin_id).toBe(ADMIN_ID);
      expect(row.resulting_session_count).toBe(7);
      expect(row.resulting_lifetime_flag).toBe(false);
      expect(row.note).toBe('test grant');
    });

    it('writes an audit log entry with correct fields', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      await postEntitlementAdjust(app, USER_ID, { session_delta: 3, note: 'audit test' }, token);

      const auditResult = await ctx.pool.query(
        `SELECT * FROM audit_log WHERE event_type = 'entitlement_adjustment'`,
      );
      expect(auditResult.rows.length).toBe(1);
      const row = auditResult.rows[0] as Record<string, unknown>;
      expect(row.actor_user_id).toBe(ADMIN_ID);
      expect(row.target_user_id).toBe(USER_ID);
      expect(row.outcome).toBe('success');
      const metadata = row.metadata as Record<string, unknown>;
      expect(metadata.session_delta).toBe(3);
      expect(metadata.note).toBe('audit test');
      expect(metadata.resulting_session_count).toBe(3);
      expect(metadata.resulting_lifetime_flag).toBe(false);
    });

    it('accepts boundary value session_delta = 1000', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: 1000, note: 'max grant' }, token);
      expect(res.status).toBe(200);
      const body = await res.json() as { resulting_session_count: number };
      expect(body.resulting_session_count).toBe(1000);
    });

    it('accepts boundary value session_delta = -1000 when balance is sufficient', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();

      // Grant first
      await postEntitlementAdjust(app, USER_ID, { session_delta: 1000, note: 'grant' }, token);

      // Revoke max
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: -1000, note: 'max revoke' }, token);
      expect(res.status).toBe(200);
      const body = await res.json() as { resulting_session_count: number };
      expect(body.resulting_session_count).toBe(0);
    });
  });

  describe('insufficient balance', () => {
    it('returns 400 when revoke would cause negative balance for non-lifetime user', async () => {
      await seedUsers();
      const app = buildApp({ pool: ctx.pool });
      const token = await makeAdminToken();

      // User has 0 sessions, try to revoke
      const res = await postEntitlementAdjust(app, USER_ID, { session_delta: -1, note: 'revoke' }, token);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('no_sessions_remaining');
    });
  });
});
