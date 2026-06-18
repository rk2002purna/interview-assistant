/**
 * Unit tests for the idempotency cache module (`src/ai/idempotency.ts`).
 *
 * Covers:
 *   - computeRequestHash: deterministic SHA-256 with sorted keys
 *   - lookupIdempotencyCache: cache miss and cache hit scenarios
 *   - insertIdempotencyCache: fresh insert, duplicate with matching hash,
 *     and hash conflict detection
 *   - cleanupExpiredCache: removal of expired entries
 *
 * Uses an in-process pg-shaped fake (same pattern as keys.test.ts) to
 * avoid external dependencies while preserving Buffer round-trips.
 *
 * Validates: Requirements 7.6, 7.7.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import {
  computeRequestHash,
  lookupIdempotencyCache,
  insertIdempotencyCache,
  cleanupExpiredCache,
  IdempotencyKeyConflictError,
} from '../../../src/ai/idempotency.js';

// ---------------------------------------------------------------------------
// In-process pg-shaped fake for idempotency_cache
// ---------------------------------------------------------------------------

interface CacheRow {
  user_id: string;
  idempotency_key: string;
  request_hash: Buffer;
  response_body: unknown;
  created_at: Date;
  expires_at: Date;
}

interface FakeDb {
  rows: Map<string, CacheRow>;
  /** Simulated current time; defaults to real time. */
  now: () => Date;
}

function compositeKey(userId: string, idempotencyKey: string): string {
  return `${userId}::${idempotencyKey}`;
}

function createFakePool(db: FakeDb): Pool {
  const exec = async (
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.trim();
    const upper = sql.toUpperCase();

    // SELECT for lookup
    if (upper.includes('SELECT RESPONSE_BODY, REQUEST_HASH') && upper.includes('EXPIRES_AT > NOW()')) {
      const userId = values[0] as string;
      const idempotencyKey = values[1] as string;
      const key = compositeKey(userId, idempotencyKey);
      const row = db.rows.get(key);
      if (!row || row.expires_at <= db.now()) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [{ response_body: row.response_body, request_hash: row.request_hash }],
        rowCount: 1,
      };
    }

    // SELECT for hash check (no expires_at filter)
    if (upper.includes('SELECT REQUEST_HASH') && !upper.includes('EXPIRES_AT > NOW()')) {
      const userId = values[0] as string;
      const idempotencyKey = values[1] as string;
      const key = compositeKey(userId, idempotencyKey);
      const row = db.rows.get(key);
      if (!row) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [{ request_hash: row.request_hash }],
        rowCount: 1,
      };
    }

    // INSERT ... ON CONFLICT DO NOTHING
    if (upper.startsWith('INSERT INTO IDEMPOTENCY_CACHE')) {
      const userId = values[0] as string;
      const idempotencyKey = values[1] as string;
      const requestHash = values[2] as Buffer;
      const responseBody = values[3] as string;
      const key = compositeKey(userId, idempotencyKey);

      if (db.rows.has(key)) {
        // Conflict — DO NOTHING, no rows returned
        return { rows: [], rowCount: 0 };
      }

      const now = db.now();
      const row: CacheRow = {
        user_id: userId,
        idempotency_key: idempotencyKey,
        request_hash: Buffer.isBuffer(requestHash) ? requestHash : Buffer.from(requestHash),
        response_body: JSON.parse(responseBody),
        created_at: now,
        expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      };
      db.rows.set(key, row);
      // Simulate RETURNING (xmax = 0) AS inserted — fresh insert returns true
      return { rows: [{ inserted: true }], rowCount: 1 };
    }

    // DELETE expired
    if (upper.startsWith('DELETE FROM IDEMPOTENCY_CACHE')) {
      const now = db.now();
      let deleted = 0;
      for (const [key, row] of db.rows.entries()) {
        if (row.expires_at < now) {
          db.rows.delete(key);
          deleted++;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    throw new Error(`fake-pool: unsupported SQL: ${sql}`);
  };

  const pool = {
    query: ((text: string, values?: ReadonlyArray<unknown>) =>
      exec(text, values ?? [])) as Pool['query'],
  } as unknown as Pool;

  return pool;
}

// ---------------------------------------------------------------------------
// Tests: computeRequestHash
// ---------------------------------------------------------------------------

describe('ai/idempotency: computeRequestHash', () => {
  it('returns a 32-byte Buffer (SHA-256)', () => {
    const hash = computeRequestHash({ model: 'gemini', prompt: 'hello' });
    expect(Buffer.isBuffer(hash)).toBe(true);
    expect(hash.length).toBe(32);
  });

  it('produces the same hash regardless of key insertion order', () => {
    const a = computeRequestHash({ z: 1, a: 2, m: 3 });
    const b = computeRequestHash({ a: 2, m: 3, z: 1 });
    expect(a.equals(b)).toBe(true);
  });

  it('produces different hashes for different payloads', () => {
    const a = computeRequestHash({ prompt: 'hello' });
    const b = computeRequestHash({ prompt: 'world' });
    expect(a.equals(b)).toBe(false);
  });

  it('handles nested objects with sorted keys', () => {
    const a = computeRequestHash({ outer: { z: 1, a: 2 } });
    const b = computeRequestHash({ outer: { a: 2, z: 1 } });
    expect(a.equals(b)).toBe(true);
  });

  it('preserves array order', () => {
    const a = computeRequestHash({ items: [1, 2, 3] });
    const b = computeRequestHash({ items: [3, 2, 1] });
    expect(a.equals(b)).toBe(false);
  });

  it('handles null and undefined values', () => {
    const a = computeRequestHash(null);
    const b = computeRequestHash(null);
    expect(a.equals(b)).toBe(true);

    const c = computeRequestHash(undefined);
    const d = computeRequestHash(undefined);
    expect(c.equals(d)).toBe(true);
  });

  it('handles primitive values', () => {
    const a = computeRequestHash('hello');
    const b = computeRequestHash('hello');
    expect(a.equals(b)).toBe(true);

    const c = computeRequestHash(42);
    const d = computeRequestHash(42);
    expect(c.equals(d)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: lookupIdempotencyCache
// ---------------------------------------------------------------------------

describe('ai/idempotency: lookupIdempotencyCache', () => {
  let db: FakeDb;
  let pool: Pool;

  beforeEach(() => {
    db = { rows: new Map(), now: () => new Date() };
    pool = createFakePool(db);
  });

  it('returns { hit: false } when no entry exists (cache miss)', async () => {
    const hash = computeRequestHash({ prompt: 'anything' });
    const result = await lookupIdempotencyCache(pool, randomUUID(), randomUUID(), hash);
    expect(result).toEqual({ hit: false });
  });

  it('returns { hit: true, response } when a valid entry exists and hash matches', async () => {
    const userId = randomUUID();
    const idempotencyKey = randomUUID();
    const response = { text: 'AI response', tokens: 42 };
    const hash = computeRequestHash({ prompt: 'test' });

    // Insert directly into fake DB
    const now = new Date();
    db.rows.set(compositeKey(userId, idempotencyKey), {
      user_id: userId,
      idempotency_key: idempotencyKey,
      request_hash: hash,
      response_body: response,
      created_at: now,
      expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });

    const result = await lookupIdempotencyCache(pool, userId, idempotencyKey, hash);
    expect(result).toEqual({ hit: true, response });
  });

  it('throws IdempotencyKeyConflictError when entry exists but hash does not match', async () => {
    const userId = randomUUID();
    const idempotencyKey = randomUUID();
    const storedHash = computeRequestHash({ prompt: 'original' });
    const differentHash = computeRequestHash({ prompt: 'different payload' });
    const response = { text: 'AI response' };

    // Insert directly into fake DB
    const now = new Date();
    db.rows.set(compositeKey(userId, idempotencyKey), {
      user_id: userId,
      idempotency_key: idempotencyKey,
      request_hash: storedHash,
      response_body: response,
      created_at: now,
      expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });

    await expect(
      lookupIdempotencyCache(pool, userId, idempotencyKey, differentHash),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    try {
      await lookupIdempotencyCache(pool, userId, idempotencyKey, differentHash);
    } catch (err) {
      const e = err as IdempotencyKeyConflictError;
      expect(e.code).toBe('idempotency_key_conflict');
      expect(e.httpStatus).toBe(409);
      expect(e.message).toContain(idempotencyKey);
      expect(e.message).toContain(userId);
    }
  });

  it('returns { hit: false } when the entry has expired', async () => {
    const userId = randomUUID();
    const idempotencyKey = randomUUID();
    const hash = computeRequestHash({ prompt: 'test' });

    // Insert an expired entry
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    db.rows.set(compositeKey(userId, idempotencyKey), {
      user_id: userId,
      idempotency_key: idempotencyKey,
      request_hash: hash,
      response_body: { text: 'old response' },
      created_at: new Date(past.getTime() - 24 * 60 * 60 * 1000),
      expires_at: past,
    });

    const result = await lookupIdempotencyCache(pool, userId, idempotencyKey, hash);
    expect(result).toEqual({ hit: false });
  });
});

// ---------------------------------------------------------------------------
// Tests: insertIdempotencyCache
// ---------------------------------------------------------------------------

describe('ai/idempotency: insertIdempotencyCache', () => {
  let db: FakeDb;
  let pool: Pool;

  beforeEach(() => {
    db = { rows: new Map(), now: () => new Date() };
    pool = createFakePool(db);
  });

  it('inserts a new entry and returns { inserted: true }', async () => {
    const userId = randomUUID();
    const idempotencyKey = randomUUID();
    const hash = computeRequestHash({ prompt: 'hello' });
    const response = { text: 'world' };

    const result = await insertIdempotencyCache(pool, userId, idempotencyKey, hash, response);
    expect(result).toEqual({ inserted: true });

    // Verify the entry is in the fake DB
    const key = compositeKey(userId, idempotencyKey);
    const row = db.rows.get(key);
    expect(row).toBeDefined();
    expect(row!.request_hash.equals(hash)).toBe(true);
    expect(row!.response_body).toEqual(response);
  });

  it('returns { inserted: false } when key exists with matching hash (safe replay)', async () => {
    const userId = randomUUID();
    const idempotencyKey = randomUUID();
    const hash = computeRequestHash({ prompt: 'hello' });
    const response = { text: 'world' };

    // First insert
    await insertIdempotencyCache(pool, userId, idempotencyKey, hash, response);

    // Second insert with same hash — should be a safe replay
    const result = await insertIdempotencyCache(pool, userId, idempotencyKey, hash, response);
    expect(result).toEqual({ inserted: false });
  });

  it('throws IdempotencyKeyConflictError when key exists with different hash', async () => {
    const userId = randomUUID();
    const idempotencyKey = randomUUID();
    const hash1 = computeRequestHash({ prompt: 'hello' });
    const hash2 = computeRequestHash({ prompt: 'different payload' });
    const response = { text: 'world' };

    // First insert
    await insertIdempotencyCache(pool, userId, idempotencyKey, hash1, response);

    // Second insert with different hash — should throw conflict
    await expect(
      insertIdempotencyCache(pool, userId, idempotencyKey, hash2, response),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    try {
      await insertIdempotencyCache(pool, userId, idempotencyKey, hash2, response);
    } catch (err) {
      const e = err as IdempotencyKeyConflictError;
      expect(e.code).toBe('idempotency_key_conflict');
      expect(e.httpStatus).toBe(409);
      expect(e.message).toContain(idempotencyKey);
      expect(e.message).toContain(userId);
    }
  });

  it('sets expires_at to 24 hours after created_at', async () => {
    const userId = randomUUID();
    const idempotencyKey = randomUUID();
    const hash = computeRequestHash({ prompt: 'test' });

    const fixedNow = new Date('2024-06-15T12:00:00Z');
    db.now = () => fixedNow;

    await insertIdempotencyCache(pool, userId, idempotencyKey, hash, { ok: true });

    const key = compositeKey(userId, idempotencyKey);
    const row = db.rows.get(key)!;
    const expectedExpiry = new Date('2024-06-16T12:00:00Z');
    expect(row.expires_at.getTime()).toBe(expectedExpiry.getTime());
  });
});

// ---------------------------------------------------------------------------
// Tests: cleanupExpiredCache
// ---------------------------------------------------------------------------

describe('ai/idempotency: cleanupExpiredCache', () => {
  let db: FakeDb;
  let pool: Pool;

  beforeEach(() => {
    db = { rows: new Map(), now: () => new Date() };
    pool = createFakePool(db);
  });

  it('returns { deleted: 0 } when no entries exist', async () => {
    const result = await cleanupExpiredCache(pool);
    expect(result).toEqual({ deleted: 0 });
  });

  it('deletes expired entries and returns the count', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago
    const future = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour from now

    // Add 2 expired entries and 1 valid entry
    db.rows.set(compositeKey('user1', 'key1'), {
      user_id: 'user1',
      idempotency_key: 'key1',
      request_hash: computeRequestHash({ a: 1 }),
      response_body: { r: 1 },
      created_at: new Date(past.getTime() - 24 * 60 * 60 * 1000),
      expires_at: past,
    });
    db.rows.set(compositeKey('user2', 'key2'), {
      user_id: 'user2',
      idempotency_key: 'key2',
      request_hash: computeRequestHash({ b: 2 }),
      response_body: { r: 2 },
      created_at: new Date(past.getTime() - 24 * 60 * 60 * 1000),
      expires_at: new Date(past.getTime() - 30 * 60 * 1000), // even more expired
    });
    db.rows.set(compositeKey('user3', 'key3'), {
      user_id: 'user3',
      idempotency_key: 'key3',
      request_hash: computeRequestHash({ c: 3 }),
      response_body: { r: 3 },
      created_at: now,
      expires_at: future,
    });

    const result = await cleanupExpiredCache(pool);
    expect(result).toEqual({ deleted: 2 });

    // Only the valid entry remains
    expect(db.rows.size).toBe(1);
    expect(db.rows.has(compositeKey('user3', 'key3'))).toBe(true);
  });

  it('does not delete entries that have not yet expired', async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12 hours from now

    db.rows.set(compositeKey('user1', 'key1'), {
      user_id: 'user1',
      idempotency_key: 'key1',
      request_hash: computeRequestHash({ x: 1 }),
      response_body: { r: 1 },
      created_at: now,
      expires_at: future,
    });

    const result = await cleanupExpiredCache(pool);
    expect(result).toEqual({ deleted: 0 });
    expect(db.rows.size).toBe(1);
  });
});
