import { describe, expect, it, vi } from 'vitest';
import {
  LedgerError,
  appendLedgerEntry,
  type LedgerTransactionClient,
} from '../../../src/entitlement/ledger.js';

/**
 * Unit tests for `appendLedgerEntry`.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.7.
 *
 * The Property 1 / Property 2 PBT coverage (tasks 6.2 and 7.2) lives in
 * separate property tests using `pg-mem` and `testcontainers`; the
 * cases below are focused boundary examples that do not depend on a
 * live Postgres and exercise the function's control flow directly via
 * a stubbed transaction client.
 */

const USER = '11111111-1111-1111-1111-111111111111';
const TS = new Date('2024-06-01T12:00:00.000Z');
const NEW_ID_RE = /^[0-9a-f-]{36}$/i;

interface ScriptedQuery {
  /** Substring used to match the SQL text. */
  match: string;
  /** Rows returned for the matched query. */
  rows: ReadonlyArray<unknown>;
}

/**
 * Build a stubbed transaction client whose `query` walks a script of
 * expected SQL fragments. The advisory-lock query returns an empty row
 * set; the read returns the supplied prior state; the insert echoes
 * back `id` and a fixed `ts`.
 */
function stubTx(opts: {
  prior?: { count: number; lifetime: boolean } | null;
  ts?: Date;
} = {}): {
  client: LedgerTransactionClient;
  query: ReturnType<typeof vi.fn>;
} {
  const ts = opts.ts ?? TS;
  const prior = opts.prior === undefined ? null : opts.prior;

  const script: ScriptedQuery[] = [
    { match: 'pg_advisory_xact_lock', rows: [{}] },
    {
      match: 'FROM entitlement_ledger',
      rows:
        prior === null
          ? []
          : [
              {
                resulting_session_count: prior.count,
                resulting_lifetime_flag: prior.lifetime,
              },
            ],
    },
    { match: 'INSERT INTO entitlement_ledger', rows: [] /* filled per call */ },
  ];

  let step = 0;
  const query = vi.fn(async (text: string, values?: ReadonlyArray<unknown>) => {
    const expected = script[step++];
    if (!expected) {
      throw new Error(`unexpected query: ${text}`);
    }
    if (!text.includes(expected.match)) {
      throw new Error(`expected query to contain '${expected.match}', got: ${text}`);
    }
    if (expected.match === 'INSERT INTO entitlement_ledger') {
      const id = (values ?? [])[0] as string;
      return { rows: [{ id, ts }] };
    }
    return { rows: expected.rows };
  });

  return {
    query,
    client: { query: query as unknown as LedgerTransactionClient['query'] },
  };
}

describe('appendLedgerEntry', () => {
  it('acquires the per-user advisory lock before reading or writing', async () => {
    const { client, query } = stubTx({ prior: { count: 5, lifetime: false } });

    await appendLedgerEntry(client, {
      userId: USER,
      sessionDelta: -1,
      lifetimeFlagSet: 'unchanged',
      reason: 'session_start',
    });

    expect(query.mock.calls[0]![0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[0]![1]).toEqual([USER]);
    expect(query.mock.calls[1]![0]).toContain('FROM entitlement_ledger');
    expect(query.mock.calls[2]![0]).toContain('INSERT INTO entitlement_ledger');
  });

  it('treats a user with no prior rows as (0, false)', async () => {
    const { client, query } = stubTx({ prior: null });

    const res = await appendLedgerEntry(client, {
      userId: USER,
      sessionDelta: 5,
      lifetimeFlagSet: 'unchanged',
      reason: 'pack_purchase',
      razorpayPaymentId: 'pay_test_1',
    });

    expect(res.resultingSessionCount).toBe(5);
    expect(res.resultingLifetimeFlag).toBe(false);
    expect(res.id).toMatch(NEW_ID_RE);

    const insertValues = query.mock.calls[2]![1] as unknown[];
    // Values: id, user_id, session_delta, lifetime_flag_set, reason,
    //         razorpay_payment_id, interview_session_id, acting_admin_id,
    //         resulting_session_count, resulting_lifetime_flag, note
    expect(insertValues[1]).toBe(USER);
    expect(insertValues[2]).toBe(5);
    expect(insertValues[3]).toBe('unchanged');
    expect(insertValues[4]).toBe('pack_purchase');
    expect(insertValues[5]).toBe('pay_test_1');
    expect(insertValues[6]).toBeNull();
    expect(insertValues[7]).toBeNull();
    expect(insertValues[8]).toBe(5);
    expect(insertValues[9]).toBe(false);
    expect(insertValues[10]).toBeNull();
  });

  it('adds delta to prior resulting_session_count', async () => {
    const { client } = stubTx({ prior: { count: 3, lifetime: false } });

    const res = await appendLedgerEntry(client, {
      userId: USER,
      sessionDelta: -1,
      lifetimeFlagSet: 'unchanged',
      reason: 'session_start',
    });

    expect(res.resultingSessionCount).toBe(2);
    expect(res.resultingLifetimeFlag).toBe(false);
  });

  it('rejects session_start that would drive count negative for non-lifetime users', async () => {
    const { client, query } = stubTx({ prior: { count: 0, lifetime: false } });

    await expect(
      appendLedgerEntry(client, {
        userId: USER,
        sessionDelta: -1,
        lifetimeFlagSet: 'unchanged',
        reason: 'session_start',
      }),
    ).rejects.toMatchObject({
      name: 'LedgerError',
      code: 'no_sessions_remaining',
      currentSessionCount: 0,
      currentLifetimeFlag: false,
    });

    // Lock + read happened, but no insert.
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[1]![0]).toContain('FROM entitlement_ledger');
  });

  it('records session_start with delta=0 for lifetime users (Requirement 6.7)', async () => {
    const { client, query } = stubTx({ prior: { count: 0, lifetime: true } });

    const res = await appendLedgerEntry(client, {
      userId: USER,
      sessionDelta: 0,
      lifetimeFlagSet: 'unchanged',
      reason: 'session_start',
    });

    expect(res.resultingSessionCount).toBe(0);
    expect(res.resultingLifetimeFlag).toBe(true);

    const insertValues = query.mock.calls[2]![1] as unknown[];
    expect(insertValues[2]).toBe(0);
    expect(insertValues[9]).toBe(true);
  });

  it('keeps the lifetime flag sticky once a prior row set it', async () => {
    const { client } = stubTx({ prior: { count: 0, lifetime: true } });

    const res = await appendLedgerEntry(client, {
      userId: USER,
      sessionDelta: 5,
      lifetimeFlagSet: 'unchanged',
      reason: 'pack_purchase',
    });

    expect(res.resultingLifetimeFlag).toBe(true);
  });

  it('sets the lifetime flag on a fresh user when lifetimeFlagSet=set_true', async () => {
    const { client } = stubTx({ prior: null });

    const res = await appendLedgerEntry(client, {
      userId: USER,
      sessionDelta: 1,
      lifetimeFlagSet: 'set_true',
      reason: 'lifetime_grant',
      razorpayPaymentId: 'pay_lifetime_1',
    });

    expect(res.resultingLifetimeFlag).toBe(true);
    expect(res.resultingSessionCount).toBe(1);
  });

  it('rejects non-integer session_delta', async () => {
    const { client, query } = stubTx({ prior: { count: 5, lifetime: false } });

    await expect(
      appendLedgerEntry(client, {
        userId: USER,
        sessionDelta: 1.5,
        lifetimeFlagSet: 'unchanged',
        reason: 'admin_adjustment',
      }),
    ).rejects.toBeInstanceOf(LedgerError);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects session_delta outside [-1_000_000, 1_000_000]', async () => {
    const { client } = stubTx();

    await expect(
      appendLedgerEntry(client, {
        userId: USER,
        sessionDelta: 1_000_001,
        lifetimeFlagSet: 'unchanged',
        reason: 'pack_purchase',
      }),
    ).rejects.toMatchObject({ code: 'invalid_session_delta' });
  });

  it('rejects session_delta=0 unless reason=session_start', async () => {
    const { client } = stubTx();

    await expect(
      appendLedgerEntry(client, {
        userId: USER,
        sessionDelta: 0,
        lifetimeFlagSet: 'unchanged',
        reason: 'admin_adjustment',
      }),
    ).rejects.toMatchObject({ code: 'invalid_session_delta' });
  });

  it('rejects an unknown reason', async () => {
    const { client } = stubTx();

    await expect(
      appendLedgerEntry(client, {
        userId: USER,
        sessionDelta: 1,
        lifetimeFlagSet: 'unchanged',
        reason: 'mystery_reason' as never,
      }),
    ).rejects.toMatchObject({ code: 'invalid_reason' });
  });

  it('rejects an unknown lifetime_flag_set value', async () => {
    const { client } = stubTx();

    await expect(
      appendLedgerEntry(client, {
        userId: USER,
        sessionDelta: 1,
        lifetimeFlagSet: 'set_false' as never,
        reason: 'pack_purchase',
      }),
    ).rejects.toMatchObject({ code: 'invalid_lifetime_flag_set' });
  });

  it('represents omitted optional ids and note as SQL NULLs', async () => {
    const { client, query } = stubTx({ prior: null });

    await appendLedgerEntry(client, {
      userId: USER,
      sessionDelta: 5,
      lifetimeFlagSet: 'unchanged',
      reason: 'pack_purchase',
    });

    const insertValues = query.mock.calls[2]![1] as unknown[];
    expect(insertValues[5]).toBeNull(); // razorpay_payment_id
    expect(insertValues[6]).toBeNull(); // interview_session_id
    expect(insertValues[7]).toBeNull(); // acting_admin_id
    expect(insertValues[10]).toBeNull(); // note
  });

  it('passes acting_admin_id and note for admin adjustments', async () => {
    const { client, query } = stubTx({ prior: { count: 10, lifetime: false } });

    await appendLedgerEntry(client, {
      userId: USER,
      sessionDelta: -3,
      lifetimeFlagSet: 'unchanged',
      reason: 'admin_adjustment',
      actingAdminId: '99999999-9999-9999-9999-999999999999',
      note: 'reverted accidental grant',
    });

    const insertValues = query.mock.calls[2]![1] as unknown[];
    expect(insertValues[7]).toBe('99999999-9999-9999-9999-999999999999');
    expect(insertValues[10]).toBe('reverted accidental grant');
  });
});
