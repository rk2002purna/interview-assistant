import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';

/**
 * Integration tests for `GET /admin/welcome-offer` and
 * `PATCH /admin/welcome-offer`.
 *
 * Validates: Requirements 5.7, 5.10, 11.8.
 *
 * Uses pg-mem; the routes do not rely on any concurrency primitives
 * not supported by pg-mem (the `FOR UPDATE` clause is parsed and
 * accepted as a no-op by pg-mem, which is acceptable here because the
 * audit + update are still wrapped in a single transaction).
 */

const INIT_SQL = `
  CREATE TABLE welcome_offer (
    id integer PRIMARY KEY,
    enabled boolean NOT NULL,
    ends_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
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

  INSERT INTO welcome_offer (id, enabled, ends_at, created_at, updated_at)
  VALUES (1, true, '2025-06-01T00:00:00Z', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
`;

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_ENDS_AT = '2026-01-15T12:00:00.000Z';

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-welcome-offer-routes-1';
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
      `SELECT COUNT(*)::text AS count FROM audit_log WHERE event_type = 'welcome_offer_update'`,
    );
    return Number(r.rows[0]?.count ?? 0);
  });
}

describe('GET /admin/welcome-offer', () => {
  it('returns 403 forbidden_role when no Authorization header is supplied', async () => {
    const res = await makeApp().request('/admin/welcome-offer');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden_role');
  });

  it('returns 403 forbidden_role when the caller is a non-admin user', async () => {
    const res = await makeApp().request('/admin/welcome-offer', {
      headers: { Authorization: await userBearer() },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden_role');
  });

  it('returns the singleton row to an admin caller', async () => {
    const res = await makeApp().request('/admin/welcome-offer', {
      headers: { Authorization: await adminBearer() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      welcome_offer: {
        enabled: boolean;
        ends_at: string;
        created_at: string;
        updated_at: string;
      };
    };
    expect(body.welcome_offer.enabled).toBe(true);
    expect(new Date(body.welcome_offer.ends_at).toISOString()).toBe(
      '2025-06-01T00:00:00.000Z',
    );
  });
});

describe('PATCH /admin/welcome-offer', () => {
  it('returns 403 for unauthenticated callers and writes no audit row', async () => {
    const res = await makeApp().request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
    expect(await countAuditRows()).toBe(0);
  });

  it('returns 403 for non-admin callers and writes no audit row', async () => {
    const res = await makeApp().request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await userBearer(),
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects an empty body with 400 invalid_welcome_offer_update', async () => {
    const res = await makeApp().request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_welcome_offer_update');
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects malformed JSON with 400 invalid_body', async () => {
    const res = await makeApp().request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });

  it('rejects an unparseable ends_at with 400', async () => {
    const res = await makeApp().request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ ends_at: 'not-a-date' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_welcome_offer_update');
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects unknown fields with 400 (strict schema)', async () => {
    const res = await makeApp().request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ enabled: false, mystery_field: 1 }),
    });
    expect(res.status).toBe(400);
    expect(await countAuditRows()).toBe(0);
  });

  it('updates enabled and ends_at and returns previous and new values', async () => {
    const res = await makeApp().request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ enabled: false, ends_at: NEW_ENDS_AT }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      welcome_offer: { enabled: boolean; ends_at: string };
      previous: { enabled: boolean; ends_at: string };
      new: { enabled: boolean; ends_at: string };
    };
    expect(body.welcome_offer.enabled).toBe(false);
    expect(new Date(body.welcome_offer.ends_at).toISOString()).toBe(NEW_ENDS_AT);
    expect(body.previous.enabled).toBe(true);
    expect(new Date(body.previous.ends_at).toISOString()).toBe(
      '2025-06-01T00:00:00.000Z',
    );
    expect(body.new.enabled).toBe(false);
    expect(new Date(body.new.ends_at).toISOString()).toBe(NEW_ENDS_AT);
  });

  it('persists the change so a follow-up GET returns the new values', async () => {
    const app = makeApp();
    await app.request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ enabled: false, ends_at: NEW_ENDS_AT }),
    });
    const res = await app.request('/admin/welcome-offer', {
      headers: { Authorization: await adminBearer() },
    });
    const body = (await res.json()) as {
      welcome_offer: { enabled: boolean; ends_at: string };
    };
    expect(body.welcome_offer.enabled).toBe(false);
    expect(new Date(body.welcome_offer.ends_at).toISOString()).toBe(NEW_ENDS_AT);
  });

  it('writes one audit row per successful update with previous/new values', async () => {
    expect(await countAuditRows()).toBe(0);
    const res = await makeApp().request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);

    const audits = await ctx.withClient(async (c) => {
      const r = await c.query<{
        actor_user_id: string;
        target_resource: string;
        event_type: string;
        outcome: string;
        metadata: { previous: { enabled: boolean }; new: { enabled: boolean } };
      }>(
        `SELECT actor_user_id, target_resource, event_type, outcome, metadata
           FROM audit_log
          WHERE event_type = 'welcome_offer_update'`,
      );
      return r.rows;
    });

    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actor_user_id).toBe(ADMIN_ID);
    expect(audit.target_resource).toBe('welcome_offer');
    expect(audit.outcome).toBe('success');
    const meta =
      typeof audit.metadata === 'string'
        ? JSON.parse(audit.metadata)
        : audit.metadata;
    expect(meta.previous.enabled).toBe(true);
    expect(meta.new.enabled).toBe(false);
  });

  it('does not write an audit row when the patch is a no-op', async () => {
    // Current row is enabled=true, ends_at=2025-06-01.
    const res = await makeApp().request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({
        enabled: true,
        ends_at: '2025-06-01T00:00:00.000Z',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      previous: { enabled: boolean };
      new: { enabled: boolean };
    };
    expect(body.previous.enabled).toBe(true);
    expect(body.new.enabled).toBe(true);
    expect(await countAuditRows()).toBe(0);
  });

  it('accepts a partial update of only enabled', async () => {
    const res = await makeApp().request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      welcome_offer: { enabled: boolean; ends_at: string };
    };
    expect(body.welcome_offer.enabled).toBe(false);
    // ends_at unchanged from seed
    expect(new Date(body.welcome_offer.ends_at).toISOString()).toBe(
      '2025-06-01T00:00:00.000Z',
    );
  });

  it('accepts a partial update of only ends_at', async () => {
    const res = await makeApp().request('/admin/welcome-offer', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ ends_at: NEW_ENDS_AT }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      welcome_offer: { enabled: boolean; ends_at: string };
    };
    expect(body.welcome_offer.enabled).toBe(true);
    expect(new Date(body.welcome_offer.ends_at).toISOString()).toBe(NEW_ENDS_AT);
  });
});
