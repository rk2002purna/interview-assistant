import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';

/**
 * Integration tests for the `GET /packs` route.
 *
 * Validates: Requirements 5.4, 5.11. Uses pg-mem to exercise the same
 * SQL the production route runs against; concurrency-sensitive paths
 * are not relevant here because the route is read-only.
 */

const INIT_SQL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    role text NOT NULL
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
    user_id uuid NOT NULL REFERENCES users(id),
    pack_slug text NOT NULL REFERENCES packs(slug),
    effective_price_paise bigint NOT NULL,
    mrp_at_purchase_paise bigint NOT NULL,
    status text NOT NULL,
    razorpay_order_id text NOT NULL,
    razorpay_payment_id text NULL,
    welcome_offer_applied boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz NULL
  );

  INSERT INTO packs (slug, display_name, description, mrp_paise, welcome_price_paise, session_count, is_lifetime, active) VALUES
    ('starter',  'Starter',  'desc', 99900,  49900,  5,    false, true),
    ('pro',      'Pro',      'desc', 249900, 99900,  15,   false, true),
    ('lifetime', 'Lifetime', 'desc', 999900, 199900, NULL, true,  true);
`;

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ENDS_AT = new Date('2025-06-01T00:00:00Z');
const BEFORE = new Date('2025-01-01T00:00:00Z');
const AFTER = new Date('2025-12-31T00:00:00Z');

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-pack-routes-12345';
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
  // Default state: user exists, no purchases, welcome offer enabled.
  return ctx.withClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, email, role) VALUES ($1, $2, $3)`,
      [USER_ID, 'user@example.com', 'user'],
    );
    await client.query(
      `INSERT INTO welcome_offer (id, enabled, ends_at) VALUES (1, true, $1)`,
      [ENDS_AT.toISOString()],
    );
  });
});

afterEach(() => {
  restore();
});

async function bearerFor(userId: string): Promise<string> {
  const { token } = await signAccessToken({
    sub: userId,
    role: 'user',
    clientId: 'test-client',
  });
  return `Bearer ${token}`;
}

describe('GET /packs', () => {
  it('rejects requests without a bearer token with 401', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => BEFORE });

    const res = await app.request('/packs');

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  it('returns active packs in starter, pro, lifetime order', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => BEFORE });

    const res = await app.request('/packs', {
      headers: { Authorization: await bearerFor(USER_ID) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      packs: Array<{ slug: string; effective_price_paise: number; mrp_paise: number; welcome_offer_applied: boolean }>;
    };
    expect(body.packs.map((p) => p.slug)).toEqual(['starter', 'pro', 'lifetime']);
  });

  it('applies the welcome price for a user with zero completed purchases when the offer is in-window', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => BEFORE });

    const res = await app.request('/packs', {
      headers: { Authorization: await bearerFor(USER_ID) },
    });

    const body = (await res.json()) as { packs: Array<Record<string, unknown>> };
    expect(body.packs).toEqual([
      expect.objectContaining({
        slug: 'starter',
        effective_price_paise: 49900,
        mrp_paise: 99900,
        welcome_offer_applied: true,
      }),
      expect.objectContaining({
        slug: 'pro',
        effective_price_paise: 99900,
        welcome_offer_applied: true,
      }),
      expect.objectContaining({
        slug: 'lifetime',
        effective_price_paise: 199900,
        welcome_offer_applied: true,
      }),
    ]);
  });

  it('falls back to MRP when the welcome offer has expired', async () => {
    const app = buildApp({ pool: ctx.pool, now: () => AFTER });

    const res = await app.request('/packs', {
      headers: { Authorization: await bearerFor(USER_ID) },
    });

    const body = (await res.json()) as {
      packs: Array<{ slug: string; effective_price_paise: number; mrp_paise: number; welcome_offer_applied: boolean }>;
    };
    for (const pack of body.packs) {
      expect(pack.effective_price_paise).toBe(pack.mrp_paise);
      expect(pack.welcome_offer_applied).toBe(false);
    }
  });

  it('falls back to MRP when the welcome offer is disabled', async () => {
    await ctx.withClient((c) => c.query(`UPDATE welcome_offer SET enabled = false WHERE id = 1`));
    const app = buildApp({ pool: ctx.pool, now: () => BEFORE });

    const res = await app.request('/packs', {
      headers: { Authorization: await bearerFor(USER_ID) },
    });

    const body = (await res.json()) as {
      packs: Array<{ effective_price_paise: number; mrp_paise: number; welcome_offer_applied: boolean }>;
    };
    for (const pack of body.packs) {
      expect(pack.effective_price_paise).toBe(pack.mrp_paise);
      expect(pack.welcome_offer_applied).toBe(false);
    }
  });

  it('falls back to MRP when the user already has a completed purchase', async () => {
    await ctx.withClient((c) =>
      c.query(
        `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, razorpay_payment_id, welcome_offer_applied, completed_at)
         VALUES ($1, $2, 'starter', 49900, 99900, 'completed', 'order_1', 'pay_1', true, now())`,
        [randomUUID(), USER_ID],
      ),
    );
    const app = buildApp({ pool: ctx.pool, now: () => BEFORE });

    const res = await app.request('/packs', {
      headers: { Authorization: await bearerFor(USER_ID) },
    });

    const body = (await res.json()) as {
      packs: Array<{ effective_price_paise: number; mrp_paise: number; welcome_offer_applied: boolean }>;
    };
    for (const pack of body.packs) {
      expect(pack.effective_price_paise).toBe(pack.mrp_paise);
      expect(pack.welcome_offer_applied).toBe(false);
    }
  });

  it('still applies the welcome price when the user has only pending or failed purchases', async () => {
    await ctx.withClient(async (c) => {
      await c.query(
        `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, welcome_offer_applied)
         VALUES ($1, $2, 'starter', 49900, 99900, 'pending', 'order_pending', true)`,
        [randomUUID(), USER_ID],
      );
      await c.query(
        `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, welcome_offer_applied)
         VALUES ($1, $2, 'pro', 99900, 249900, 'failed', 'order_failed', true)`,
        [randomUUID(), USER_ID],
      );
    });
    const app = buildApp({ pool: ctx.pool, now: () => BEFORE });

    const res = await app.request('/packs', {
      headers: { Authorization: await bearerFor(USER_ID) },
    });

    const body = (await res.json()) as {
      packs: Array<{ slug: string; effective_price_paise: number; welcome_offer_applied: boolean }>;
    };
    expect(body.packs.find((p) => p.slug === 'starter')?.welcome_offer_applied).toBe(true);
    expect(body.packs.find((p) => p.slug === 'pro')?.welcome_offer_applied).toBe(true);
  });

  it('omits inactive packs', async () => {
    await ctx.withClient((c) => c.query(`UPDATE packs SET active = false WHERE slug = 'lifetime'`));
    const app = buildApp({ pool: ctx.pool, now: () => BEFORE });

    const res = await app.request('/packs', {
      headers: { Authorization: await bearerFor(USER_ID) },
    });

    const body = (await res.json()) as { packs: Array<{ slug: string }> };
    expect(body.packs.map((p) => p.slug)).toEqual(['starter', 'pro']);
  });
});
