import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  DEFAULT_STORAGE_SAMPLE_TTL_MS,
  StorageQuotaExceededError,
  StorageQuotaGate,
  createPgDatabaseSampler,
  type StorageQuotaSampler,
} from '../../../src/storage/quota-gate.js';

const MIB = 1024 * 1024;

function fakeSampler(values: number[] | (() => number)): {
  sampler: StorageQuotaSampler;
  calls: number;
  remaining: () => number;
} {
  const state = { calls: 0 };
  const sampler: StorageQuotaSampler = {
    async sampleBytes(): Promise<number> {
      state.calls += 1;
      if (typeof values === 'function') return values();
      const next = values.shift();
      if (next === undefined) {
        throw new Error('fakeSampler: ran out of preprogrammed values');
      }
      return next;
    },
  };
  return {
    sampler,
    get calls() {
      return state.calls;
    },
    remaining: () => (Array.isArray(values) ? values.length : -1),
  };
}

describe('StorageQuotaGate.assertCanWriteBlob', () => {
  it('accepts writes when usage is well below the 450 MiB threshold', async () => {
    const f = fakeSampler([100 * MIB]);
    const gate = new StorageQuotaGate({ sampler: f.sampler });
    await expect(gate.assertCanWriteBlob()).resolves.toBeUndefined();
  });

  it('rejects with 507 storage_quota_exceeded at exactly the threshold', async () => {
    const f = fakeSampler([DEFAULT_STORAGE_QUOTA_BYTES]);
    const gate = new StorageQuotaGate({ sampler: f.sampler });
    await expect(gate.assertCanWriteBlob()).rejects.toBeInstanceOf(
      StorageQuotaExceededError,
    );
    try {
      await gate.assertCanWriteBlob();
    } catch (err) {
      expect(err).toBeInstanceOf(StorageQuotaExceededError);
      const e = err as StorageQuotaExceededError;
      expect(e.code).toBe('storage_quota_exceeded');
      expect(e.httpStatus).toBe(507);
      expect(e.observedBytes).toBe(DEFAULT_STORAGE_QUOTA_BYTES);
      expect(e.thresholdBytes).toBe(DEFAULT_STORAGE_QUOTA_BYTES);
    }
  });

  it('rejects when usage strictly exceeds the threshold', async () => {
    const f = fakeSampler([DEFAULT_STORAGE_QUOTA_BYTES + 1]);
    const gate = new StorageQuotaGate({ sampler: f.sampler });
    await expect(gate.assertCanWriteBlob()).rejects.toBeInstanceOf(
      StorageQuotaExceededError,
    );
  });

  it('accepts at one byte below the threshold (boundary, U < 450 MB)', async () => {
    const f = fakeSampler([DEFAULT_STORAGE_QUOTA_BYTES - 1]);
    const gate = new StorageQuotaGate({ sampler: f.sampler });
    await expect(gate.assertCanWriteBlob()).resolves.toBeUndefined();
  });

  it('honors a custom thresholdBytes override', async () => {
    const f = fakeSampler([10 * MIB]);
    const gate = new StorageQuotaGate({
      sampler: f.sampler,
      thresholdBytes: 5 * MIB,
    });
    await expect(gate.assertCanWriteBlob()).rejects.toBeInstanceOf(
      StorageQuotaExceededError,
    );
  });
});

describe('StorageQuotaGate caching', () => {
  it('reuses a cached sample within the TTL window', async () => {
    let now = 1_000_000;
    const f = fakeSampler([100 * MIB, 600 * MIB]);
    const gate = new StorageQuotaGate({
      sampler: f.sampler,
      sampleTtlMs: 60_000,
      now: () => now,
    });

    await gate.assertCanWriteBlob();
    expect(f.calls).toBe(1);

    now += 30_000; // still within the 60s TTL
    await gate.assertCanWriteBlob();
    expect(f.calls).toBe(1);
  });

  it('re-samples once the TTL expires', async () => {
    let now = 1_000_000;
    const f = fakeSampler([100 * MIB, 200 * MIB]);
    const gate = new StorageQuotaGate({
      sampler: f.sampler,
      sampleTtlMs: 60_000,
      now: () => now,
    });

    await gate.assertCanWriteBlob();
    now += 60_000; // TTL expired (cache valid for [t, t+ttl))
    await gate.assertCanWriteBlob();
    expect(f.calls).toBe(2);
  });

  it('coalesces concurrent stale-cache callers into a single sample', async () => {
    let resolveSampler: ((v: number) => void) | null = null;
    let calls = 0;
    const sampler: StorageQuotaSampler = {
      sampleBytes: () =>
        new Promise<number>((resolve) => {
          calls += 1;
          resolveSampler = resolve;
        }),
    };
    const gate = new StorageQuotaGate({ sampler });

    const a = gate.assertCanWriteBlob();
    const b = gate.assertCanWriteBlob();
    const c = gate.assertCanWriteBlob();

    expect(calls).toBe(1);
    resolveSampler!(50 * MIB);
    await Promise.all([a, b, c]);
    expect(calls).toBe(1);
  });

  it('clears the in-flight slot on sampler failure so the next call retries', async () => {
    let attempt = 0;
    const sampler: StorageQuotaSampler = {
      async sampleBytes(): Promise<number> {
        attempt += 1;
        if (attempt === 1) throw new Error('boom');
        return 10 * MIB;
      },
    };
    const gate = new StorageQuotaGate({ sampler });

    await expect(gate.assertCanWriteBlob()).rejects.toThrow('boom');
    await expect(gate.assertCanWriteBlob()).resolves.toBeUndefined();
    expect(attempt).toBe(2);
  });

  it('peek() exposes the cached observation without sampling', async () => {
    let now = 1_000;
    const f = fakeSampler([42 * MIB]);
    const gate = new StorageQuotaGate({
      sampler: f.sampler,
      now: () => now,
    });

    expect(gate.peek().observedBytes).toBeNull();
    expect(gate.peek().thresholdBytes).toBe(DEFAULT_STORAGE_QUOTA_BYTES);
    expect(gate.peek().sampleTtlMs).toBe(DEFAULT_STORAGE_SAMPLE_TTL_MS);

    await gate.assertCanWriteBlob();
    expect(f.calls).toBe(1);

    const snap = gate.peek();
    expect(snap.observedBytes).toBe(42 * MIB);
    expect(snap.sampledAtMs).toBe(now);
    expect(f.calls).toBe(1); // peek does not sample
  });

  it('invalidate() forces the next call to re-sample', async () => {
    const f = fakeSampler([10 * MIB, 20 * MIB]);
    const gate = new StorageQuotaGate({ sampler: f.sampler });

    await gate.assertCanWriteBlob();
    gate.invalidate();
    await gate.assertCanWriteBlob();
    expect(f.calls).toBe(2);
  });
});

describe('StorageQuotaGate construction', () => {
  it('throws when thresholdBytes is non-positive', () => {
    const f = fakeSampler([0]);
    expect(
      () => new StorageQuotaGate({ sampler: f.sampler, thresholdBytes: 0 }),
    ).toThrow(/positive finite number/);
    expect(
      () => new StorageQuotaGate({ sampler: f.sampler, thresholdBytes: -1 }),
    ).toThrow(/positive finite number/);
    expect(
      () =>
        new StorageQuotaGate({
          sampler: f.sampler,
          thresholdBytes: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(/positive finite number/);
  });

  it('throws when sampleTtlMs is negative or non-finite', () => {
    const f = fakeSampler([0]);
    expect(
      () => new StorageQuotaGate({ sampler: f.sampler, sampleTtlMs: -1 }),
    ).toThrow(/non-negative finite number/);
    expect(
      () =>
        new StorageQuotaGate({
          sampler: f.sampler,
          sampleTtlMs: Number.NaN,
        }),
    ).toThrow(/non-negative finite number/);
  });

  it('accepts sampleTtlMs of 0 and re-samples on every call', async () => {
    const f = fakeSampler([10 * MIB, 20 * MIB, 30 * MIB]);
    const gate = new StorageQuotaGate({ sampler: f.sampler, sampleTtlMs: 0 });
    await gate.assertCanWriteBlob();
    await gate.assertCanWriteBlob();
    await gate.assertCanWriteBlob();
    expect(f.calls).toBe(3);
  });
});

describe('createPgDatabaseSampler', () => {
  it('runs pg_database_size(current_database()) and parses the bytes', async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toMatch(/pg_database_size\(current_database\(\)\)/);
      return { rows: [{ size: '123456789' }] };
    });
    const sampler = createPgDatabaseSampler({ query } as never);
    const bytes = await sampler.sampleBytes();
    expect(bytes).toBe(123_456_789);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects when pg_database_size returns no rows', async () => {
    const sampler = createPgDatabaseSampler({
      query: async () => ({ rows: [] }),
    } as never);
    await expect(sampler.sampleBytes()).rejects.toThrow(/no rows/);
  });

  it('rejects when pg_database_size returns a non-numeric value', async () => {
    const sampler = createPgDatabaseSampler({
      query: async () => ({ rows: [{ size: 'not-a-number' }] }),
    } as never);
    await expect(sampler.sampleBytes()).rejects.toThrow(/unexpected value/);
  });
});

describe('Read-only contract (Requirement 15.3 / Property 35)', () => {
  it('never invokes any pool method other than read-only query()', async () => {
    // The gate's only DB seam is via the sampler. We assert the default
    // sampler issues a single SELECT and never calls connect/begin/etc.
    const recorded: string[] = [];
    const fakePool = {
      query: async (sql: string) => {
        recorded.push(sql);
        return { rows: [{ size: '0' }] };
      },
    };
    const sampler = createPgDatabaseSampler(fakePool as never);
    const gate = new StorageQuotaGate({ sampler });
    await gate.assertCanWriteBlob();
    await gate.assertCanWriteBlob();
    expect(recorded).toHaveLength(1); // cached on second call
    expect(recorded[0]!.toUpperCase()).toMatch(/^SELECT\b/);
    expect(recorded[0]!).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE/i);
  });
});
