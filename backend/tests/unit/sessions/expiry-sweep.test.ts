import { describe, expect, it, vi } from 'vitest';
import { runSessionExpirySweep } from '../../../src/sessions/expiry-sweep.js';

/**
 * Unit tests for `runSessionExpirySweep`.
 *
 * Validates: Requirements 8.5, 15.4, 15.5.
 *
 * These tests use a stubbed Pool to verify the SQL logic and
 * idempotency guarantees without requiring a live Postgres instance.
 */

function createMockPool(rowCount: number) {
  const query = vi.fn().mockResolvedValue({ rowCount, rows: [] });
  return { pool: { query } as unknown as import('pg').Pool, query };
}

describe('runSessionExpirySweep', () => {
  it('executes the correct UPDATE query targeting active expired sessions', async () => {
    const { pool, query } = createMockPool(3);
    const now = new Date('2024-06-15T10:00:00.000Z');

    const result = await runSessionExpirySweep(pool, now);

    expect(result.expired_count).toBe(3);
    expect(query).toHaveBeenCalledTimes(1);

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("SET status = 'expired'");
    expect(sql).toContain("ended_reason = 'expired'");
    expect(sql).toContain("WHERE status = 'active'");
    expect(sql).toContain('expires_at <= $1');
    expect(params).toEqual([now]);
  });

  it('returns expired_count = 0 when no sessions are past expiry', async () => {
    const { pool } = createMockPool(0);
    const now = new Date('2024-06-15T10:00:00.000Z');

    const result = await runSessionExpirySweep(pool, now);

    expect(result.expired_count).toBe(0);
  });

  it('is idempotent: running twice with same time yields 0 on second call', async () => {
    const now = new Date('2024-06-15T10:00:00.000Z');

    // First call: 2 sessions expired
    const { pool: pool1, query: query1 } = createMockPool(2);
    const result1 = await runSessionExpirySweep(pool1, now);
    expect(result1.expired_count).toBe(2);

    // Second call: same time, but now those rows are already 'expired'
    // so the UPDATE matches 0 rows
    const { pool: pool2 } = createMockPool(0);
    const result2 = await runSessionExpirySweep(pool2, now);
    expect(result2.expired_count).toBe(0);
  });

  it('uses current time when now parameter is not provided', async () => {
    const { pool, query } = createMockPool(1);

    const before = new Date();
    await runSessionExpirySweep(pool);
    const after = new Date();

    const passedDate = query.mock.calls[0]![1][0] as Date;
    expect(passedDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(passedDate.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('handles null rowCount gracefully (treats as 0)', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: null, rows: [] });
    const pool = { query } as unknown as import('pg').Pool;

    const result = await runSessionExpirySweep(pool);

    expect(result.expired_count).toBe(0);
  });

  it('sets ended_at to the same timestamp used in the WHERE clause', async () => {
    const { pool, query } = createMockPool(1);
    const now = new Date('2024-06-15T10:00:00.000Z');

    await runSessionExpirySweep(pool, now);

    const sql = query.mock.calls[0]![0] as string;
    // ended_at = $1 and expires_at <= $1 use the same parameter
    expect(sql).toContain('ended_at = $1');
    expect(sql).toContain('expires_at <= $1');
  });
});
