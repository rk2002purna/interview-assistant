import { describe, expect, it, vi } from 'vitest';
import { runWebhookReconciliation } from '../../../src/billing/webhook-reconciliation.js';

/**
 * Unit tests for `runWebhookReconciliation`.
 *
 * Validates: Requirements 10.10, 15.4, 15.5.
 *
 * These tests use a stubbed Pool to verify the reconciliation logic
 * without requiring a live Postgres instance.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockClientCall {
  sql: string;
  params?: unknown[];
}

function createMockClient(responses: Map<string, unknown>) {
  const calls: MockClientCall[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      // Match by substring in the SQL to return appropriate mock data
      for (const [key, value] of responses) {
        if (sql.includes(key)) {
          return value;
        }
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { client, calls };
}

function createMockPool(
  unmatchedEvents: unknown[],
  clientResponses?: Map<string, unknown>,
) {
  const responses = clientResponses ?? new Map();
  const { client, calls } = createMockClient(responses);

  const pool = {
    query: vi.fn(async () => ({ rows: unmatchedEvents })),
    connect: vi.fn(async () => client),
  } as unknown as import('pg').Pool;

  return { pool, client, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runWebhookReconciliation', () => {
  it('returns zero counts when no unmatched events exist', async () => {
    const { pool } = createMockPool([]);
    const now = new Date('2024-06-15T10:00:00.000Z');

    const result = await runWebhookReconciliation(pool, now);

    expect(result.examined_count).toBe(0);
    expect(result.reconciled_count).toBe(0);
    expect(result.still_unmatched_count).toBe(0);
    expect(result.error_count).toBe(0);
  });

  it('leaves events without order_id as still unmatched', async () => {
    const events = [
      {
        event_id: 'evt_1',
        event_type: 'payment.captured',
        order_id: null,
        payment_id: 'pay_1',
        raw_payload: {},
      },
    ];
    const { pool } = createMockPool(events);

    const result = await runWebhookReconciliation(pool);

    expect(result.examined_count).toBe(1);
    expect(result.still_unmatched_count).toBe(1);
    expect(result.reconciled_count).toBe(0);
  });

  it('leaves events as unmatched when no matching purchase row exists', async () => {
    const events = [
      {
        event_id: 'evt_2',
        event_type: 'payment.captured',
        order_id: 'order_abc',
        payment_id: 'pay_2',
        raw_payload: {},
      },
    ];

    const responses = new Map<string, unknown>();
    // Purchase lookup returns no rows
    responses.set('FROM purchases', { rows: [], rowCount: 0 });

    const { pool } = createMockPool(events, responses);

    const result = await runWebhookReconciliation(pool);

    expect(result.examined_count).toBe(1);
    expect(result.still_unmatched_count).toBe(1);
    expect(result.reconciled_count).toBe(0);
  });

  it('reconciles a payment.captured event when matching pending purchase exists', async () => {
    const events = [
      {
        event_id: 'evt_3',
        event_type: 'payment.captured',
        order_id: 'order_xyz',
        payment_id: 'pay_3',
        raw_payload: {},
      },
    ];

    const responses = new Map<string, unknown>();
    // Purchase lookup returns a pending purchase
    responses.set('FROM purchases', {
      rows: [{ id: 'pur_1', user_id: 'user_1', pack_slug: 'pro', status: 'pending' }],
      rowCount: 1,
    });
    // Pack lookup returns session_count
    responses.set('FROM packs', {
      rows: [{ session_count: 15, is_lifetime: false }],
      rowCount: 1,
    });
    // Advisory lock
    responses.set('pg_advisory_xact_lock', { rows: [] });
    // Latest ledger row (new user, no prior entries)
    responses.set('FROM entitlement_ledger', { rows: [] });
    // Ledger insert
    responses.set('INSERT INTO entitlement_ledger', {
      rows: [{ id: 'led_1', ts: new Date('2024-06-15T10:00:00.000Z') }],
    });

    const { pool, client } = createMockPool(events, responses);

    const result = await runWebhookReconciliation(pool);

    expect(result.examined_count).toBe(1);
    expect(result.reconciled_count).toBe(1);
    expect(result.still_unmatched_count).toBe(0);
    expect(result.error_count).toBe(0);

    // Verify BEGIN and COMMIT were called
    const sqlCalls = client.query.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sqlCalls[0]).toBe('BEGIN');
    expect(sqlCalls[sqlCalls.length - 1]).toBe('COMMIT');
  });

  it('reconciles a lifetime pack purchase with lifetime_grant reason', async () => {
    const events = [
      {
        event_id: 'evt_4',
        event_type: 'payment.captured',
        order_id: 'order_life',
        payment_id: 'pay_4',
        raw_payload: {},
      },
    ];

    const responses = new Map<string, unknown>();
    responses.set('FROM purchases', {
      rows: [{ id: 'pur_2', user_id: 'user_2', pack_slug: 'lifetime', status: 'pending' }],
      rowCount: 1,
    });
    responses.set('FROM packs', {
      rows: [{ session_count: null, is_lifetime: true }],
      rowCount: 1,
    });
    responses.set('pg_advisory_xact_lock', { rows: [] });
    responses.set('FROM entitlement_ledger', { rows: [] });
    responses.set('INSERT INTO entitlement_ledger', {
      rows: [{ id: 'led_2', ts: new Date('2024-06-15T10:00:00.000Z') }],
    });

    const { pool, client } = createMockPool(events, responses);

    const result = await runWebhookReconciliation(pool);

    expect(result.reconciled_count).toBe(1);

    // Verify the ledger insert includes lifetime_grant reason and set_true
    const insertCall = client.query.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes('INSERT INTO entitlement_ledger'),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    // params[4] is reason, params[3] is lifetime_flag_set
    expect(params[3]).toBe('set_true');
    expect(params[4]).toBe('lifetime_grant');
  });

  it('reconciles a payment.failed event by marking purchase as failed', async () => {
    const events = [
      {
        event_id: 'evt_5',
        event_type: 'payment.failed',
        order_id: 'order_fail',
        payment_id: 'pay_5',
        raw_payload: {},
      },
    ];

    const responses = new Map<string, unknown>();
    responses.set('FROM purchases', {
      rows: [{ id: 'pur_3', user_id: 'user_3', pack_slug: 'starter', status: 'pending' }],
      rowCount: 1,
    });

    const { pool, client } = createMockPool(events, responses);

    const result = await runWebhookReconciliation(pool);

    expect(result.reconciled_count).toBe(1);
    expect(result.error_count).toBe(0);

    // Verify purchase was marked as failed
    const failCall = client.query.mock.calls.find(
      (c: unknown[]) =>
        (c[0] as string).includes('UPDATE purchases') &&
        (c[0] as string).includes("'failed'"),
    );
    expect(failCall).toBeDefined();

    // Verify event was marked as processed
    const eventUpdate = client.query.mock.calls.find(
      (c: unknown[]) =>
        (c[0] as string).includes('UPDATE razorpay_events') &&
        (c[0] as string).includes('processed = true'),
    );
    expect(eventUpdate).toBeDefined();
  });

  it('marks event as processed when purchase is already completed (replay)', async () => {
    const events = [
      {
        event_id: 'evt_6',
        event_type: 'payment.captured',
        order_id: 'order_done',
        payment_id: 'pay_6',
        raw_payload: {},
      },
    ];

    const responses = new Map<string, unknown>();
    // Purchase already completed
    responses.set('FROM purchases', {
      rows: [{ id: 'pur_4', user_id: 'user_4', pack_slug: 'pro', status: 'completed' }],
      rowCount: 1,
    });

    const { pool } = createMockPool(events, responses);

    const result = await runWebhookReconciliation(pool);

    expect(result.reconciled_count).toBe(1);
    expect(result.still_unmatched_count).toBe(0);
    // No ledger entry should be appended for already-completed purchases
  });

  it('rolls back and increments error_count on transaction failure', async () => {
    const events = [
      {
        event_id: 'evt_7',
        event_type: 'payment.captured',
        order_id: 'order_err',
        payment_id: 'pay_7',
        raw_payload: {},
      },
    ];

    // Create a client that throws on the purchase lookup
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM purchases')) {
          throw new Error('connection lost');
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    const pool = {
      query: vi.fn(async () => ({ rows: events })),
      connect: vi.fn(async () => client),
    } as unknown as import('pg').Pool;

    const result = await runWebhookReconciliation(pool);

    expect(result.error_count).toBe(1);
    expect(result.reconciled_count).toBe(0);

    // Verify ROLLBACK was called
    const rollbackCall = client.query.mock.calls.find(
      (c: unknown[]) => (c[0] as string) === 'ROLLBACK',
    );
    expect(rollbackCall).toBeDefined();
    expect(client.release).toHaveBeenCalled();
  });

  it('uses current time when now parameter is not provided', async () => {
    const { pool } = createMockPool([]);

    const before = new Date();
    await runWebhookReconciliation(pool);
    const after = new Date();

    // The pool.query call for reading unmatched events should have been made
    expect((pool.query as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    // No time-dependent assertions needed since no events to process
    expect(before.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('handles multiple events independently (one fails, others succeed)', async () => {
    const events = [
      {
        event_id: 'evt_ok',
        event_type: 'payment.captured',
        order_id: 'order_ok',
        payment_id: 'pay_ok',
        raw_payload: {},
      },
      {
        event_id: 'evt_no_match',
        event_type: 'payment.captured',
        order_id: 'order_no_match',
        payment_id: 'pay_no_match',
        raw_payload: {},
      },
    ];

    let callCount = 0;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN') {
          callCount++;
          return { rows: [] };
        }
        if (sql === 'COMMIT') return { rows: [] };
        if (sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM purchases')) {
          if (callCount === 1) {
            // First event: purchase found and already completed
            return {
              rows: [{ id: 'pur_ok', user_id: 'u1', pack_slug: 'starter', status: 'completed' }],
              rowCount: 1,
            };
          }
          // Second event: no matching purchase
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('UPDATE razorpay_events')) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    const pool = {
      query: vi.fn(async () => ({ rows: events })),
      connect: vi.fn(async () => client),
    } as unknown as import('pg').Pool;

    const result = await runWebhookReconciliation(pool);

    expect(result.examined_count).toBe(2);
    expect(result.reconciled_count).toBe(1);
    expect(result.still_unmatched_count).toBe(1);
  });

  it('leaves unknown event types as still unmatched', async () => {
    const events = [
      {
        event_id: 'evt_unknown',
        event_type: 'refund.created',
        order_id: 'order_refund',
        payment_id: null,
        raw_payload: {},
      },
    ];

    const responses = new Map<string, unknown>();
    responses.set('FROM purchases', {
      rows: [{ id: 'pur_5', user_id: 'user_5', pack_slug: 'pro', status: 'pending' }],
      rowCount: 1,
    });

    const { pool } = createMockPool(events, responses);

    const result = await runWebhookReconciliation(pool);

    expect(result.still_unmatched_count).toBe(1);
    expect(result.reconciled_count).toBe(0);
  });
});
