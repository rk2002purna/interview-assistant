import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';

/**
 * Integration tests for `PATCH /admin/rate-limits/:user_id`.
 *
 * Validates: Requirements 12.4.
 *
 * Uses pg-mem for fast in-memory testing.
 */

const INIT_SQL = `
  CREATE TABLE rate_limit_overrides (
    user_id          uuid PRIMARY KEY,
    ai_per_min       int NULL CHECK (ai_per_min IS NULL OR ai_per_min BETWEEN 0 AND 100000),
    ai_per_day       int NULL CHECK (ai_per_day IS NULL OR ai_per_day BETWEEN 0 AND 100000),
    session_per_hour int NULL CHECK (session_per_hour IS NULL OR session_per_hour BETWEEN 0 AND 100000),
    updated_at       timestamptz NOT NULL DEFAULT now()
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
`;

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_USER_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-rate-limits-routes-1';
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

async function countAuditRows(): Promise<number> {
  return ctx.withClient(async (c) => {
    const r = await c.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log WHERE event_type = 'rate_limit_override_change'`,
    );
    return parseInt(r.rows[0]?.count ?? '0', 10);
  });
}

async function getOverrides(userId: string) {
  return ctx.withClient(async (c) => {
    const r = await c.query<{
      ai_per_min: number | null;
      ai_per_day: number | null;
      session_per_hour: number | null;
    }>(`SELECT ai_per_min, ai_per_day, session_per_hour FROM rate_limit_overrides WHERE user_id = $1`, [
      userId,
    ]);
    return r.rows[0] ?? null;
  });
}

describe('PATCH /admin/rate-limits/:user_id', () => {
  describe('authentication and authorization', () => {
    it('returns 403 when no Authorization header is provided', async () => {
      const app = makeApp();
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_per_minute: 100 }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('forbidden');
    });

    it('returns 403 when caller is not an admin', async () => {
      const app = makeApp();
      const bearer = await userBearer();
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: 100 }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('forbidden');
    });
  });

  describe('input validation', () => {
    it('returns 400 for invalid UUID', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request('/admin/rate-limits/not-a-uuid', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: 100 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_user_id');
    });

    it('returns 400 for invalid JSON body', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: 'not json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_request_body');
    });

    it('returns 400 when no override fields are provided', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_request_body');
    });

    it('returns 400 when ai_per_minute is negative', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: -1 }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when ai_per_minute exceeds 100000', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: 100001 }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when ai_per_day is not an integer', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_day: 3.5 }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for unknown fields (strict mode)', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: 100, unknown_field: 42 }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('successful upsert', () => {
    it('creates overrides for a new user', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: 120, ai_per_day: 5000 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.overrides.ai_per_minute).toBe(120);
      expect(body.overrides.ai_per_day).toBe(5000);
      expect(body.overrides.session_start_per_hour).toBeNull();

      // Verify DB state.
      const overrides = await getOverrides(TARGET_USER_ID);
      expect(overrides).not.toBeNull();
      expect(overrides!.ai_per_min).toBe(120);
      expect(overrides!.ai_per_day).toBe(5000);
      expect(overrides!.session_per_hour).toBeNull();
    });

    it('updates existing overrides (partial update preserves unset fields)', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      // First: set ai_per_minute and session_start_per_hour.
      await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: 100, session_start_per_hour: 10 }),
      });

      // Second: update only ai_per_day.
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_day: 2000 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.overrides.ai_per_minute).toBe(100); // preserved
      expect(body.overrides.ai_per_day).toBe(2000); // new
      expect(body.overrides.session_start_per_hour).toBe(10); // preserved
    });

    it('allows setting a value to null (clears override)', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      // First: set ai_per_minute.
      await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: 100 }),
      });

      // Second: clear it by setting to null.
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.overrides.ai_per_minute).toBeNull();
    });

    it('allows boundary value 0', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: 0 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.overrides.ai_per_minute).toBe(0);
    });

    it('allows boundary value 100000', async () => {
      const app = makeApp();
      const bearer = await adminBearer();
      const res = await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ session_start_per_hour: 100000 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.overrides.session_start_per_hour).toBe(100000);
    });
  });

  describe('audit logging', () => {
    it('writes an audit row on successful override change', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      const beforeCount = await countAuditRows();

      await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: 200 }),
      });

      const afterCount = await countAuditRows();
      expect(afterCount).toBe(beforeCount + 1);
    });

    it('audit row contains previous and new values', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      // Set initial values.
      await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: 50 }),
      });

      // Update values.
      await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: 200 }),
      });

      // Check the latest audit row.
      const auditRow = await ctx.withClient(async (c) => {
        const r = await c.query<{ metadata: string | Record<string, unknown> }>(
          `SELECT metadata FROM audit_log WHERE event_type = 'rate_limit_override_change' ORDER BY ts DESC LIMIT 1`,
        );
        return r.rows[0];
      });

      expect(auditRow).toBeDefined();
      const metadata =
        typeof auditRow!.metadata === 'string'
          ? JSON.parse(auditRow!.metadata)
          : auditRow!.metadata;
      expect(metadata.previous.ai_per_minute).toBe(50);
      expect(metadata.new.ai_per_minute).toBe(200);
    });

    it('does not write audit row on validation failure', async () => {
      const app = makeApp();
      const bearer = await adminBearer();

      const beforeCount = await countAuditRows();

      await app.request(`/admin/rate-limits/${TARGET_USER_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: bearer,
        },
        body: JSON.stringify({ ai_per_minute: -1 }),
      });

      const afterCount = await countAuditRows();
      expect(afterCount).toBe(beforeCount);
    });
  });
});
