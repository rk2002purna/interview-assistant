/**
 * Audit log writer.
 *
 * `writeAudit` appends a single row to `audit_log` using a transaction
 * supplied by the caller. The function does not open or commit a
 * transaction itself: callers compose it with the same transaction that
 * mutates the resource being audited so the audit row and the business
 * change either both commit or both roll back.
 *
 * Design references:
 *   - Requirement 14.4 (the events that MUST produce audit entries and
 *     the field set: actor, target, event_type, outcome, ts in UTC ms)
 *   - Requirement 14.5 (audit retention and append-only enforcement)
 *   - Migration 0006 (`audit_log` schema: id uuid, ts, actor_user_id,
 *     target_user_id, target_resource, event_type, outcome, reason_code,
 *     metadata jsonb)
 *
 * The TypeScript shape mirrors the column set exactly; the writer does
 * not invent fields or hide any column. Callers that audit anonymous
 * actors (webhook receivers, unauthenticated sign-in failures) pass
 * `actor: null` or `actor: { userId: null }`. Callers that audit a
 * resource without a target user (Pack edits, Welcome Offer toggles,
 * Provider Key rotations) pass `target: { resource: 'pack:pro' }` and
 * leave `userId` unset.
 */

import { randomUUID } from 'node:crypto';

/**
 * Outcome enum on `audit_log.outcome`. The database CHECK constraint
 * pins this to exactly these two values; we mirror it in the type so
 * callers cannot pass an out-of-band string.
 */
export type AuditOutcome = 'success' | 'failure';

/**
 * Acting principal. `userId` may be `null` or omitted to represent an
 * anonymous actor (Requirement 14.4: "actor user id (or `anonymous` for
 * unauthenticated sign-in failures and webhook events)").
 */
export interface AuditActor {
  readonly userId?: string | null;
}

/**
 * Target of the audited event. Either `userId` (audit applies to a
 * specific user account) or `resource` (audit applies to a Pack,
 * Provider Key, Welcome Offer, etc.) may be set; both may be set
 * simultaneously when relevant; both may be absent for events that
 * have no localized target (e.g. system-wide configuration change).
 */
export interface AuditTarget {
  readonly userId?: string | null;
  readonly resource?: string | null;
}

/**
 * Subset of `pg.PoolClient` that `writeAudit` uses. Typed as a
 * structural minimum so tests can pass a mock client and so the writer
 * works with any caller-managed transaction handle (a checked-out
 * `PoolClient` on which `BEGIN` has been issued, a Drizzle/Kysely tx
 * adapter exposing `.query`, etc.).
 */
export interface AuditTransactionClient {
  query(text: string, values?: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<unknown> }>;
}

/**
 * Input to `writeAudit`. The fields match the migration 0006 column
 * names with light renaming for ergonomics:
 *   - `actor.userId`     -> `actor_user_id`
 *   - `target.userId`    -> `target_user_id`
 *   - `target.resource`  -> `target_resource`
 *   - `eventType`        -> `event_type`
 *   - `outcome`          -> `outcome`
 *   - `reasonCode`       -> `reason_code`
 *   - `metadata`         -> `metadata` (JSON-serialized)
 *
 * `id` and `ts` are assigned by the database (gen via `randomUUID()`
 * here, default `clock_timestamp()` for `ts`); callers that need to
 * inspect them after commit should read them from the returned record.
 */
export interface WriteAuditInput {
  readonly actor?: AuditActor | null;
  readonly target?: AuditTarget | null;
  readonly eventType: string;
  readonly outcome: AuditOutcome;
  readonly reasonCode?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Result of a successful insert: the assigned id and the database-side
 * timestamp. Callers that emit metrics or correlated logs alongside the
 * audit write use these for cross-referencing.
 */
export interface WriteAuditResult {
  readonly id: string;
  readonly ts: Date;
}

const INSERT_AUDIT_SQL = `
  INSERT INTO audit_log (
    id,
    actor_user_id,
    target_user_id,
    target_resource,
    event_type,
    outcome,
    reason_code,
    metadata
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
  RETURNING id, ts
`;

function normalizeNullable(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : value;
}

function assertEventType(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new TypeError('audit.eventType must be a non-empty string of <= 200 chars');
  }
}

function assertOutcome(value: string): asserts value is AuditOutcome {
  if (value !== 'success' && value !== 'failure') {
    throw new TypeError(`audit.outcome must be 'success' or 'failure' (got ${String(value)})`);
  }
}

/**
 * Append exactly one row to `audit_log`.
 *
 * Runs in `tx`. The caller is responsible for `BEGIN`/`COMMIT`. On any
 * database error the function rejects without retry; the caller's
 * `catch` should `ROLLBACK` and surface the error to its own caller.
 *
 * Usage:
 *
 * ```ts
 * await pool.connect().then(async (client) => {
 *   try {
 *     await client.query('BEGIN');
 *     await applyRoleChange(client, ...);
 *     await writeAudit(client, {
 *       actor:    { userId: actingAdminId },
 *       target:   { userId: targetUserId },
 *       eventType: 'role_change',
 *       outcome:   'success',
 *       reasonCode: null,
 *       metadata:  { previous_role: 'user', new_role: 'admin' },
 *     });
 *     await client.query('COMMIT');
 *   } catch (err) {
 *     await client.query('ROLLBACK');
 *     throw err;
 *   } finally {
 *     client.release();
 *   }
 * });
 * ```
 */
export async function writeAudit(
  tx: AuditTransactionClient,
  input: WriteAuditInput,
): Promise<WriteAuditResult> {
  assertEventType(input.eventType);
  assertOutcome(input.outcome);

  const id = randomUUID();
  const actorUserId = normalizeNullable(input.actor?.userId ?? null);
  const targetUserId = normalizeNullable(input.target?.userId ?? null);
  const targetResource = normalizeNullable(input.target?.resource ?? null);
  const reasonCode = normalizeNullable(input.reasonCode ?? null);
  const metadataJson = JSON.stringify(input.metadata ?? {});

  const result = await tx.query(INSERT_AUDIT_SQL, [
    id,
    actorUserId,
    targetUserId,
    targetResource,
    input.eventType,
    input.outcome,
    reasonCode,
    metadataJson,
  ]);

  const row = result.rows[0] as { id: string; ts: Date | string } | undefined;
  if (!row) {
    // INSERT ... RETURNING always yields one row when the insert
    // succeeds; reaching this branch indicates the underlying client
    // lied about row count and is a programmer error worth surfacing.
    throw new Error('audit_log insert returned no row');
  }

  return {
    id: row.id,
    ts: row.ts instanceof Date ? row.ts : new Date(row.ts),
  };
}
