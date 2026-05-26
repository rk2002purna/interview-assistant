/**
 * Real Postgres test helper backed by `testcontainers`.
 *
 * Used for tests that exercise SQL features `pg-mem` cannot adequately
 * model: real concurrency (`pg_advisory_xact_lock`, `FOR UPDATE`, MVCC
 * isolation levels), CHECK / partial-unique-index constraints, triggers,
 * and `INSERT ... ON CONFLICT DO NOTHING RETURNING xmax = 0`.
 *
 * Design reference: design.md, Property-Based Testing Strategy
 * ("`testcontainers` Postgres for tests requiring real concurrency
 * (advisory locks, `FOR UPDATE`)").
 *
 * Validates: Requirements 15.1.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';

/**
 * A live Postgres container reserved for a single test or test file.
 *
 * Callers `await ctx.stop()` to tear down both the connection pool and
 * the container. The pool exposes a `pg.Pool` for direct queries and
 * a `withClient()` helper that scopes a checkout to a callback.
 */
export interface PostgresTestContext {
  readonly container: StartedPostgreSqlContainer;
  readonly pool: Pool;
  readonly connectionString: string;
  withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

/**
 * Options for `startPostgresTestContainer`.
 *
 * `image` defaults to a pinned 16-alpine tag so test runs are reproducible
 * across CI workers. `poolSize` defaults to 10 which is sufficient for the
 * concurrent-session-start property tests (Property 2/3 in the design).
 */
export interface StartPostgresOptions {
  /** Postgres image tag. Pinned for reproducibility. */
  image?: string;
  /** Maximum concurrent connections in the test pool. */
  poolSize?: number;
  /** Optional SQL executed once after the container is ready (e.g. migrations). */
  initSql?: string;
}

const DEFAULT_IMAGE = 'postgres:16-alpine';
const DEFAULT_POOL_SIZE = 10;

/**
 * Start a Postgres container, open a connection pool, and optionally run
 * `initSql` (typically a migration script) before returning.
 *
 * The container and pool live for the lifetime of the returned context.
 * Tests should `await ctx.stop()` in an `afterAll` / `afterEach` hook.
 */
export async function startPostgresTestContainer(
  options: StartPostgresOptions = {},
): Promise<PostgresTestContext> {
  const image = options.image ?? DEFAULT_IMAGE;
  const poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;

  const container = await new PostgreSqlContainer(image).start();
  const connectionString = container.getConnectionUri();

  const pool = new Pool({
    connectionString,
    max: poolSize,
  });

  if (options.initSql && options.initSql.trim().length > 0) {
    const client = await pool.connect();
    try {
      await client.query(options.initSql);
    } finally {
      client.release();
    }
  }

  const withClient = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  };

  const stop = async (): Promise<void> => {
    await pool.end();
    await container.stop();
  };

  return {
    container,
    pool,
    connectionString,
    withClient,
    stop,
  };
}
