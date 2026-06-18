import { describe, expect, it, vi } from 'vitest';
import {
  writeAudit,
  type AuditTransactionClient,
} from '../../../src/log/audit.js';

/**
 * Build a stub transaction client whose `query` method records calls and
 * returns a single row with a fixed ts. The audit_log INSERT always
 * RETURNING `id, ts`, so the stub mirrors that contract.
 */
function stubClient(opts: { ts?: Date } = {}): {
  client: AuditTransactionClient;
  query: ReturnType<typeof vi.fn>;
} {
  const ts = opts.ts ?? new Date('2024-06-01T12:00:00.000Z');
  const query = vi.fn(async (_text: string, values?: ReadonlyArray<unknown>) => {
    const id = (values ?? [])[0] as string;
    return { rows: [{ id, ts }] };
  });
  return {
    query,
    client: { query: query as unknown as AuditTransactionClient['query'] },
  };
}

describe('writeAudit', () => {
  it('inserts one row using the supplied transaction', async () => {
    const { client, query } = stubClient();

    const res = await writeAudit(client, {
      actor: { userId: 'admin-1' },
      target: { userId: 'user-2' },
      eventType: 'role_change',
      outcome: 'success',
      reasonCode: null,
      metadata: { previous_role: 'user', new_role: 'admin' },
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(res.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(res.ts).toBeInstanceOf(Date);
  });

  it('passes parameters in the order the SQL expects', async () => {
    const { client, query } = stubClient();

    await writeAudit(client, {
      actor: { userId: 'admin-1' },
      target: { userId: 'user-2', resource: 'pack:pro' },
      eventType: 'pack_update',
      outcome: 'success',
      reasonCode: 'price_change',
      metadata: { mrp: 249900 },
    });

    const [text, values] = query.mock.calls[0]!;
    expect(text).toContain('INSERT INTO audit_log');
    // Values order: id, actor_user_id, target_user_id, target_resource,
    // event_type, outcome, reason_code, metadata
    expect(values).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
      'admin-1',
      'user-2',
      'pack:pro',
      'pack_update',
      'success',
      'price_change',
      JSON.stringify({ mrp: 249900 }),
    ]);
  });

  it('serializes metadata as JSON', async () => {
    const { client, query } = stubClient();

    await writeAudit(client, {
      eventType: 'webhook_signature_invalid',
      outcome: 'failure',
      metadata: { ip: '1.2.3.4', reason: 'hmac_mismatch' },
    });

    const values = query.mock.calls[0]![1] as unknown[];
    expect(values[7]).toBe(JSON.stringify({ ip: '1.2.3.4', reason: 'hmac_mismatch' }));
  });

  it('defaults metadata to "{}" when omitted', async () => {
    const { client, query } = stubClient();

    await writeAudit(client, {
      actor: { userId: null },
      eventType: 'login_failure',
      outcome: 'failure',
    });

    const values = query.mock.calls[0]![1] as unknown[];
    expect(values[7]).toBe('{}');
  });

  it('represents anonymous actor and missing target as SQL NULLs', async () => {
    const { client, query } = stubClient();

    await writeAudit(client, {
      actor: null,
      target: null,
      eventType: 'razorpay_payment_captured',
      outcome: 'success',
    });

    const values = query.mock.calls[0]![1] as unknown[];
    expect(values[1]).toBeNull(); // actor_user_id
    expect(values[2]).toBeNull(); // target_user_id
    expect(values[3]).toBeNull(); // target_resource
    expect(values[6]).toBeNull(); // reason_code
  });

  it('rejects empty event_type', async () => {
    const { client } = stubClient();

    await expect(
      writeAudit(client, { eventType: '', outcome: 'success' }),
    ).rejects.toThrow(/eventType/);
  });

  it('rejects an outcome outside the {success, failure} enum', async () => {
    const { client } = stubClient();

    await expect(
      writeAudit(client, {
        eventType: 'role_change',
        // @ts-expect-error: deliberately wrong runtime value to assert guard
        outcome: 'maybe',
      }),
    ).rejects.toThrow(/outcome/);
  });

  it('does not call query when validation fails (no partial commit risk)', async () => {
    const { client, query } = stubClient();

    await expect(
      writeAudit(client, { eventType: '', outcome: 'success' }),
    ).rejects.toThrow();

    expect(query).not.toHaveBeenCalled();
  });

  it('propagates database errors so the caller can ROLLBACK', async () => {
    const failing: AuditTransactionClient = {
      query: vi.fn(async () => {
        throw new Error('relation "audit_log" does not exist');
      }),
    };

    await expect(
      writeAudit(failing, { eventType: 'role_change', outcome: 'success' }),
    ).rejects.toThrow(/audit_log/);
  });
});
