/**
 * In-memory Postgres test helper backed by `pg-mem`.
 *
 * Used for fast property tests where the SQL surface is supported and
 * real concurrency primitives are not required. Tests that exercise
 * `pg_advisory_xact_lock`, `FOR UPDATE`, partial unique indexes used as
 * concurrency gates, or `xmax = 0` semantics MUST use the testcontainers
 * helper instead.
 *
 * Design reference: design.md, Property-Based Testing Strategy
 * ("`vitest` with `pg-mem` for in-memory Postgres property tests where
 * the SQL surface is supported").
 *
 * Validates: Requirements 15.1.
 */
import { newDb, DataType, type IMemoryDb } from 'pg-mem';
import { Pool, type PoolClient } from 'pg';

/**
 * A pg-mem-backed Postgres-shaped context. The `pg.Pool` returned here
 * is the adapter that pg-mem exposes; it implements the same surface
 * used by the production code paths (`query`, `connect`).
 */
export interface PgMemContext {
  readonly db: IMemoryDb;
  readonly pool: Pool;
  withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Snapshot the in-memory DB. Returns a function that restores it. */
  snapshot(): () => void;
  stop(): Promise<void>;
}

export interface CreatePgMemOptions {
  /** Optional SQL executed once after the DB is created (e.g. migrations). */
  initSql?: string;
  /**
   * When true, install pg-mem's optional `uuid-ossp` extension. Off by
   * default because most tests should generate ids in JS for determinism.
   */
  enableUuidOssp?: boolean;
}

/**
 * Create an in-memory pg-mem database and return a Pool-shaped adapter.
 *
 * The returned pool can be passed anywhere the application accepts a
 * `pg.Pool`. Callers should `await ctx.stop()` to release the adapter
 * (the underlying memory DB is garbage-collected when the context is
 * dropped).
 */
export async function createPgMem(options: CreatePgMemOptions = {}): Promise<PgMemContext> {
  const db = newDb({ autoCreateForeignKeyIndices: true });

  if (options.enableUuidOssp) {
    db.public.registerFunction({
      name: 'uuid_generate_v4',
      returns: DataType.uuid,
      implementation: () => crypto.randomUUID(),
      impure: true,
    });
  }

  // Register gen_random_uuid() which is a Postgres 13+ built-in.
  // pg-mem does not support it natively, so we register it here.
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => crypto.randomUUID(),
    impure: true,
  });

  // pg-mem ships an adapter that mirrors `pg`'s Pool/Client surface.
  const adapters = db.adapters.createPg() as { Pool: typeof Pool };
  const pool = new adapters.Pool();

  if (options.initSql && options.initSql.trim().length > 0) {
    db.public.none(options.initSql);
  }

  const withClient = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  };

  const snapshot = (): (() => void) => {
    const restorePoint = db.backup();
    return () => restorePoint.restore();
  };

  const stop = async (): Promise<void> => {
    await pool.end();
  };

  return {
    db,
    pool,
    withClient,
    snapshot,
    stop,
  };
}
