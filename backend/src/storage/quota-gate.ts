/**
 * Storage quota gate for blob persistence.
 *
 * Implements Requirement 15.3:
 *
 *   "IF total persistent Postgres storage usage exceeds 450 megabytes,
 *    THEN THE Backend_API SHALL reject new blob persistence requests
 *    with an error response indicating storage quota exceeded, while
 *    preserving all existing stored data without modification."
 *
 * The gate exposes a single seam — `assertCanWriteBlob()` — that
 * blob-writing routes (today: `POST /ai/audio`, task 9.9) call before
 * persisting a new audio blob. When the latest sampled database size is
 * at or above the configured threshold, the assertion throws
 * `StorageQuotaExceededError`, which the HTTP layer maps to the uniform
 * `507 storage_quota_exceeded` envelope per the design's error code
 * table.
 *
 * Design notes:
 *
 *   - Sampling is performed against `pg_database_size(current_database())`,
 *     which returns total on-disk size (heap, toast, indexes) of the
 *     active database in bytes. This matches the "total persistent
 *     Postgres storage usage" wording in Requirement 15.3 and is
 *     available without superuser privileges on managed providers like
 *     Supabase.
 *   - The result is cached for `sampleTtlMs` (default 60s) so that a
 *     burst of blob writes does not turn into a burst of size queries.
 *     The cache is in-process; in serverless deployments each cold
 *     instance pays one extra query on first use, which is acceptable.
 *   - The gate is strictly read-only. `pg_database_size` is a SELECT;
 *     `assertCanWriteBlob` performs no INSERT/UPDATE/DELETE. This is
 *     the structural reason the gate "never modifies existing data"
 *     (Requirement 15.3, Property 35).
 *   - The threshold is compared with `>=` so a request observed at
 *     exactly 450 MB is rejected. The requirement says "exceeds 450
 *     megabytes" but the design's Property 35 makes the intent precise:
 *     "accepts new blobs iff `U < 450 MB`", which is the contract this
 *     module implements.
 *
 * Concurrency model:
 *
 *   - When the cache is stale, only one `pg_database_size` query is
 *     ever in flight at a time. Concurrent callers await the same
 *     promise. This keeps the read amplification of a multi-concurrent
 *     `/ai/audio` burst at exactly one DB round-trip per TTL window.
 *   - If the sampler throws, the in-flight promise is cleared so the
 *     next call retries; the error is propagated to the caller so the
 *     route layer can map it to a 500 (the gate does not invent a
 *     "fail-open" or "fail-closed" policy on its own — the design
 *     leaves that to the consuming handler).
 *
 * Requirements: 15.3.
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** One mebibyte in bytes. Used to make threshold expressions readable. */
const MIB = 1024 * 1024;

/**
 * Default storage threshold per Requirement 15.3 / Property 35.
 *
 * 450 megabytes expressed in mebibytes (`MB` in storage contexts on
 * managed Postgres providers consistently means MiB; `pg_database_size`
 * returns bytes, and 450 * 1024 * 1024 is the binary interpretation
 * Supabase's storage dashboard uses). Callers that want the decimal
 * interpretation (450 * 1000 * 1000) can override `thresholdBytes`.
 */
export const DEFAULT_STORAGE_QUOTA_BYTES = 450 * MIB;

/** Default TTL for a successful storage size sample. */
export const DEFAULT_STORAGE_SAMPLE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Error thrown by `StorageQuotaGate.assertCanWriteBlob` when the most
 * recently observed database size meets or exceeds the configured
 * threshold.
 *
 * The HTTP layer matches on `instanceof StorageQuotaExceededError`
 * (or on `error.code === 'storage_quota_exceeded'`) and emits the
 * uniform `507` envelope:
 *
 *     { "error": { "code": "storage_quota_exceeded",
 *                  "message": "...",
 *                  "details": { "observed_bytes": ..., "threshold_bytes": ... } } }
 *
 * `code` and `httpStatus` are public, readonly literals so callers can
 * branch on them without re-importing this class.
 */
export class StorageQuotaExceededError extends Error {
  /** Stable machine-readable error code (design Error Code table). */
  readonly code = 'storage_quota_exceeded' as const;
  /** HTTP status the route layer should return. */
  readonly httpStatus = 507 as const;
  /** Most recently observed total storage size in bytes. */
  readonly observedBytes: number;
  /** Threshold against which `observedBytes` was compared. */
  readonly thresholdBytes: number;

  constructor(observedBytes: number, thresholdBytes: number) {
    super(
      `Postgres storage usage ${observedBytes} bytes is at or above the ` +
        `${thresholdBytes}-byte blob persistence threshold`,
    );
    this.name = 'StorageQuotaExceededError';
    this.observedBytes = observedBytes;
    this.thresholdBytes = thresholdBytes;
  }
}

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------

/**
 * A single database-storage observation. The contract is intentionally
 * narrow so tests can substitute a deterministic in-memory sampler
 * without faking a `pg.Pool`, and so the gate is portable across hosts
 * that expose total storage via different SQL (e.g. Supabase
 * `storage.usage_in_bytes()` for object storage in the future).
 */
export interface StorageQuotaSampler {
  /** Returns total persistent storage size, in bytes, at call time. */
  sampleBytes(): Promise<number>;
}

/**
 * Build a sampler that reads `pg_database_size(current_database())`.
 *
 * The query returns a `bigint`; we read it as text to avoid the silent
 * truncation that `node-postgres` performs on `bigint` columns by
 * default, then parse it through `Number`. Sizes up to
 * `Number.MAX_SAFE_INTEGER` (~9 PB) are representable; the design
 * caps deployments at 500 MB so the precision loss is not a concern.
 */
export function createPgDatabaseSampler(pool: Pool): StorageQuotaSampler {
  return {
    async sampleBytes(): Promise<number> {
      const result = await pool.query<{ size: string }>(
        'SELECT pg_database_size(current_database())::text AS size',
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('pg_database_size returned no rows');
      }
      const parsed = Number(row.size);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(
          `pg_database_size returned an unexpected value: ${JSON.stringify(row.size)}`,
        );
      }
      return parsed;
    },
  };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Construction options for {@link StorageQuotaGate}.
 *
 * Every field except `sampler` has a sensible default so production
 * code can construct a gate with `new StorageQuotaGate({ sampler })`.
 */
export interface StorageQuotaGateOptions {
  /** Source of storage observations. */
  readonly sampler: StorageQuotaSampler;
  /**
   * Threshold in bytes. Defaults to {@link DEFAULT_STORAGE_QUOTA_BYTES}
   * (450 MiB per Requirement 15.3 / Property 35). Must be a positive,
   * finite number.
   */
  readonly thresholdBytes?: number;
  /**
   * How long, in milliseconds, a successful sample remains valid before
   * the next `assertCanWriteBlob` call triggers a re-sample. Defaults
   * to {@link DEFAULT_STORAGE_SAMPLE_TTL_MS} (60 s). Set to `0` to
   * disable caching (useful in tests).
   */
  readonly sampleTtlMs?: number;
  /**
   * Monotonic-ish clock source. Defaults to `Date.now`. Tests pass a
   * controllable clock so they can drive cache invalidation
   * deterministically.
   */
  readonly now?: () => number;
}

/**
 * Snapshot returned by {@link StorageQuotaGate.peek}, exposing the
 * cached observation without forcing a refresh. Useful for `/health`
 * and admin diagnostics; never used by the gate itself for decisions.
 */
export interface StorageQuotaSnapshot {
  /** Cached size in bytes, or `null` if no sample has succeeded yet. */
  readonly observedBytes: number | null;
  /** Wall time (ms since epoch) of the cached sample, or `null`. */
  readonly sampledAtMs: number | null;
  /** Threshold in bytes that the gate compares against. */
  readonly thresholdBytes: number;
  /** TTL of a sample, in milliseconds. */
  readonly sampleTtlMs: number;
}

interface CachedSample {
  readonly bytes: number;
  readonly sampledAtMs: number;
}

/**
 * Periodically-sampling, in-process storage quota gate.
 *
 * Construct one per process (the gate holds a private cache so a
 * shared instance is preferable to fresh-per-request allocation).
 * The gate is safe to share across concurrent requests; the in-flight
 * sample-deduplication logic ensures no thundering-herd on the
 * `pg_database_size` query.
 */
export class StorageQuotaGate {
  private readonly sampler: StorageQuotaSampler;
  private readonly thresholdBytes: number;
  private readonly sampleTtlMs: number;
  private readonly now: () => number;

  private cached: CachedSample | null = null;
  private inFlight: Promise<number> | null = null;

  constructor(options: StorageQuotaGateOptions) {
    if (!options.sampler) {
      throw new Error('StorageQuotaGate: sampler is required');
    }
    const threshold =
      options.thresholdBytes ?? DEFAULT_STORAGE_QUOTA_BYTES;
    if (!Number.isFinite(threshold) || threshold <= 0) {
      throw new Error(
        `StorageQuotaGate: thresholdBytes must be a positive finite number (got ${threshold})`,
      );
    }
    const ttl = options.sampleTtlMs ?? DEFAULT_STORAGE_SAMPLE_TTL_MS;
    if (!Number.isFinite(ttl) || ttl < 0) {
      throw new Error(
        `StorageQuotaGate: sampleTtlMs must be a non-negative finite number (got ${ttl})`,
      );
    }
    this.sampler = options.sampler;
    this.thresholdBytes = threshold;
    this.sampleTtlMs = ttl;
    this.now = options.now ?? Date.now;
  }

  /**
   * Reject the imminent blob write when the latest sampled storage
   * usage is at or above the configured threshold.
   *
   * The method may issue a fresh sample (when the cache is empty or
   * stale) or reuse a recent one. On rejection it throws
   * {@link StorageQuotaExceededError}; the route layer is responsible
   * for translating that into the 507 response envelope.
   *
   * The method performs no writes against the database.
   */
  async assertCanWriteBlob(): Promise<void> {
    const bytes = await this.observeBytes();
    if (bytes >= this.thresholdBytes) {
      throw new StorageQuotaExceededError(bytes, this.thresholdBytes);
    }
  }

  /**
   * Force a fresh sample on the next `assertCanWriteBlob` call.
   *
   * Intended for admin tooling and tests. Production code should
   * generally let the TTL expire naturally.
   */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Return the cached observation without triggering a fresh sample.
   *
   * Returns `observedBytes: null` when the gate has not yet sampled
   * the database. The returned object is a value snapshot; mutating
   * it has no effect on the gate.
   */
  peek(): StorageQuotaSnapshot {
    return {
      observedBytes: this.cached?.bytes ?? null,
      sampledAtMs: this.cached?.sampledAtMs ?? null,
      thresholdBytes: this.thresholdBytes,
      sampleTtlMs: this.sampleTtlMs,
    };
  }

  /**
   * Resolve the current storage observation, sampling lazily when the
   * cache is empty or older than `sampleTtlMs`. Concurrent callers in
   * the stale-cache window share a single in-flight sample.
   */
  private async observeBytes(): Promise<number> {
    const nowMs = this.now();
    const cached = this.cached;
    if (cached !== null && nowMs - cached.sampledAtMs < this.sampleTtlMs) {
      return cached.bytes;
    }

    if (this.inFlight !== null) {
      return this.inFlight;
    }

    const promise = (async (): Promise<number> => {
      const bytes = await this.sampler.sampleBytes();
      // Recompute "now" after the await so the cached timestamp
      // reflects when the value was actually observed, not when the
      // call started.
      this.cached = { bytes, sampledAtMs: this.now() };
      return bytes;
    })().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }
}
