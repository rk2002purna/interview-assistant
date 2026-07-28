/**
 * Wallet_Ledger writer.
 *
 * `appendWalletEntry` is the single, transactional path through which every
 * change to a user's wallet balance is recorded. The ledger is append-only
 * (migration 0012), the per-user balance is the latest row's
 * `resulting_balance_paise`, and concurrent writes for the same user are
 * serialized with `pg_advisory_xact_lock(user_id)` so no committed sequence of
 * inserts can observe a negative balance.
 *
 * All amounts are INR paise. A positive `amountPaise` credits the wallet
 * (signup bonus, top-up, refund, admin credit); a negative `amountPaise` debits
 * it (per-minute session charge, admin debit).
 *
 * The function is given a transaction client by the caller (a checked-out
 * `pg.PoolClient` on which `BEGIN` has been issued). It does not open or commit
 * a transaction itself, so the caller can compose the wallet write with other
 * work that must be atomic with it (the `interview_sessions` insert on session
 * start, the `wallet_topups` update in the Razorpay webhook, or the `audit_log`
 * insert in admin adjustments).
 */

import { randomUUID } from 'node:crypto';

/** Reason codes accepted by the wallet_ledger schema. */
export type WalletReason =
  | 'signup_bonus'
  | 'topup'
  | 'session_charge'
  | 'admin_credit'
  | 'admin_debit'
  | 'refund';

/**
 * Subset of `pg.PoolClient` used by this module. Typed as a structural minimum
 * so tests can pass a mock client and so the writer works with any
 * caller-managed transaction handle.
 */
export interface WalletTransactionClient {
  query(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: ReadonlyArray<unknown> }>;
}

/** Input to `appendWalletEntry`. */
export interface AppendWalletEntryInput {
  /** Owner of the wallet; the advisory lock is keyed on this id. */
  readonly userId: string;
  /**
   * Signed delta in paise. Positive credits, negative debits. Must be a
   * non-zero integer in `[-100_000_000, 100_000_000]`.
   */
  readonly amountPaise: number;
  /** Reason code drawn from the schema enum. */
  readonly reason: WalletReason;
  /** Optional Razorpay payment id linking a credit to a captured payment. */
  readonly razorpayPaymentId?: string | null;
  /** Optional Interview_Session id (set on `session_charge`). */
  readonly interviewSessionId?: string | null;
  /** Optional acting admin id (set on `admin_credit` / `admin_debit`). */
  readonly actingAdminId?: string | null;
  /** Optional free-text note, max 500 chars (CHECK constraint in schema). */
  readonly note?: string | null;
}

/** Result of a successful wallet insert. */
export interface AppendWalletEntryResult {
  readonly id: string;
  readonly ts: Date;
  readonly resultingBalancePaise: number;
}

/**
 * Stable error codes raised by `appendWalletEntry`. The HTTP layer maps these:
 *   - `insufficient_balance` -> HTTP 402 (debit would make the balance negative)
 *   - `invalid_amount`       -> HTTP 400 (caller bug)
 *   - `invalid_reason`       -> HTTP 400 (caller bug)
 */
export type WalletErrorCode =
  | 'insufficient_balance'
  | 'invalid_amount'
  | 'invalid_reason';

/** Error raised when the requested wallet insert cannot proceed. */
export class WalletError extends Error {
  public readonly code: WalletErrorCode;
  /** The user's balance at the time of an `insufficient_balance` rejection. */
  public readonly currentBalancePaise: number | null;

  constructor(
    code: WalletErrorCode,
    message: string,
    state: { currentBalancePaise?: number } = {},
  ) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    this.currentBalancePaise = state.currentBalancePaise ?? null;
  }
}

const VALID_REASONS: ReadonlySet<WalletReason> = new Set<WalletReason>([
  'signup_bonus',
  'topup',
  'session_charge',
  'admin_credit',
  'admin_debit',
  'refund',
]);

const AMOUNT_MIN = -100_000_000;
const AMOUNT_MAX = 100_000_000;

/**
 * Acquires a per-user advisory lock for the duration of the caller's
 * transaction. Same hashing approach as the entitlement ledger so wallet and
 * entitlement writes for one user serialize on the same key.
 */
const ADVISORY_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(('x' || left(md5($1::text), 15))::bit(64)::bigint)";

/** Reads the most recent wallet row for a user (O(1) via the user_ts index). */
const LATEST_WALLET_ROW_SQL = `
  SELECT resulting_balance_paise
    FROM wallet_ledger
   WHERE user_id = $1
   ORDER BY ts DESC, id DESC
   LIMIT 1
`;

const INSERT_WALLET_SQL = `
  INSERT INTO wallet_ledger (
    id,
    user_id,
    amount_paise,
    reason,
    razorpay_payment_id,
    interview_session_id,
    acting_admin_id,
    resulting_balance_paise,
    note
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  RETURNING id, ts
`;

interface LatestWalletRow {
  resulting_balance_paise: number | string;
}

interface InsertedWalletRow {
  id: string;
  ts: Date | string;
}

function validateInput(input: AppendWalletEntryInput): void {
  if (!Number.isInteger(input.amountPaise)) {
    throw new WalletError(
      'invalid_amount',
      `amount_paise must be an integer (got ${String(input.amountPaise)})`,
    );
  }
  if (input.amountPaise === 0) {
    throw new WalletError('invalid_amount', 'amount_paise must be non-zero');
  }
  if (input.amountPaise < AMOUNT_MIN || input.amountPaise > AMOUNT_MAX) {
    throw new WalletError(
      'invalid_amount',
      `amount_paise ${input.amountPaise} is outside [${AMOUNT_MIN}, ${AMOUNT_MAX}]`,
    );
  }
  if (!VALID_REASONS.has(input.reason)) {
    throw new WalletError(
      'invalid_reason',
      `reason must be one of ${Array.from(VALID_REASONS).join(',')} (got '${String(input.reason)}')`,
    );
  }
  if (input.note !== undefined && input.note !== null && input.note.length > 500) {
    throw new WalletError(
      'invalid_amount',
      `note exceeds 500 characters (got ${input.note.length})`,
    );
  }
}

function nullable<T>(value: T | null | undefined): T | null {
  return value === undefined || value === null ? null : value;
}

/**
 * Read a user's current wallet balance in paise inside the caller's
 * transaction/connection. Returns 0 when the user has no wallet rows yet.
 */
export async function getWalletBalancePaise(
  tx: WalletTransactionClient,
  userId: string,
): Promise<number> {
  const result = await tx.query(LATEST_WALLET_ROW_SQL, [userId]);
  const row = result.rows[0] as LatestWalletRow | undefined;
  return row ? Number(row.resulting_balance_paise) : 0;
}

/**
 * Append exactly one row to `wallet_ledger`, computing
 * `resulting_balance_paise` from the prior latest row for the same user.
 *
 * Steps inside the caller's transaction:
 *   1. Acquire the per-user advisory lock (released on commit/rollback).
 *   2. Read the latest row's balance (default 0 for new users).
 *   3. Apply the delta. If the balance would go negative, throw
 *      `WalletError('insufficient_balance')` without inserting. Otherwise
 *      insert the new row with the computed `resulting_balance_paise`.
 *
 * @param tx     Transaction client; the caller owns BEGIN/COMMIT.
 * @param input  Wallet entry parameters.
 * @returns      The new row's id, ts, and resulting balance.
 * @throws       `WalletError` on validation failure or insufficient balance.
 */
export async function appendWalletEntry(
  tx: WalletTransactionClient,
  input: AppendWalletEntryInput,
): Promise<AppendWalletEntryResult> {
  validateInput(input);

  await tx.query(ADVISORY_LOCK_SQL, [input.userId]);

  const priorBalance = await getWalletBalancePaise(tx, input.userId);
  const projected = priorBalance + input.amountPaise;

  if (projected < 0) {
    throw new WalletError(
      'insufficient_balance',
      `wallet debit rejected: projected balance = ${projected} paise`,
      { currentBalancePaise: priorBalance },
    );
  }

  const id = randomUUID();
  const inserted = await tx.query(INSERT_WALLET_SQL, [
    id,
    input.userId,
    input.amountPaise,
    input.reason,
    nullable(input.razorpayPaymentId),
    nullable(input.interviewSessionId),
    nullable(input.actingAdminId),
    projected,
    nullable(input.note),
  ]);

  const row = inserted.rows[0] as InsertedWalletRow | undefined;
  if (!row) {
    throw new Error('wallet_ledger insert returned no row');
  }

  return {
    id: row.id,
    ts: row.ts instanceof Date ? row.ts : new Date(row.ts),
    resultingBalancePaise: projected,
  };
}

/**
 * Shared billing constants for the per-minute wallet model.
 */
/** Flat per-minute rate for interview time, in paise (Rs 5/min). */
export const RATE_PER_MINUTE_PAISE = 500;
/** One-time signup bonus credited to a new user's wallet, in paise (Rs 50). */
export const SIGNUP_BONUS_PAISE = 5000;
/**
 * Safety cap on a single session's length in minutes, independent of balance.
 * Prevents a runaway session from billing indefinitely if a client never ends
 * it. 10 hours is far beyond any real interview.
 */
export const MAX_SESSION_MINUTES = 600;
