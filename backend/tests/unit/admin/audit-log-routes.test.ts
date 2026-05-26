import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';

/**
 * Integration tests for `GET /admin/audit-log` with cursor pagination.
 *
 * Validates: Requirements 14.4.
 *
 * Uses pg-mem for fast in-memory testing.
 */

const INIT_SQL = `
  CREATE TABLE audit_log (
    id              uuid PRIMARY KEY,
    ts              timestamptz NOT NULL DEFAULT now(),
    actor_user_id   uuid NULL,
    target_user_id  uuid NULL,
    target_resource text NULL,
    event_type      text NOT NULL,
    outcome         text NOT NULL CHECK (outcome IN ('success', 'failure')),
    reason_code     text NULL,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
  );

  CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC);
`;

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_A = '33333333-3333-4333-8333-333333333333';
const ACTOR_B = '44444444-4444-4444-8444-444444444444';
const TARGET_A = '55555555-5555-4555-8555-555555555555';

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-audit-log-routes-1';
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
});

afterEach(() => {
  restore();
});

async function adminBearer(): Promise<string> {
  const { token } = await signAccessToken({
    sub: ADMIN_ID,
    role: 'admin',
    clientId: CLIENT_ID,
  });
  return `Bearer ${token}`;
}

async function userBearer(): Promise<string> {
  const { token } = await signAccessToken({
    sub: USER_ID,
    role: 'user',
    clientId: CLIENT_ID,
  });
  return `Bearer ${token}`;
}

function makeApp() {
  return buildApp({ pool: ctx.pool });
}

/** Insert an audit log entry with explicit id and ts for deterministic ordering. */
async function insertAuditEntry(opts: {
  id: string;
  ts: string;
  actor_user_id?: string | null;
  target_user_id?: string | null;
  target_resource?: string | null;
  event_type: string;
  outcome: string;
  reason_code?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await ctx.withClient(async (c) => {
    await c.query(
      `INSERT INTO audit_log (id, ts, actor_user_id, target_user_id, target_resource, event_type, outcome, reason_code, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        opts.id,
        opts.ts,
        opts.actor_user_id ?? null,
        opts.target_user_id ?? null,
        opts.target_resource ?? null,
        opts.event_type,
        opts.outcome,
        opts.reason_code ?? null,
        JSON.stringify(opts.metadata ?? {}),
      ],
    );
  });
}

describe('GET /admin/audit-log', () => {
  describe('authentication and authorization', () => {
    it('returns 403 when no Authorization header is provided', async () => {
      const app = makeApp();
      const res = await app.request('/admin/audit-log');
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('forbidden');
    });

    it('returns 403 when caller is not an admin', async () => {
      const app = makeApp();
      const bearer = await userBearer();
      const res = await app.request('/admin/audit-log', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('forbidden');
    });

    it('returns 403 for malformed Authorization header', async () => {
      const app = makeApp();
      const res = await app.request('/admin/audit-log', {
        headers: { Authorization: 'NotBearer token' },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('empty result set', () => {
    it('returns empty items array and null next_cursor when no entries exist', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request('/admin/audit-log', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([]);
      expect(body.next_cursor).toBeNull();
    });
  });

  describe('basic pagination', () => {
    it('returns entries in reverse-chronological order', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      // Insert entries with different timestamps
      await insertAuditEntry({
        id: '00000001-0001-4001-8001-000000000001',
        ts: '2024-01-01T10:00:00Z',
        event_type: 'login_success',
        outcome: 'success',
        actor_user_id: ACTOR_A,
      });
      await insertAuditEntry({
        id: '00000002-0002-4002-8002-000000000002',
        ts: '2024-01-01T11:00:00Z',
        event_type: 'role_change',
        outcome: 'success',
        actor_user_id: ACTOR_B,
      });
      await insertAuditEntry({
        id: '00000003-0003-4003-8003-000000000003',
        ts: '2024-01-01T12:00:00Z',
        event_type: 'pack_change',
        outcome: 'success',
        actor_user_id: ACTOR_A,
      });

      const res = await app.request('/admin/audit-log', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(3);
      // Most recent first
      expect(body.items[0].event_type).toBe('pack_change');
      expect(body.items[1].event_type).toBe('role_change');
      expect(body.items[2].event_type).toBe('login_success');
      expect(body.next_cursor).toBeNull();
    });

    it('respects page_size parameter', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      // Insert 3 entries
      await insertAuditEntry({
        id: '00000001-0001-4001-8001-000000000001',
        ts: '2024-01-01T10:00:00Z',
        event_type: 'login_success',
        outcome: 'success',
      });
      await insertAuditEntry({
        id: '00000002-0002-4002-8002-000000000002',
        ts: '2024-01-01T11:00:00Z',
        event_type: 'role_change',
        outcome: 'success',
      });
      await insertAuditEntry({
        id: '00000003-0003-4003-8003-000000000003',
        ts: '2024-01-01T12:00:00Z',
        event_type: 'pack_change',
        outcome: 'success',
      });

      const res = await app.request('/admin/audit-log?page_size=2', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(2);
      expect(body.next_cursor).not.toBeNull();
    });

    it('cursor pagination returns next page correctly', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      // Insert 3 entries
      await insertAuditEntry({
        id: '00000001-0001-4001-8001-000000000001',
        ts: '2024-01-01T10:00:00Z',
        event_type: 'login_success',
        outcome: 'success',
      });
      await insertAuditEntry({
        id: '00000002-0002-4002-8002-000000000002',
        ts: '2024-01-01T11:00:00Z',
        event_type: 'role_change',
        outcome: 'success',
      });
      await insertAuditEntry({
        id: '00000003-0003-4003-8003-000000000003',
        ts: '2024-01-01T12:00:00Z',
        event_type: 'pack_change',
        outcome: 'success',
      });

      // First page
      const res1 = await app.request('/admin/audit-log?page_size=2', {
        headers: { Authorization: bearer },
      });
      const body1 = await res1.json();
      expect(body1.items).toHaveLength(2);
      expect(body1.items[0].event_type).toBe('pack_change');
      expect(body1.items[1].event_type).toBe('role_change');
      expect(body1.next_cursor).not.toBeNull();

      // Second page using cursor
      const res2 = await app.request(`/admin/audit-log?page_size=2&cursor=${body1.next_cursor}`, {
        headers: { Authorization: bearer },
      });
      const body2 = await res2.json();
      expect(body2.items).toHaveLength(1);
      expect(body2.items[0].event_type).toBe('login_success');
      expect(body2.next_cursor).toBeNull();
    });
  });

  describe('filters', () => {
    it('filters by actor', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      await insertAuditEntry({
        id: '00000001-0001-4001-8001-000000000001',
        ts: '2024-01-01T10:00:00Z',
        event_type: 'login_success',
        outcome: 'success',
        actor_user_id: ACTOR_A,
      });
      await insertAuditEntry({
        id: '00000002-0002-4002-8002-000000000002',
        ts: '2024-01-01T11:00:00Z',
        event_type: 'role_change',
        outcome: 'success',
        actor_user_id: ACTOR_B,
      });

      const res = await app.request(`/admin/audit-log?actor=${ACTOR_A}`, {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].actor).toBe(ACTOR_A);
    });

    it('filters by target', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      await insertAuditEntry({
        id: '00000001-0001-4001-8001-000000000001',
        ts: '2024-01-01T10:00:00Z',
        event_type: 'role_change',
        outcome: 'success',
        target_user_id: TARGET_A,
      });
      await insertAuditEntry({
        id: '00000002-0002-4002-8002-000000000002',
        ts: '2024-01-01T11:00:00Z',
        event_type: 'login_success',
        outcome: 'success',
        target_user_id: ACTOR_B,
      });

      const res = await app.request(`/admin/audit-log?target=${TARGET_A}`, {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].target).toBe(TARGET_A);
    });

    it('filters by event_type', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      await insertAuditEntry({
        id: '00000001-0001-4001-8001-000000000001',
        ts: '2024-01-01T10:00:00Z',
        event_type: 'login_success',
        outcome: 'success',
      });
      await insertAuditEntry({
        id: '00000002-0002-4002-8002-000000000002',
        ts: '2024-01-01T11:00:00Z',
        event_type: 'role_change',
        outcome: 'success',
      });

      const res = await app.request('/admin/audit-log?event_type=role_change', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].event_type).toBe('role_change');
    });

    it('filters by date range (from/to)', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      await insertAuditEntry({
        id: '00000001-0001-4001-8001-000000000001',
        ts: '2024-01-01T10:00:00Z',
        event_type: 'login_success',
        outcome: 'success',
      });
      await insertAuditEntry({
        id: '00000002-0002-4002-8002-000000000002',
        ts: '2024-01-15T10:00:00Z',
        event_type: 'role_change',
        outcome: 'success',
      });
      await insertAuditEntry({
        id: '00000003-0003-4003-8003-000000000003',
        ts: '2024-02-01T10:00:00Z',
        event_type: 'pack_change',
        outcome: 'success',
      });

      const res = await app.request(
        '/admin/audit-log?from=2024-01-10T00:00:00Z&to=2024-01-20T00:00:00Z',
        { headers: { Authorization: bearer } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].event_type).toBe('role_change');
    });
  });

  describe('input validation', () => {
    it('returns 400 for invalid page_size (too large)', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request('/admin/audit-log?page_size=201', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_page_size');
    });

    it('returns 400 for invalid page_size (zero)', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request('/admin/audit-log?page_size=0', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_page_size');
    });

    it('returns 400 for non-integer page_size', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request('/admin/audit-log?page_size=abc', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_page_size');
    });

    it('returns 400 for invalid actor UUID', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request('/admin/audit-log?actor=not-a-uuid', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_filter');
    });

    it('returns 400 for invalid target UUID', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request('/admin/audit-log?target=not-a-uuid', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_filter');
    });

    it('returns 400 for invalid from date', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request('/admin/audit-log?from=not-a-date', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_filter');
    });

    it('returns 400 for invalid to date', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request('/admin/audit-log?to=not-a-date', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_filter');
    });

    it('returns 400 when from is after to', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request(
        '/admin/audit-log?from=2024-02-01T00:00:00Z&to=2024-01-01T00:00:00Z',
        { headers: { Authorization: bearer } },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_filter');
    });

    it('returns 400 for invalid cursor UUID', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request('/admin/audit-log?cursor=not-a-uuid', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_cursor');
    });
  });

  describe('response shape', () => {
    it('returns all expected fields in each item', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      await insertAuditEntry({
        id: '00000001-0001-4001-8001-000000000001',
        ts: '2024-01-01T10:00:00Z',
        event_type: 'login_success',
        outcome: 'success',
        actor_user_id: ACTOR_A,
        target_user_id: TARGET_A,
        target_resource: 'user',
        reason_code: 'normal_login',
        metadata: { ip: '127.0.0.1' },
      });

      const res = await app.request('/admin/audit-log', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);

      const item = body.items[0];
      expect(item.id).toBe('00000001-0001-4001-8001-000000000001');
      expect(item.ts).toBeDefined();
      expect(item.actor).toBe(ACTOR_A);
      expect(item.target).toBe(TARGET_A);
      expect(item.target_resource).toBe('user');
      expect(item.event_type).toBe('login_success');
      expect(item.outcome).toBe('success');
      expect(item.reason_code).toBe('normal_login');
      expect(item.metadata).toEqual({ ip: '127.0.0.1' });
    });
  });

  describe('default page_size', () => {
    it('uses default page_size of 50 when not specified', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      // Insert 51 entries to verify default page size
      for (let i = 1; i <= 51; i++) {
        const paddedI = String(i).padStart(4, '0');
        await insertAuditEntry({
          id: `${paddedI}0001-0001-4001-8001-000000000001`,
          ts: `2024-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
          event_type: 'login_success',
          outcome: 'success',
        });
      }

      const res = await app.request('/admin/audit-log', {
        headers: { Authorization: bearer },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(50);
      expect(body.next_cursor).not.toBeNull();
    });
  });
});
