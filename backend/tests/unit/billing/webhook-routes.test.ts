/**
 * Unit tests for `POST /webhooks/razorpay`.
 *
 * Validates: Requirements 10.7, 10.8, 10.9, 10.10
 *
 * Uses pg-mem for the database layer. Tests cover:
 *   - Signature verification (returns 400 on failure)
 *   - Dedupe by event_id (returns 200 for replays)
 *   - payment.captured → purchase completed + ledger entry
 *   - payment.failed → purchase failed, no ledger entry
 *   - Unknown order_id → 200 with unmatched=true
 *   - Already-processed purchases → 200 (no-op)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';

const WEBHOOK_SECRET = 'whsec_test_webhook_secret_12345';
const USER_ID = '11111111-1111-4111-8111-111111111111';

/** Compute a valid HMAC-SHA256 hex signature for a given body. */
function computeSignature(body: string, secret: string = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Build a Razorpay webhook payload for payment.captured. */
function buildCapturedPayload(opts: {
  eventId?: string;
  orderId?: string;
  paymentId?: string;
} = {}): Record<string, unknown> {
  return {
    id: opts.eventId ?? `evt_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: opts.paymentId ?? `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
          order_id: opts.orderId ?? 'order_test_123',
          status: 'captured',
        },
      },
    },
  };
}

/** Build a Razorpay webhook payload for payment.failed. */
function buildFailedPayload(opts: {
  eventId?: string;
  orderId?: string;
  paymentId?: string;
} = {}): Record<string, unknown> {
  return {
    id: opts.eventId ?? `evt_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: opts.paymentId ?? `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
          order_id: opts.orderId ?? 'order_test_123',
          status: 'failed',
        },
      },
    },
  };
}

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

  CREATE TABLE razorpay_events (
    event_id text PRIMARY KEY,
    event_type text NOT NULL,
    order_id text NULL,
    payment_id text NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    processed boolean NOT NULL DEFAULT false,
    unmatched boolean NOT NULL DEFAULT false,
    raw_payload jsonb NOT NULL
  );

  CREATE TABLE entitlement_ledger (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    ts timestamptz NOT NULL DEFAULT now(),
    session_delta integer NOT NULL,
    lifetime_flag_set text NOT NULL,
    reason text NOT NULL,
    razorpay_payment_id text NULL,
    interview_session_id uuid NULL,
    acting_admin_id uuid NULL,
    resulting_session_count integer NOT NULL,
    resulting_lifetime_flag boolean NOT NULL,
    note text NULL
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
    metadata jsonb NULL
  );

  INSERT INTO packs (slug, display_name, description, mrp_paise, welcome_price_paise, session_count, is_lifetime, active) VALUES
    ('starter',  'Starter',  'desc', 99900,  49900,  5,    false, true),
    ('pro',      'Pro',      'desc', 249900, 99900,  15,   false, true),
    ('lifetime', 'Lifetime', 'desc', 999900, 199900, NULL, true,  true);
`;

let ctx: PgMemContext;
let restore: () => void;

beforeAll(async () => {
  ctx = await createPgMem({ initSql: INIT_SQL });

  // Register pg functions that pg-mem doesn't support natively.
  // These are no-ops for unit tests (concurrency is not tested here).
  ctx.db.public.registerFunction({
    name: 'hashtextextended',
    args: ['text', 'integer'] as unknown as never,
    returns: 'bigint' as unknown as never,
    implementation: () => 0,
  });
  ctx.db.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: ['bigint'] as unknown as never,
    returns: 'null' as unknown as never,
    implementation: () => null,
  });
});

afterAll(async () => {
  await ctx.stop();
});

beforeEach(async () => {
  restore = ctx.snapshot();
  await ctx.withClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, email, role) VALUES ($1, $2, $3)`,
      [USER_ID, 'buyer@example.com', 'user'],
    );
    // Insert a pending purchase
    await client.query(
      `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, welcome_offer_applied)
       VALUES ($1, $2, 'starter', 49900, 99900, 'pending', 'order_test_123', true)`,
      [randomUUID(), USER_ID],
    );
  });
});

afterEach(() => {
  restore();
});

function buildTestApp() {
  return buildApp({
    pool: ctx.pool,
    razorpayWebhookSecret: WEBHOOK_SECRET,
  });
}

async function sendWebhook(app: ReturnType<typeof buildTestApp>, body: string, signature?: string) {
  return app.request('/webhooks/razorpay', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature ?? computeSignature(body),
    },
    body,
  });
}

describe('POST /webhooks/razorpay', () => {
  describe('signature verification (R10.5, R10.6)', () => {
    it('returns 400 when signature is missing', async () => {
      const app = buildTestApp();
      const body = JSON.stringify(buildCapturedPayload());

      const res = await app.request('/webhooks/razorpay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe('invalid_signature');
    });

    it('returns 400 when signature is invalid', async () => {
      const app = buildTestApp();
      const body = JSON.stringify(buildCapturedPayload());
      const badSignature = 'a'.repeat(64);

      const res = await sendWebhook(app, body, badSignature);

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe('invalid_signature');
    });

    it('returns 400 when signature is computed with wrong secret', async () => {
      const app = buildTestApp();
      const body = JSON.stringify(buildCapturedPayload());
      const wrongSignature = computeSignature(body, 'wrong_secret');

      const res = await sendWebhook(app, body, wrongSignature);

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe('invalid_signature');
    });

    it('writes an audit log entry on signature failure', async () => {
      const app = buildTestApp();
      const body = JSON.stringify(buildCapturedPayload());

      await sendWebhook(app, body, 'invalid_sig_' + '0'.repeat(52));

      const result = await ctx.withClient((c) =>
        c.query(`SELECT event_type, outcome FROM audit_log WHERE event_type = 'webhook_signature_failure'`),
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      const row = result.rows[0] as { event_type: string; outcome: string };
      expect(row.event_type).toBe('webhook_signature_failure');
      expect(row.outcome).toBe('failure');
    });
  });

  describe('dedupe by event_id (R10.9)', () => {
    it('returns 200 for replayed events', async () => {
      const app = buildTestApp();
      const payload = buildCapturedPayload({ eventId: 'evt_replay_test' });
      const body = JSON.stringify(payload);

      // First call — processes the event
      const res1 = await sendWebhook(app, body);
      expect(res1.status).toBe(200);

      // Second call — replay
      const res2 = await sendWebhook(app, body);
      expect(res2.status).toBe(200);
      const json = (await res2.json()) as { status: string };
      expect(json.status).toBe('already_processed');
    });

    it('does not create duplicate ledger entries on replay', async () => {
      const app = buildTestApp();
      const payload = buildCapturedPayload({ eventId: 'evt_no_dup' });
      const body = JSON.stringify(payload);

      await sendWebhook(app, body);
      await sendWebhook(app, body);

      const result = await ctx.withClient((c) =>
        c.query(`SELECT COUNT(*) as count FROM entitlement_ledger WHERE user_id = $1`, [USER_ID]),
      );
      expect(Number((result.rows[0] as { count: string }).count)).toBe(1);
    });
  });

  describe('payment.captured (R10.7)', () => {
    it('updates purchase status to completed', async () => {
      const app = buildTestApp();
      const payload = buildCapturedPayload({ paymentId: 'pay_captured_1' });
      const body = JSON.stringify(payload);

      const res = await sendWebhook(app, body);
      expect(res.status).toBe(200);

      const result = await ctx.withClient((c) =>
        c.query(`SELECT status, razorpay_payment_id FROM purchases WHERE razorpay_order_id = 'order_test_123'`),
      );
      const row = result.rows[0] as { status: string; razorpay_payment_id: string };
      expect(row.status).toBe('completed');
      expect(row.razorpay_payment_id).toBe('pay_captured_1');
    });

    it('appends a ledger entry with reason pack_purchase for starter pack', async () => {
      const app = buildTestApp();
      const payload = buildCapturedPayload({ paymentId: 'pay_starter_1' });
      const body = JSON.stringify(payload);

      await sendWebhook(app, body);

      const result = await ctx.withClient((c) =>
        c.query(
          `SELECT session_delta, lifetime_flag_set, reason, razorpay_payment_id, resulting_session_count, resulting_lifetime_flag
           FROM entitlement_ledger WHERE user_id = $1`,
          [USER_ID],
        ),
      );
      expect(result.rows).toHaveLength(1);
      const row = result.rows[0] as {
        session_delta: number;
        lifetime_flag_set: string;
        reason: string;
        razorpay_payment_id: string;
        resulting_session_count: number;
        resulting_lifetime_flag: boolean;
      };
      expect(row.session_delta).toBe(5); // starter pack session_count
      expect(row.lifetime_flag_set).toBe('unchanged');
      expect(row.reason).toBe('pack_purchase');
      expect(row.razorpay_payment_id).toBe('pay_starter_1');
      expect(row.resulting_session_count).toBe(5);
      expect(row.resulting_lifetime_flag).toBe(false);
    });

    it('appends a ledger entry with reason lifetime_grant for lifetime pack', async () => {
      // Replace the pending purchase with a lifetime one
      await ctx.withClient(async (c) => {
        await c.query(`DELETE FROM purchases WHERE razorpay_order_id = 'order_test_123'`);
        await c.query(
          `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, welcome_offer_applied)
           VALUES ($1, $2, 'lifetime', 199900, 999900, 'pending', 'order_test_123', true)`,
          [randomUUID(), USER_ID],
        );
      });

      const app = buildTestApp();
      const payload = buildCapturedPayload({ paymentId: 'pay_lifetime_1' });
      const body = JSON.stringify(payload);

      await sendWebhook(app, body);

      const result = await ctx.withClient((c) =>
        c.query(
          `SELECT session_delta, lifetime_flag_set, reason, resulting_lifetime_flag
           FROM entitlement_ledger WHERE user_id = $1`,
          [USER_ID],
        ),
      );
      expect(result.rows).toHaveLength(1);
      const row = result.rows[0] as {
        session_delta: number;
        lifetime_flag_set: string;
        reason: string;
        resulting_lifetime_flag: boolean;
      };
      expect(row.session_delta).toBe(1);
      expect(row.lifetime_flag_set).toBe('set_true');
      expect(row.reason).toBe('lifetime_grant');
      expect(row.resulting_lifetime_flag).toBe(true);
    });

    it('marks the razorpay_event as processed', async () => {
      const app = buildTestApp();
      const payload = buildCapturedPayload({ eventId: 'evt_processed_check' });
      const body = JSON.stringify(payload);

      await sendWebhook(app, body);

      const result = await ctx.withClient((c) =>
        c.query(`SELECT processed, unmatched FROM razorpay_events WHERE event_id = 'evt_processed_check'`),
      );
      const row = result.rows[0] as { processed: boolean; unmatched: boolean };
      expect(row.processed).toBe(true);
      expect(row.unmatched).toBe(false);
    });
  });

  describe('payment.failed (R10.8)', () => {
    it('updates purchase status to failed', async () => {
      const app = buildTestApp();
      const payload = buildFailedPayload();
      const body = JSON.stringify(payload);

      const res = await sendWebhook(app, body);
      expect(res.status).toBe(200);

      const result = await ctx.withClient((c) =>
        c.query(`SELECT status FROM purchases WHERE razorpay_order_id = 'order_test_123'`),
      );
      const row = result.rows[0] as { status: string };
      expect(row.status).toBe('failed');
    });

    it('does NOT create a ledger entry', async () => {
      const app = buildTestApp();
      const payload = buildFailedPayload();
      const body = JSON.stringify(payload);

      await sendWebhook(app, body);

      const result = await ctx.withClient((c) =>
        c.query(`SELECT COUNT(*) as count FROM entitlement_ledger WHERE user_id = $1`, [USER_ID]),
      );
      expect(Number((result.rows[0] as { count: string }).count)).toBe(0);
    });

    it('returns 200', async () => {
      const app = buildTestApp();
      const payload = buildFailedPayload();
      const body = JSON.stringify(payload);

      const res = await sendWebhook(app, body);
      expect(res.status).toBe(200);
    });
  });

  describe('unknown order_id (R10.10)', () => {
    it('returns 200 and marks event as unmatched', async () => {
      const app = buildTestApp();
      const payload = buildCapturedPayload({
        eventId: 'evt_unknown_order',
        orderId: 'order_does_not_exist',
      });
      const body = JSON.stringify(payload);

      const res = await sendWebhook(app, body);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe('unmatched');

      const result = await ctx.withClient((c) =>
        c.query(`SELECT unmatched, processed FROM razorpay_events WHERE event_id = 'evt_unknown_order'`),
      );
      const row = result.rows[0] as { unmatched: boolean; processed: boolean };
      expect(row.unmatched).toBe(true);
      expect(row.processed).toBe(true);
    });

    it('does NOT create a purchase record for unknown orders', async () => {
      const app = buildTestApp();
      const payload = buildCapturedPayload({
        orderId: 'order_unknown_xyz',
      });
      const body = JSON.stringify(payload);

      await sendWebhook(app, body);

      const result = await ctx.withClient((c) =>
        c.query(`SELECT COUNT(*) as count FROM purchases WHERE razorpay_order_id = 'order_unknown_xyz'`),
      );
      expect(Number((result.rows[0] as { count: string }).count)).toBe(0);
    });
  });

  describe('already-processed purchases', () => {
    it('returns 200 when purchase is already completed', async () => {
      // Mark the purchase as completed
      await ctx.withClient((c) =>
        c.query(
          `UPDATE purchases SET status = 'completed', razorpay_payment_id = 'pay_prev', completed_at = now()
           WHERE razorpay_order_id = 'order_test_123'`,
        ),
      );

      const app = buildTestApp();
      const payload = buildCapturedPayload({ eventId: 'evt_already_done' });
      const body = JSON.stringify(payload);

      const res = await sendWebhook(app, body);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe('already_processed');
    });

    it('returns 200 when purchase is already failed', async () => {
      await ctx.withClient((c) =>
        c.query(`UPDATE purchases SET status = 'failed' WHERE razorpay_order_id = 'order_test_123'`),
      );

      const app = buildTestApp();
      const payload = buildFailedPayload({ eventId: 'evt_already_failed' });
      const body = JSON.stringify(payload);

      const res = await sendWebhook(app, body);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe('already_processed');
    });
  });

  describe('unhandled event types', () => {
    it('returns 200 for non-payment event types', async () => {
      const app = buildTestApp();
      const payload = {
        id: 'evt_other_type',
        event: 'order.paid',
        payload: { payment: { entity: { id: 'pay_x', order_id: 'order_test_123' } } },
      };
      const body = JSON.stringify(payload);

      const res = await sendWebhook(app, body);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe('ignored');
    });
  });

  describe('pro pack purchase', () => {
    it('grants 15 sessions for pro pack', async () => {
      // Replace with a pro pack purchase
      await ctx.withClient(async (c) => {
        await c.query(`DELETE FROM purchases WHERE razorpay_order_id = 'order_test_123'`);
        await c.query(
          `INSERT INTO purchases (id, user_id, pack_slug, effective_price_paise, mrp_at_purchase_paise, status, razorpay_order_id, welcome_offer_applied)
           VALUES ($1, $2, 'pro', 99900, 249900, 'pending', 'order_test_123', true)`,
          [randomUUID(), USER_ID],
        );
      });

      const app = buildTestApp();
      const payload = buildCapturedPayload({ paymentId: 'pay_pro_1' });
      const body = JSON.stringify(payload);

      await sendWebhook(app, body);

      const result = await ctx.withClient((c) =>
        c.query(
          `SELECT session_delta, resulting_session_count FROM entitlement_ledger WHERE user_id = $1`,
          [USER_ID],
        ),
      );
      const row = result.rows[0] as { session_delta: number; resulting_session_count: number };
      expect(row.session_delta).toBe(15);
      expect(row.resulting_session_count).toBe(15);
    });
  });
});
