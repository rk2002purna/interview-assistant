/**
 * Entitlement_Ledger writer.
 *
 * `appendLedgerEntry` is the single, transactional path through which
 * every change to a user's Entitlement is recorded. The ledger is
 * append-only (Requirements 6.1, 6.6), the per-user state is computed
 * from prior rows (Requirement 6.2), and concurrent writes for the
 * same user are serialized through `pg_advisory_xact_lock(user_id)`
 * (design.md "Architectural Decisions" / Property 2) so that no
 * committed sequence of inserts can observe a negative session_count
 * (Requirement 6.3).
 *
 * Lifetime users (Requirement 6.7) have `resulting_lifetime_flag = true`
 * once any prior row set the flag; for those users `session_start`
 * entries pass `sessionDelta = 0` and the function records the entry
 * without touching the running count.
 *
 * The function is given a transaction client by the caller (typically a
 * checked-out `pg.PoolClient` on which `BEGIN` has been issued). It
 * does not open or commit a transaction itself: the caller composes
 * this insert with whatever else must be atomic with it (e.g. the
 * `interview_sessions` insert in `POST /sessions/start`, the
 * `purchases` update in the Razorpay webhook handler, or the
 * `audit_log` insert in admin adjustments).
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.7.
 */

import { randomUUID } from 'node:crypto';

/** Reason codes accepted by the ledger schema. */
export type LedgerReason =
  | 'pack_purchase'
  | 'lifetime_grant'
  | 'session_start'
  | 'session_refund'
  | 'admin_adjustment'
  | 'signup_bonus';

/** `lifetime_flag_set` enum from the schema. */
export type LifetimeFlagSet = 'unchanged' | 'set_true';

/**
 * Subset of `pg.PoolClient` that this module uses. Typed as a
 * structural minimum so tests can pass a mock client and so the writer
 * works with any caller-managed transaction handle.
 */
export interface LedgerTransactionClient {
  query(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: ReadonlyArray<unknown> }>;
}

/**
 * Input to `appendLedgerEntry`. Field names mirror the migration 0004
 * column names with light renaming for ergonomics.
 */
export interface AppendLedgerEntryInput {
  /** Owner of the entitlement; the advisory lock is keyed on this id. */
  readonly userId: string;
  /**
   * Integer delta applied to the running session count. Must be in
   * `[-1_000_000, 1_000_000]`. May be zero only when `reason ===
   * 'session_start'` (lifetime-user session start, Requirement 6.7).
   */
  readonly sessionDelta: number;
  /**
   * Whether this row sets the lifetime flag to true. Once set by any
   * prior row, the flag is sticky (Requirement 6.2).
   */
  readonly lifetimeFlagSet: LifetimeFlagSet;
  /** Reason code drawn from the schema enum (Requirement 6.1). */
  readonly reason: LedgerReason;
  /** Optional Razorpay payment id linking the entry to a captured payment. */
  readonly razorpayPaymentId?: string | null;
  /** Optional Interview_Session id (set on `session_start` and `session_refund`). */
  readonly interviewSessionId?: string | null;
  /** Optional acting admin id (set on `admin_adjustment` and lifetime grants). */
  readonly actingAdminId?: string | null;
  /** Optional free-text note, max 500 chars (CHECK constraint in schema). */
  readonly note?: string | null;
}

/** Result of a successful ledger insert. */
export interface AppendLedgerEntryResult {
  readonly id: string;
  readonly ts: Date;
  readonly resultingSessionCount: number;
  readonly resultingLifetimeFlag: boolean;
}

/**
 * Stable error codes raised by `appendLedgerEntry`. The HTTP layer maps
 * these onto status codes per the design's error catalogue:
 *   - `no_sessions_remaining`     -> HTTP 402 (Requirement 6.3, 8.2)
 *   - `invalid_session_delta`     -> HTTP 400 (caller bug; never reached
 *                                    in well-formed call paths)
 *   - `invalid_reason`            -> HTTP 400 (caller bug)
 *   - `invalid_lifetime_flag_set` -> HTTP 400 (caller bug)
 */
export type LedgerErrorCode =
  | 'no_sessions_remaining'
  | 'invalid_session_delta'
  | 'invalid_reason'
  | 'invalid_lifetime_flag_set';

/** Error raised when the requested ledger insert cannot proceed. */
export class LedgerError extends Error {
  public readonly code: LedgerErrorCode;
  /**
   * For `no_sessions_remaining`, the user's current session_count and
   * lifetime flag at the time of the rejection. Useful for surfacing
   * helpful diagnostics in the HTTP response without re-querying.
   */
  public readonly currentSessionCount: number | null;
  public readonly currentLifetimeFlag: boolean | null;

  constructor(
    code: LedgerErrorCode,
    message: string,
    state: {
      currentSessionCount?: number;
      currentLifetimeFlag?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.currentSessionCount = state.currentSessionCount ?? null;
    this.currentLifetimeFlag = state.currentLifetimeFlag ?? null;
  }
}

const VALID_REASONS: ReadonlySet<LedgerReason> = new Set<LedgerReason>([
  'pack_purchase',
  'lifetime_grant',
  'session_start',
  'session_refund',
  'admin_adjustment',
  'signup_bonus',
]);

const SESSION_DELTA_MIN = -1_000_000;
const SESSION_DELTA_MAX = 1_000_000;

/**
 * SQL that acquires a per-user advisory lock for the duration of the
 * caller's transaction. The lock key is derived from the UUID via
 * `hashtextextended(text, 0)` which returns a stable bigint, satisfying
 * the single-arg signature of `pg_advisory_xact_lock(bigint)`.
 *
 * This serializes concurrent inserts for the same user without blocking
 * inserts for different users. The lock is released automatically when
 * the transaction commits or rolls back.
 */
const ADVISORY_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(('x' || left(md5($1::text), 15))::bit(64)::bigint)";

/**
 * SQL that reads the most recent ledger row for a user. The
 * `resulting_*` columns on that row are the canonical "current state"
 * after applying every prior committed entry (the periodic invariant
 * audit verifies they agree with the SUM/lifetime derivation in
 * Requirement 6.2). Reading only the last row keeps this O(1) per
 * insert regardless of ledger length.
 */
const LATEST_LEDGER_ROW_SQL = `
  SELECT resulting_session_count, resulting_lifetime_flag
    FROM entitlement_ledger
   WHERE user_id = $1
   ORDER BY ts DESC, id DESC
   LIMIT 1
`;

const INSERT_LEDGER_SQL = `
  INSERT INTO entitlement_ledger (
    id,
    user_id,
    session_delta,
    lifetime_flag_set,
    reason,
    razorpay_payment_id,
    interview_session_id,
    acting_admin_id,
    resulting_session_count,
    resulting_lifetime_flag,
    note
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  RETURNING id, ts
`;

interface LatestLedgerRow {
  resulting_session_count: number | string;
  resulting_lifetime_flag: boolean;
}

interface InsertedLedgerRow {
  id: string;
  ts: Date | string;
}

function validateInput(input: AppendLedgerEntryInput): void {
  if (!Number.isInteger(input.sessionDelta)) {
    throw new LedgerError(
      'invalid_session_delta',
      `session_delta must be an integer (got ${String(input.sessionDelta)})`,
    );
  }
  if (
    input.sessionDelta < SESSION_DELTA_MIN ||
    input.sessionDelta > SESSION_DELTA_MAX
  ) {
    throw new LedgerError(
      'invalid_session_delta',
      `session_delta ${input.sessionDelta} is outside [${SESSION_DELTA_MIN}, ${SESSION_DELTA_MAX}]`,
    );
  }
  if (input.sessionDelta === 0 && input.reason !== 'session_start') {
    // Mirrors the schema CHECK: a zero delta is permitted exclusively
    // for `session_start` entries (lifetime-user session start).
    throw new LedgerError(
      'invalid_session_delta',
      `session_delta = 0 is only permitted when reason = 'session_start' (got reason='${input.reason}')`,
    );
  }
  if (!VALID_REASONS.has(input.reason)) {
    throw new LedgerError(
      'invalid_reason',
      `reason must be one of ${Array.from(VALID_REASONS).join(',')} (got '${String(input.reason)}')`,
    );
  }
  if (
    input.lifetimeFlagSet !== 'unchanged' &&
    input.lifetimeFlagSet !== 'set_true'
  ) {
    throw new LedgerError(
      'invalid_lifetime_flag_set',
      `lifetime_flag_set must be 'unchanged' or 'set_true' (got '${String(input.lifetimeFlagSet)}')`,
    );
  }
  if (input.note !== undefined && input.note !== null && input.note.length > 500) {
    throw new LedgerError(
      'invalid_reason',
      `note exceeds 500 characters (got ${input.note.length})`,
    );
  }
}

function nullable<T>(value: T | null | undefined): T | null {
  return value === undefined || value === null ? null : value;
}

/**
 * Append exactly one row to `entitlement_ledger`, computing the
 * `resulting_session_count` and `resulting_lifetime_flag` from prior
 * rows for the same user.
 *
 * The function performs three SQL operations inside the caller's
 * transaction, in this order:
 *
 *   1. `pg_advisory_xact_lock(hashtextextended(user_id::text, 0))`
 *      Serializes concurrent inserts for the same user. Released
 *      automatically on commit/rollback.
 *
 *   2. Read the most recent ledger row to obtain the prior
 *      `resulting_session_count` and `resulting_lifetime_flag`. If no
 *      prior row exists the user starts from `(0, false)`.
 *
 *   3. Apply the delta and the lifetime flag. If the resulting count
 *      would be negative AND the user is not (and is not becoming) a
 *      lifetime user, throw `LedgerError('no_sessions_remaining')`
 *      without inserting any row (Requirement 6.3). Otherwise, insert
 *      the new row with the computed `resulting_*` columns.
 *
 * Lifetime users (Requirement 6.7): when `lifetime_flag_set = 'set_true'`
 * on this row OR `resulting_lifetime_flag = true` on the latest prior
 * row, a negative `priorCount + sessionDelta` is clamped to `0` and the
 * row is inserted. In practice `session_start` entries for lifetime
 * users carry `sessionDelta = 0`, so this clamp is only a safety net.
 *
 * The function does not write to `audit_log`; admin adjustments and
 * lifetime grants compose `appendLedgerEntry` with `writeAudit` in the
 * same transaction at the call site.
 *
 * @param tx     Transaction client; the caller owns BEGIN/COMMIT.
 * @param input  Ledger entry parameters.
 * @returns      The new row's id, ts, and computed resulting state.
 * @throws       `LedgerError` on validation failure or insufficient balance.
 */
export async function appendLedgerEntry(
  tx: LedgerTransactionClient,
  input: AppendLedgerEntryInput,
): Promise<AppendLedgerEntryResult> {
  validateInput(input);

  // 1. Acquire per-user advisory lock for the duration of the caller's
  //    transaction. This prevents two concurrent inserts for the same
  //    user from each reading the same prior balance and both
  //    succeeding when only one should (Property 2).
  await tx.query(ADVISORY_LOCK_SQL, [input.userId]);

  // 2. Read the latest prior row; default to (0, false) for new users.
  const latestResult = await tx.query(LATEST_LEDGER_ROW_SQL, [input.userId]);
  const latest = latestResult.rows[0] as LatestLedgerRow | undefined;
  const priorCount = latest ? Number(latest.resulting_session_count) : 0;
  const priorLifetime = latest ? latest.resulting_lifetime_flag === true : false;

  // 3. Compute the new state.
  const willBeLifetime = priorLifetime || input.lifetimeFlagSet === 'set_true';
  const projected = priorCount + input.sessionDelta;

  let resultingSessionCount: number;
  if (projected < 0) {
    if (!willBeLifetime) {
      // Requirement 6.3: reject; do not insert.
      throw new LedgerError(
        'no_sessions_remaining',
        `entitlement insert rejected: projected session_count = ${projected}, lifetime_flag = false`,
        {
          currentSessionCount: priorCount,
          currentLifetimeFlag: priorLifetime,
        },
      );
    }
    // Lifetime users: clamp to 0 (Requirement 6.2 / Property 1
    // canonical balance is `max(0, SUM(session_delta))`). In practice
    // call paths for lifetime users do not produce a negative
    // projection, but this clamp keeps the insert safe regardless.
    resultingSessionCount = 0;
  } else {
    resultingSessionCount = projected;
  }

  const id = randomUUID();
  const inserted = await tx.query(INSERT_LEDGER_SQL, [
    id,
    input.userId,
    input.sessionDelta,
    input.lifetimeFlagSet,
    input.reason,
    nullable(input.razorpayPaymentId),
    nullable(input.interviewSessionId),
    nullable(input.actingAdminId),
    resultingSessionCount,
    willBeLifetime,
    nullable(input.note),
  ]);

  const row = inserted.rows[0] as InsertedLedgerRow | undefined;
  if (!row) {
    // INSERT ... RETURNING always yields one row when the insert
    // succeeds; reaching this branch indicates the underlying client
    // lied about row count and is a programmer error worth surfacing.
    throw new Error('entitlement_ledger insert returned no row');
  }

  return {
    id: row.id,
    ts: row.ts instanceof Date ? row.ts : new Date(row.ts),
    resultingSessionCount,
    resultingLifetimeFlag: willBeLifetime,
  };
}
