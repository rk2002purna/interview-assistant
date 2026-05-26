import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';

/**
 * Integration tests for `GET /admin/packs` and
 * `PATCH /admin/packs/:slug`.
 *
 * Validates: Requirements 5.5, 5.6, 11.6.
 *
 * Uses pg-mem; the routes do not rely on concurrency primitives that
 * pg-mem does not support. `FOR UPDATE` is parsed as a no-op which is
 * acceptable here because the read + update + audit row are still
 * wrapped in a single transaction.
 */

const INIT_SQL = `
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

  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    role text NOT NULL DEFAULT 'user',
    email_verified_at timestamptz NULL,
    locked_until timestamptz NULL,
    failed_login_count int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE purchases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    pack_slug text NOT NULL REFERENCES packs(slug),
    effective_price_paise bigint NOT NULL,
    mrp_at_purchase_paise bigint NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    razorpay_order_id text NOT NULL UNIQUE,
    razorpay_payment_id text NULL,
    welcome_offer_applied boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz NULL
  );

  CREATE TABLE audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ts timestamptz NOT NULL DEFAULT now(),
    actor_user_id uuid NULL,
    target_user_id uuid NULL,
    target_resource text NULL,
    event_type text NOT NULL,
    outcome text NOT NULL,
    reason_code text NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  );

  INSERT INTO packs (slug, display_name, description, mrp_paise, welcome_price_paise, session_count, is_lifetime, active, updated_at)
  VALUES
    ('starter', 'Starter', '5 Interview Sessions.', 99900, 49900, 5, false, true, '2025-01-01T00:00:00Z'),
    ('pro', 'Pro', '15 Interview Sessions.', 249900, 99900, 15, false, true, '2025-01-01T00:00:00Z'),
    ('lifetime', 'Lifetime', 'Unlimited Interview Sessions.', 999900, 199900, NULL, true, true, '2025-01-01T00:00:00Z');

  INSERT INTO users (id, email, password_hash, role)
  VALUES ('33333333-3333-4333-8333-333333333333', 'buyer@test.com', 'hash', 'user');
`;

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-admin-packs-routes-1';
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
      `SELECT COUNT(*)::text AS count FROM audit_log WHERE event_type = 'pack_update'`,
    );
    return Number(r.rows[0]?.count ?? 0);
  });
}

async function readPack(slug: string): Promise<{
  display_name: string;
  description: string;
  mrp_paise: number;
  welcome_price_paise: number;
  session_count: number | null;
  is_lifetime: boolean;
  active: boolean;
} | undefined> {
  return ctx.withClient(async (c) => {
    const r = await c.query<{
      display_name: string;
      description: string;
      mrp_paise: string | number;
      welcome_price_paise: string | number;
      session_count: number | null;
      is_lifetime: boolean;
      active: boolean;
    }>(
      `SELECT display_name, description, mrp_paise, welcome_price_paise,
              session_count, is_lifetime, active
         FROM packs
        WHERE slug = $1`,
      [slug],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      display_name: row.display_name,
      description: row.description,
      mrp_paise: Number(row.mrp_paise),
      welcome_price_paise: Number(row.welcome_price_paise),
      session_count: row.session_count,
      is_lifetime: row.is_lifetime,
      active: row.active,
    };
  });
}

describe('GET /admin/packs', () => {
  it('returns 403 when no Authorization header is supplied', async () => {
    const res = await makeApp().request('/admin/packs');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden_role');
  });

  it('returns 403 for non-admin callers', async () => {
    const res = await makeApp().request('/admin/packs', {
      headers: { Authorization: await userBearer() },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden_role');
  });

  it('returns all packs ordered starter, pro, lifetime to admins', async () => {
    const res = await makeApp().request('/admin/packs', {
      headers: { Authorization: await adminBearer() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      packs: Array<{
        slug: string;
        display_name: string;
        mrp_paise: number;
        welcome_price_paise: number;
        discount_percent: number;
        session_count: number | null;
        is_lifetime: boolean;
        active: boolean;
      }>;
    };
    expect(body.packs.map((p) => p.slug)).toEqual(['starter', 'pro', 'lifetime']);
    const starter = body.packs[0]!;
    expect(starter.mrp_paise).toBe(99900);
    expect(starter.welcome_price_paise).toBe(49900);
    expect(starter.discount_percent).toBe(50);
    expect(starter.session_count).toBe(5);
    expect(starter.is_lifetime).toBe(false);
    const lifetime = body.packs[2]!;
    expect(lifetime.is_lifetime).toBe(true);
    expect(lifetime.session_count).toBeNull();
  });

  it('includes inactive packs in the listing', async () => {
    await ctx.withClient(async (c) => {
      await c.query(`UPDATE packs SET active = false WHERE slug = 'starter'`);
    });
    const res = await makeApp().request('/admin/packs', {
      headers: { Authorization: await adminBearer() },
    });
    const body = (await res.json()) as {
      packs: Array<{ slug: string; active: boolean }>;
    };
    expect(body.packs).toHaveLength(3);
    expect(body.packs.find((p) => p.slug === 'starter')?.active).toBe(false);
  });
});

describe('PATCH /admin/packs/:slug', () => {
  it('returns 403 for unauthenticated callers and writes no audit row', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ welcome_price_paise: 39900 }),
    });
    expect(res.status).toBe(403);
    expect(await countAuditRows()).toBe(0);
  });

  it('returns 403 for non-admin callers and writes no audit row', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await userBearer(),
      },
      body: JSON.stringify({ welcome_price_paise: 39900 }),
    });
    expect(res.status).toBe(403);
    expect(await countAuditRows()).toBe(0);
  });

  it('returns 404 for an unknown slug', async () => {
    const res = await makeApp().request('/admin/packs/mystery', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ welcome_price_paise: 1 }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('pack_not_found');
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects malformed JSON with 400 invalid_request_body', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request_body');
  });

  it('rejects an empty body with 400 invalid_pack_update', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_pack_update');
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects unknown fields (strict schema)', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ welcome_price_paise: 39900, mystery_field: 1 }),
    });
    expect(res.status).toBe(400);
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects welcome_price >= mrp with 400 and identifies the offending field', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      // mrp 99900, welcome equal to mrp -> reject (R5.5)
      body: JSON.stringify({ welcome_price_paise: 99900 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { field?: string } };
    };
    expect(body.error.code).toBe('invalid_pack_update');
    expect(body.error.details?.field).toBe('welcome_price_paise');
    expect(await countAuditRows()).toBe(0);
    // Pack unchanged.
    const after = await readPack('starter');
    expect(after?.welcome_price_paise).toBe(49900);
  });

  it('rejects welcome_price strictly greater than mrp with 400', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ welcome_price_paise: 100000 }),
    });
    expect(res.status).toBe(400);
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects mrp_paise out of range with 400', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ mrp_paise: 0 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { field?: string } };
    };
    expect(body.error.code).toBe('invalid_pack_update');
    expect(body.error.details?.field).toBe('mrp_paise');
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects mrp_paise above the cap with 400', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ mrp_paise: 100_000_001 }),
    });
    expect(res.status).toBe(400);
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects setting session_count on a lifetime pack (lifetime XOR session_count)', async () => {
    const res = await makeApp().request('/admin/packs/lifetime', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ session_count: 5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { field?: string } };
    };
    expect(body.error.code).toBe('invalid_pack_update');
    expect(body.error.details?.field).toBe('session_count');
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects clearing session_count on a non-lifetime pack', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ session_count: null }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { field?: string } };
    };
    expect(body.error.code).toBe('invalid_pack_update');
    expect(body.error.details?.field).toBe('session_count');
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects negative session_count with 400', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ session_count: -1 }),
    });
    expect(res.status).toBe(400);
    expect(await countAuditRows()).toBe(0);
  });

  it('rejects display_name longer than 50 chars with 400', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ display_name: 'x'.repeat(51) }),
    });
    expect(res.status).toBe(400);
    expect(await countAuditRows()).toBe(0);
  });

  it('updates a pack and returns the persisted row', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ welcome_price_paise: 39900, display_name: 'Starter+' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pack: {
        slug: string;
        display_name: string;
        welcome_price_paise: number;
        mrp_paise: number;
        discount_percent: number;
      };
    };
    expect(body.pack.slug).toBe('starter');
    expect(body.pack.display_name).toBe('Starter+');
    expect(body.pack.welcome_price_paise).toBe(39900);
    expect(body.pack.mrp_paise).toBe(99900);
    // floor((99900 - 39900) / 99900 * 100) = 60
    expect(body.pack.discount_percent).toBe(60);

    const row = await readPack('starter');
    expect(row?.welcome_price_paise).toBe(39900);
    expect(row?.display_name).toBe('Starter+');
  });

  it('writes a single audit row with previous and new values on a successful update', async () => {
    expect(await countAuditRows()).toBe(0);
    const res = await makeApp().request('/admin/packs/pro', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ welcome_price_paise: 89900, active: false }),
    });
    expect(res.status).toBe(200);
    expect(await countAuditRows()).toBe(1);

    const audits = await ctx.withClient(async (c) => {
      const r = await c.query<{
        actor_user_id: string;
        target_resource: string;
        event_type: string;
        outcome: string;
        metadata: unknown;
      }>(
        `SELECT actor_user_id, target_resource, event_type, outcome, metadata
           FROM audit_log
          WHERE event_type = 'pack_update'`,
      );
      return r.rows;
    });
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actor_user_id).toBe(ADMIN_ID);
    expect(audit.target_resource).toBe('pack:pro');
    expect(audit.outcome).toBe('success');
    const meta =
      typeof audit.metadata === 'string'
        ? (JSON.parse(audit.metadata) as { previous: any; new: any; slug: string })
        : (audit.metadata as { previous: any; new: any; slug: string });
    expect(meta.slug).toBe('pro');
    expect(meta.previous.welcome_price_paise).toBe(99900);
    expect(meta.previous.active).toBe(true);
    expect(meta.new.welcome_price_paise).toBe(89900);
    expect(meta.new.active).toBe(false);
  });

  it('does not write an audit row or update on a no-op patch', async () => {
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ welcome_price_paise: 49900 }),
    });
    expect(res.status).toBe(200);
    expect(await countAuditRows()).toBe(0);
    const row = await readPack('starter');
    expect(row?.welcome_price_paise).toBe(49900);
  });

  it('rolls back the update when validation fails after merging', async () => {
    // Set mrp lower than current welcome_price so the cross-field check fails.
    // current: mrp 99900, welcome 49900 -> patch mrp to 40000 (<= welcome).
    const res = await makeApp().request('/admin/packs/starter', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ mrp_paise: 40000 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { field?: string } };
    };
    expect(body.error.code).toBe('invalid_pack_update');
    expect(body.error.details?.field).toBe('welcome_price_paise');
    expect(await countAuditRows()).toBe(0);
    const row = await readPack('starter');
    expect(row?.mrp_paise).toBe(99900);
    expect(row?.welcome_price_paise).toBe(49900);
  });

  it('persists changes so a follow-up GET reflects them', async () => {
    const app = makeApp();
    await app.request('/admin/packs/lifetime', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await adminBearer(),
      },
      body: JSON.stringify({ welcome_price_paise: 149900 }),
    });
    const res = await app.request('/admin/packs', {
      headers: { Authorization: await adminBearer() },
    });
    const body = (await res.json()) as {
      packs: Array<{ slug: string; welcome_price_paise: number }>;
    };
    const lifetime = body.packs.find((p) => p.slug === 'lifetime');
    expect(lifetime?.welcome_price_paise).toBe(149900);
  });

  describe('pack deactivation guard (Requirement 11.7)', () => {
    const BUYER_ID = '33333333-3333-4333-8333-333333333333';

    async function insertPurchase(
      packSlug: string,
      status: 'pending' | 'completed' | 'failed',
      orderId: string,
    ): Promise<void> {
      await ctx.withClient(async (c) => {
        await c.query(
          `INSERT INTO purchases (user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, welcome_offer_applied${status === 'completed' ? ', razorpay_payment_id, completed_at' : ''})
           VALUES ($1, $2, 49900, 99900, $3, $4, false${status === 'completed' ? ", 'pay_' || $4, now()" : ''})`,
          [BUYER_ID, packSlug, status, orderId],
        );
      });
    }

    it('rejects deactivation when pending purchases exist and surfaces count', async () => {
      await insertPurchase('starter', 'pending', 'order_pend_1');
      await insertPurchase('starter', 'pending', 'order_pend_2');

      const res = await makeApp().request('/admin/packs/starter', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await adminBearer(),
        },
        body: JSON.stringify({ active: false }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: {
          code: string;
          message: string;
          details: { pending_orders_count: number };
        };
      };
      expect(body.error.code).toBe('pack_has_pending_orders');
      expect(body.error.details.pending_orders_count).toBe(2);
      expect(await countAuditRows()).toBe(0);

      // Pack remains active.
      const row = await readPack('starter');
      expect(row?.active).toBe(true);
    });

    it('allows deactivation when no pending purchases exist', async () => {
      // Only completed and failed purchases — no pending ones.
      await insertPurchase('pro', 'completed', 'order_comp_1');
      await insertPurchase('pro', 'failed', 'order_fail_1');

      const res = await makeApp().request('/admin/packs/pro', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await adminBearer(),
        },
        body: JSON.stringify({ active: false }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { pack: { active: boolean } };
      expect(body.pack.active).toBe(false);

      const row = await readPack('pro');
      expect(row?.active).toBe(false);
    });

    it('allows deactivation when there are zero purchases for the pack', async () => {
      const res = await makeApp().request('/admin/packs/starter', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await adminBearer(),
        },
        body: JSON.stringify({ active: false }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { pack: { active: boolean } };
      expect(body.pack.active).toBe(false);
    });

    it('does not trigger the guard when the pack is already inactive', async () => {
      // Deactivate the pack first (no pending purchases).
      await ctx.withClient(async (c) => {
        await c.query(`UPDATE packs SET active = false WHERE slug = 'starter'`);
      });
      // Now add a pending purchase (simulating a race condition scenario).
      await insertPurchase('starter', 'pending', 'order_race_1');

      // Patching a field other than active on an already-inactive pack should succeed.
      const res = await makeApp().request('/admin/packs/starter', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await adminBearer(),
        },
        body: JSON.stringify({ display_name: 'Starter Renamed' }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { pack: { display_name: string; active: boolean } };
      expect(body.pack.display_name).toBe('Starter Renamed');
      expect(body.pack.active).toBe(false);
    });

    it('does not trigger the guard when active is set to true (reactivation)', async () => {
      // Deactivate the pack first.
      await ctx.withClient(async (c) => {
        await c.query(`UPDATE packs SET active = false WHERE slug = 'starter'`);
      });
      await insertPurchase('starter', 'pending', 'order_react_1');

      // Reactivation (active: true) should not be blocked by pending purchases.
      const res = await makeApp().request('/admin/packs/starter', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await adminBearer(),
        },
        body: JSON.stringify({ active: true }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { pack: { active: boolean } };
      expect(body.pack.active).toBe(true);
    });

    it('only counts pending purchases for the specific pack being deactivated', async () => {
      // Pending purchase for a different pack should not block deactivation.
      await insertPurchase('pro', 'pending', 'order_other_1');

      const res = await makeApp().request('/admin/packs/starter', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await adminBearer(),
        },
        body: JSON.stringify({ active: false }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { pack: { active: boolean } };
      expect(body.pack.active).toBe(false);
    });
  });
});
