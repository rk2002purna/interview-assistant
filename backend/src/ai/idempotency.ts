/**
 * Idempotency cache module for AI_Proxy requests.
 *
 * Provides lookup-then-insert semantics for deduplicating AI operations
 * that arrive with an `Idempotency-Key` header. The cache stores a
 * SHA-256 hash of the canonical request payload alongside the original
 * response body, enabling:
 *
 *   - Cache hit: return the stored response without forwarding to the
 *     upstream provider (Requirement 7.6).
 *   - Hash conflict: reject with HTTP 409 `idempotency_key_conflict`
 *     when the same key is reused with a different payload (Requirement 7.7).
 *
 * Entries have a 24-hour TTL set at insert time (`expires_at = created_at + 24h`).
 * An hourly cleanup task removes expired rows.
 *
 * Requirements: 7.6, 7.7.
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Request hash computation
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hash of a canonical JSON representation of the
 * request payload. Keys are sorted recursively to ensure deterministic
 * serialization regardless of property insertion order.
 */
export function computeRequestHash(payload: unknown): Buffer {
  const canonical = JSON.stringify(sortKeys(payload)) ?? '';
  return createHash('sha256').update(canonical, 'utf8').digest();
}

/**
 * Recursively sort object keys for deterministic JSON serialization.
 * Arrays preserve element order; primitives pass through unchanged.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && !(value instanceof Date)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Cache lookup
// ---------------------------------------------------------------------------

/**
 * Result of an idempotency cache lookup.
 */
export type LookupResult =
  | { hit: true; response: unknown }
  | { hit: false };

const LOOKUP_SQL = `
  SELECT response_body, request_hash
    FROM idempotency_cache
   WHERE user_id = $1
     AND idempotency_key = $2
     AND expires_at > now()
`;

/**
 * Look up an existing cache entry for the given user and idempotency key.
 *
 * If a non-expired entry exists and the stored request_hash matches the
 * provided `requestHash`, returns `{ hit: true, response }`.
 *
 * If a non-expired entry exists but the stored request_hash does NOT match,
 * throws {@link IdempotencyKeyConflictError} (maps to HTTP 409
 * `idempotency_key_conflict` per Requirement 7.7).
 *
 * Returns `{ hit: false }` when no matching entry is found.
 *
 * @throws {@link IdempotencyKeyConflictError} if the key exists with a
 *         different request hash.
 */
export async function lookupIdempotencyCache(
  pool: Pool,
  userId: string,
  idempotencyKey: string,
  requestHash: Buffer,
): Promise<LookupResult> {
  const result = await pool.query<{ response_body: unknown; request_hash: Buffer }>(
    LOOKUP_SQL,
    [userId, idempotencyKey],
  );

  const row = result.rows[0];
  if (!row) {
    return { hit: false };
  }

  // Compare stored hash with the provided hash (Requirement 7.7)
  const storedHash = Buffer.isBuffer(row.request_hash)
    ? row.request_hash
    : Buffer.from(row.request_hash);

  if (!storedHash.equals(requestHash)) {
    throw new IdempotencyKeyConflictError(userId, idempotencyKey);
  }

  return { hit: true, response: row.response_body };
}

// ---------------------------------------------------------------------------
// Cache insert
// ---------------------------------------------------------------------------

/**
 * Error thrown when an idempotency key is reused with a different request
 * payload hash. The AI proxy maps this to HTTP 409 `idempotency_key_conflict`.
 */
export class IdempotencyKeyConflictError extends Error {
  readonly code = 'idempotency_key_conflict' as const;
  readonly httpStatus = 409 as const;

  constructor(userId: string, idempotencyKey: string) {
    super(
      `Idempotency key conflict: key ${idempotencyKey} for user ${userId} ` +
        `was previously used with a different request payload`,
    );
    this.name = 'IdempotencyKeyConflictError';
  }
}

/**
 * Result of an idempotency cache insert attempt.
 */
export interface InsertResult {
  /** True if the row was freshly inserted; false if a conflict prevented insertion. */
  inserted: boolean;
}

const INSERT_SQL = `
  INSERT INTO idempotency_cache (user_id, idempotency_key, request_hash, response_body, created_at, expires_at)
  VALUES ($1, $2, $3, $4, now(), now() + interval '24 hours')
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING (xmax = 0) AS inserted
`;

const CHECK_HASH_SQL = `
  SELECT request_hash
    FROM idempotency_cache
   WHERE user_id = $1
     AND idempotency_key = $2
`;

/**
 * Attempt to insert a new idempotency cache entry.
 *
 * Uses `INSERT ... ON CONFLICT DO NOTHING RETURNING (xmax = 0) AS inserted`
 * to determine in a single query whether the row was freshly inserted.
 * When `xmax = 0`, the tuple was newly created (not a HOT update or conflict).
 *
 * If a conflict exists (same user_id + idempotency_key), verifies that the
 * stored request_hash matches the provided hash. If the hashes differ, throws
 * {@link IdempotencyKeyConflictError}.
 *
 * @returns `{ inserted: true }` if the row was freshly inserted, or
 *          `{ inserted: false }` if the key already existed with a
 *          matching hash (safe replay).
 * @throws  {@link IdempotencyKeyConflictError} if the key exists with
 *          a different request hash.
 */
export async function insertIdempotencyCache(
  pool: Pool,
  userId: string,
  idempotencyKey: string,
  requestHash: Buffer,
  response: unknown,
): Promise<InsertResult> {
  const result = await pool.query<{ inserted: boolean }>(INSERT_SQL, [
    userId,
    idempotencyKey,
    requestHash,
    JSON.stringify(response),
  ]);

  // If a row was returned, the insert succeeded (xmax = 0 means fresh tuple)
  const firstRow = result.rows[0];
  if (result.rows.length > 0 && firstRow && firstRow.inserted) {
    return { inserted: true };
  }

  // No row returned means ON CONFLICT fired — check if the hash matches
  if (result.rows.length === 0) {
    const existing = await pool.query<{ request_hash: Buffer }>(
      CHECK_HASH_SQL,
      [userId, idempotencyKey],
    );

    const existingRow = existing.rows[0];
    if (existingRow) {
      const storedHash = Buffer.isBuffer(existingRow.request_hash)
        ? existingRow.request_hash
        : Buffer.from(existingRow.request_hash);

      if (!storedHash.equals(requestHash)) {
        throw new IdempotencyKeyConflictError(userId, idempotencyKey);
      }
    }
  }

  // Same key, same hash — safe replay.
  return { inserted: false };
}

// ---------------------------------------------------------------------------
// Expired cache cleanup
// ---------------------------------------------------------------------------

const CLEANUP_SQL = `
  DELETE FROM idempotency_cache
   WHERE expires_at < now()
`;

/**
 * Remove all expired idempotency cache entries.
 *
 * Intended to be called by an hourly scheduled task. Returns the number
 * of rows deleted for observability.
 */
export async function cleanupExpiredCache(
  pool: Pool,
): Promise<{ deleted: number }> {
  const result = await pool.query(CLEANUP_SQL);
  return { deleted: result.rowCount ?? 0 };
}
