import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';
import type { RazorpayClient, CreateOrderInput, CreateOrderResult } from '../../../src/billing/razorpay-client.js';

/**
 * Integration tests for `POST /purchases/checkout`.
 *
 * Validates: Requirements 10.1, 10.2.
 *
 * Uses pg-mem for the database layer and a stub RazorpayClient to avoid
 * network calls. The stub is configurable per test to simulate success
 * and failure scenarios.
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
const NOW = new Date('2025-01-15T12:00:00Z');
const RAZORPAY_KEY_ID = 'rzp_test_key123';

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

// Configurable stub for the Razorpay client
let razorpayStub: {
  createOrder: (input: CreateOrderInput) => Promise<CreateOrderResult>;
  lastInput?: CreateOrderInput;
};

function makeSuccessStub(orderId = 'order_test_123'): typeof razorpayStub {
  return {
    createOrder: async (input) => {
      razorpayStub.lastInput = input;
      return {
        id: orderId,
        amount: input.amount,
        currency: input.currency,
        short_url: `https://rzp.io/i/${orderId}`,
      };
    },
  };
}

function makeFailureStub(message = 'Razorpay API error'): typeof razorpayStub {
  return {
    createOrder: async () => {
      throw new Error(message);
    },
  };
}

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-checkout-routes-12345';
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
  razorpayStub = makeSuccessStub();
  return ctx.withClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, email, role) VALUES ($1, $2, $3)`,
      [USER_ID, 'buyer@example.com', 'user'],
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

async function bearerFor(userId: string, role: 'user' | 'admin' = 'user'): Promise<string> {
  const { token } = await signAccessToken({
    sub: userId,
    role,
    clientId: 'test-client',
  });
  return `Bearer ${token}`;
}

function buildTestApp() {
  return buildApp({
    pool: ctx.pool,
    razorpayClient: razorpayStub as RazorpayClient,
    razorpayKeyId: RAZORPAY_KEY_ID,
    now: () => NOW,
  });
}

describe('POST /purchases/checkout', () => {
  describe('authentication', () => {
    it('rejects requests without Authorization header with 401', async () => {
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthenticated');
    });

    it('rejects requests with malformed Authorization header with 401', async () => {
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'InvalidToken',
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthenticated');
    });
  });

  describe('input validation', () => {
    it('rejects non-JSON body with 400', async () => {
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: 'not json',
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_body');
    });

    it('rejects missing pack_slug with 400', async () => {
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_pack_slug');
    });

    it('rejects invalid pack_slug with 400', async () => {
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'nonexistent' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_pack_slug');
    });

    it('rejects non-string pack_slug with 400', async () => {
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 123 }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_pack_slug');
    });
  });

  describe('pack lookup', () => {
    it('rejects checkout for an inactive pack with 400', async () => {
      await ctx.withClient((c) =>
        c.query(`UPDATE packs SET active = false WHERE slug = 'starter'`),
      );
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('pack_not_active');
    });
  });

  describe('successful checkout (R10.1)', () => {
    it('returns 201 with order_id, key_id, amount, currency, and checkout_url', async () => {
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        order_id: string;
        key_id: string;
        amount: number;
        currency: string;
        checkout_url: string;
      };
      expect(body.order_id).toBe('order_test_123');
      expect(body.key_id).toBe(RAZORPAY_KEY_ID);
      expect(body.amount).toBe(49900); // welcome offer price
      expect(body.currency).toBe('INR');
      expect(body.checkout_url).toContain('order_test_123');
    });

    it('applies welcome offer price for first-time buyer', async () => {
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'pro' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { amount: number };
      expect(body.amount).toBe(99900); // welcome offer price for pro
    });

    it('uses MRP when user already has a completed purchase', async () => {
      await ctx.withClient((c) =>
        c.query(
          `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, razorpay_payment_id, welcome_offer_applied, completed_at)
           VALUES ($1, $2, 'starter', 49900, 99900, 'completed', 'order_prev', 'pay_prev', true, now())`,
          [randomUUID(), USER_ID],
        ),
      );
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { amount: number };
      expect(body.amount).toBe(99900); // MRP, not welcome price
    });

    it('uses MRP when welcome offer is disabled', async () => {
      await ctx.withClient((c) =>
        c.query(`UPDATE welcome_offer SET enabled = false WHERE id = 1`),
      );
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { amount: number };
      expect(body.amount).toBe(99900); // MRP
    });

    it('uses MRP when welcome offer has expired', async () => {
      await ctx.withClient((c) =>
        c.query(`UPDATE welcome_offer SET ends_at = $1 WHERE id = 1`, [
          new Date('2024-01-01T00:00:00Z').toISOString(),
        ]),
      );
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { amount: number };
      expect(body.amount).toBe(99900); // MRP
    });

    it('persists a purchases row with status pending', async () => {
      const app = buildTestApp();

      await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      const result = await ctx.withClient((c) =>
        c.query(
          `SELECT user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, welcome_offer_applied
           FROM purchases WHERE user_id = $1`,
          [USER_ID],
        ),
      );
      expect(result.rows).toHaveLength(1);
      const row = result.rows[0] as Record<string, unknown>;
      expect(row.user_id).toBe(USER_ID);
      expect(row.pack_slug).toBe('starter');
      expect(Number(row.effective_price_paise)).toBe(49900);
      expect(Number(row.mrp_at_purchase_paise)).toBe(99900);
      expect(row.status).toBe('pending');
      expect(row.razorpay_order_id).toBe('order_test_123');
      expect(row.welcome_offer_applied).toBe(true);
    });

    it('passes correct amount and receipt to Razorpay', async () => {
      const app = buildTestApp();

      await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'pro' }),
      });

      expect(razorpayStub.lastInput).toBeDefined();
      expect(razorpayStub.lastInput!.amount).toBe(99900);
      expect(razorpayStub.lastInput!.currency).toBe('INR');
      expect(razorpayStub.lastInput!.receipt).toBeDefined();
      expect(razorpayStub.lastInput!.notes?.pack_slug).toBe('pro');
      expect(razorpayStub.lastInput!.notes?.user_id).toBe(USER_ID);
    });

    it('uses short_url from Razorpay response as checkout_url', async () => {
      razorpayStub = {
        createOrder: async (input) => ({
          id: 'order_with_url',
          amount: input.amount,
          currency: input.currency,
          short_url: 'https://rzp.io/custom-url',
        }),
      };
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      const body = (await res.json()) as { checkout_url: string };
      expect(body.checkout_url).toBe('https://rzp.io/custom-url');
    });

    it('falls back to embedded checkout URL when short_url is absent', async () => {
      razorpayStub = {
        createOrder: async (input) => ({
          id: 'order_no_url',
          amount: input.amount,
          currency: input.currency,
        }),
      };
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      const body = (await res.json()) as { checkout_url: string };
      expect(body.checkout_url).toBe(
        'https://api.razorpay.com/v1/checkout/embedded?order_id=order_no_url',
      );
    });
  });

  describe('Razorpay failure (R10.2)', () => {
    it('returns 502 when Razorpay order creation fails', async () => {
      razorpayStub = makeFailureStub('Network timeout');
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('payment_gateway_error');
      expect(body.error.message).toContain('Network timeout');
    });

    it('does NOT create a purchase record when Razorpay fails', async () => {
      razorpayStub = makeFailureStub();
      const app = buildTestApp();

      await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      const result = await ctx.withClient((c) =>
        c.query(`SELECT * FROM purchases WHERE user_id = $1`, [USER_ID]),
      );
      expect(result.rows).toHaveLength(0);
    });
  });

  describe('welcome_offer_applied flag', () => {
    it('sets welcome_offer_applied=true when welcome price is used', async () => {
      const app = buildTestApp();

      await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      const result = await ctx.withClient((c) =>
        c.query(`SELECT welcome_offer_applied FROM purchases WHERE user_id = $1`, [USER_ID]),
      );
      expect(result.rows[0]?.welcome_offer_applied).toBe(true);
    });

    it('sets welcome_offer_applied=false when MRP is used', async () => {
      await ctx.withClient((c) =>
        c.query(`UPDATE welcome_offer SET enabled = false WHERE id = 1`),
      );
      const app = buildTestApp();

      await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'starter' }),
      });

      const result = await ctx.withClient((c) =>
        c.query(`SELECT welcome_offer_applied FROM purchases WHERE user_id = $1`, [USER_ID]),
      );
      expect(result.rows[0]?.welcome_offer_applied).toBe(false);
    });
  });

  describe('lifetime pack checkout', () => {
    it('computes correct effective price for lifetime pack', async () => {
      const app = buildTestApp();

      const res = await app.request('/purchases/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await bearerFor(USER_ID),
        },
        body: JSON.stringify({ pack_slug: 'lifetime' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { amount: number };
      expect(body.amount).toBe(199900); // welcome offer price for lifetime
    });
  });
});


describe('GET /me/purchases (R10.12)', () => {
  describe('authentication', () => {
    it('rejects requests without Authorization header with 401', async () => {
      const app = buildTestApp();

      const res = await app.request('/me/purchases', { method: 'GET' });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthenticated');
    });

    it('rejects requests with invalid token with 401', async () => {
      const app = buildTestApp();

      const res = await app.request('/me/purchases', {
        method: 'GET',
        headers: { Authorization: 'Bearer invalid-token' },
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_token');
    });
  });

  describe('empty purchase history', () => {
    it('returns an empty array when user has no purchases', async () => {
      const app = buildTestApp();

      const res = await app.request('/me/purchases', {
        method: 'GET',
        headers: { Authorization: await bearerFor(USER_ID) },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { purchases: unknown[] };
      expect(body.purchases).toEqual([]);
    });
  });

  describe('purchase list', () => {
    it('returns purchases in reverse chronological order with all required fields', async () => {
      // Insert two purchases with different timestamps
      await ctx.withClient(async (c) => {
        await c.query(
          `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, razorpay_payment_id, welcome_offer_applied, created_at, completed_at)
           VALUES ($1, $2, 'starter', 49900, 99900, 'completed', 'order_001', 'pay_001', true, '2025-01-10T10:00:00Z', '2025-01-10T10:01:00Z')`,
          [randomUUID(), USER_ID],
        );
        await c.query(
          `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, razorpay_payment_id, welcome_offer_applied, created_at, completed_at)
           VALUES ($1, $2, 'pro', 249900, 249900, 'completed', 'order_002', 'pay_002', false, '2025-01-12T10:00:00Z', '2025-01-12T10:01:00Z')`,
          [randomUUID(), USER_ID],
        );
      });
      const app = buildTestApp();

      const res = await app.request('/me/purchases', {
        method: 'GET',
        headers: { Authorization: await bearerFor(USER_ID) },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        purchases: Array<{
          pack_slug: string;
          effective_price_paise: number;
          mrp_at_purchase_paise: number;
          status: string;
          razorpay_order_id: string;
          razorpay_payment_id: string | null;
          welcome_offer_applied: boolean;
          created_at: string;
          completed_at: string | null;
        }>;
      };
      expect(body.purchases).toHaveLength(2);

      // First item should be the most recent (order_002)
      expect(body.purchases[0]!.pack_slug).toBe('pro');
      expect(body.purchases[0]!.effective_price_paise).toBe(249900);
      expect(body.purchases[0]!.mrp_at_purchase_paise).toBe(249900);
      expect(body.purchases[0]!.status).toBe('completed');
      expect(body.purchases[0]!.razorpay_order_id).toBe('order_002');
      expect(body.purchases[0]!.razorpay_payment_id).toBe('pay_002');
      expect(body.purchases[0]!.welcome_offer_applied).toBe(false);
      expect(body.purchases[0]!.created_at).toBeDefined();
      expect(body.purchases[0]!.completed_at).toBeDefined();

      // Second item should be the older one (order_001)
      expect(body.purchases[1]!.pack_slug).toBe('starter');
      expect(body.purchases[1]!.effective_price_paise).toBe(49900);
      expect(body.purchases[1]!.razorpay_order_id).toBe('order_001');
      expect(body.purchases[1]!.welcome_offer_applied).toBe(true);
    });

    it('returns null for razorpay_payment_id when purchase is pending', async () => {
      await ctx.withClient(async (c) => {
        await c.query(
          `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, welcome_offer_applied, created_at)
           VALUES ($1, $2, 'starter', 49900, 99900, 'pending', 'order_pending', true, '2025-01-14T10:00:00Z')`,
          [randomUUID(), USER_ID],
        );
      });
      const app = buildTestApp();

      const res = await app.request('/me/purchases', {
        method: 'GET',
        headers: { Authorization: await bearerFor(USER_ID) },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        purchases: Array<{ razorpay_payment_id: string | null; status: string }>;
      };
      expect(body.purchases).toHaveLength(1);
      expect(body.purchases[0]!.razorpay_payment_id).toBeNull();
      expect(body.purchases[0]!.status).toBe('pending');
    });

    it('does not return purchases belonging to other users', async () => {
      const otherUserId = '22222222-2222-4222-8222-222222222222';
      await ctx.withClient(async (c) => {
        await c.query(
          `INSERT INTO users (id, email, role) VALUES ($1, $2, $3)`,
          [otherUserId, 'other@example.com', 'user'],
        );
        // Purchase for the other user
        await c.query(
          `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, welcome_offer_applied, created_at)
           VALUES ($1, $2, 'pro', 99900, 249900, 'pending', 'order_other', true, '2025-01-14T10:00:00Z')`,
          [randomUUID(), otherUserId],
        );
        // Purchase for our user
        await c.query(
          `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, welcome_offer_applied, created_at)
           VALUES ($1, $2, 'starter', 49900, 99900, 'pending', 'order_mine', true, '2025-01-14T11:00:00Z')`,
          [randomUUID(), USER_ID],
        );
      });
      const app = buildTestApp();

      const res = await app.request('/me/purchases', {
        method: 'GET',
        headers: { Authorization: await bearerFor(USER_ID) },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        purchases: Array<{ razorpay_order_id: string }>;
      };
      expect(body.purchases).toHaveLength(1);
      expect(body.purchases[0]!.razorpay_order_id).toBe('order_mine');
    });

    it('includes failed purchases in the list', async () => {
      await ctx.withClient(async (c) => {
        await c.query(
          `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, welcome_offer_applied, created_at)
           VALUES ($1, $2, 'starter', 49900, 99900, 'failed', 'order_failed', true, '2025-01-14T10:00:00Z')`,
          [randomUUID(), USER_ID],
        );
      });
      const app = buildTestApp();

      const res = await app.request('/me/purchases', {
        method: 'GET',
        headers: { Authorization: await bearerFor(USER_ID) },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        purchases: Array<{ status: string }>;
      };
      expect(body.purchases).toHaveLength(1);
      expect(body.purchases[0]!.status).toBe('failed');
    });
  });
});
