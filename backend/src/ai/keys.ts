/**
 * Provider key resolver.
 *
 * `resolveProviderKey(pool, provider)` is the AI_Proxy's single entry
 * point for obtaining a plaintext upstream API key. It looks up the
 * encrypted envelope in `provider_keys`, decrypts it via the AES-256-GCM
 * module (using `provider:<name>` as the HKDF `info` so each provider's
 * subkey is bound to its own context), and returns the plaintext key as
 * a string.
 *
 * On any failure the function:
 *   1. Emits an audit row with event_type `provider_key_unavailable`,
 *      outcome `failure`, reason_code equal to the failure category
 *      ({@link ProviderKeyFailureCategory}), and metadata identifying
 *      the provider and category. Audit insertion runs in its own
 *      transaction so it commits independently of the caller's request
 *      handling.
 *   2. Throws {@link ProviderKeyUnavailableError}, a typed error the
 *      proxy maps to HTTP 503 `provider_key_unavailable`.
 *
 * The resolver itself never sets HTTP responses; mapping the typed
 * error to a 503 is the proxy task's job.
 *
 * The plaintext key never appears in:
 *   - log records (Requirement 4.7, 7.9): we only ever log the provider
 *     name and the failure category, never the ciphertext, the
 *     plaintext, or the envelope buffers.
 *   - the thrown error: {@link ProviderKeyUnavailableError} carries the
 *     provider name and the failure category and nothing else; even the
 *     `cause` field is a generic decryption error that contains no key
 *     material.
 *
 * Requirements: 4.5, 4.6, 4.7, 7.9.
 */

import type { Pool, PoolClient } from 'pg';

import { decrypt, type EncryptionEnvelope } from '../crypto/aes-gcm.js';
import { writeAudit } from '../log/audit.js';
import type { Logger } from '../log/logger.js';

// ---------------------------------------------------------------------------
// Provider name validation
// ---------------------------------------------------------------------------

/**
 * The set of upstream AI providers the system supports. Mirrors the
 * `provider_keys.provider` CHECK constraint in migration 0005 so the
 * resolver's accepted set and the database's accepted set never drift.
 */
export const PROVIDERS = ['gemini', 'groq', 'deepseek', 'cerebras', 'digitalocean'] as const;

export type ProviderName = (typeof PROVIDERS)[number];

/** Type guard for arbitrary strings against {@link PROVIDERS}. */
export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Reasons a provider key may be unavailable. Mirrors Requirement 4.5's
 * enumerated failure categories (`missing`, `revoked`, `decryption_failed`).
 *
 * The `revoked` category is reserved for a future task that introduces a
 * `revoked_at` column on `provider_keys`; the current resolver only
 * produces `missing` and `decryption_failed`. It remains in the union
 * so call sites can switch on the full enumerated set.
 */
export type ProviderKeyFailureCategory =
  | 'missing'
  | 'revoked'
  | 'decryption_failed';

/**
 * Typed error raised when a provider key cannot be resolved.
 *
 * The proxy catches this exact error class and maps it to:
 *
 *   HTTP 503 `provider_key_unavailable`
 *
 * The error never carries plaintext key material, only the provider name
 * and the failure category. The optional `cause` may carry the underlying
 * exception (e.g. the GCM auth-tag failure from `decrypt`); proxy code
 * that surfaces error details to clients MUST NOT serialize `cause`.
 */
export class ProviderKeyUnavailableError extends Error {
  /** Stable error code for proxy → client mapping. */
  readonly code = 'provider_key_unavailable' as const;

  /** Suggested HTTP status; the proxy is the source of truth for the wire. */
  readonly httpStatus = 503 as const;

  constructor(
    readonly provider: string,
    readonly category: ProviderKeyFailureCategory,
    override readonly cause?: unknown,
  ) {
    // The message is intentionally generic (no key material, no DB
    // identifiers). Logging code that emits the error message is safe
    // by construction.
    super(`provider key unavailable: ${provider} (${category})`);
    this.name = 'ProviderKeyUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ResolveProviderKeyOptions {
  /**
   * Optional logger for non-fatal diagnostic events (lookup error, decrypt
   * failure). The logger MUST be a structured logger that redacts known
   * secret keys; see `src/log/logger.ts`. The resolver never passes
   * plaintext key material into log fields.
   */
  readonly logger?: Logger;
}

interface ProviderKeyRow {
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  version: number;
}

const SELECT_KEY_SQL = `
  SELECT ciphertext, nonce, auth_tag, version
    FROM provider_keys
   WHERE provider = $1
`;

/**
 * Resolve the plaintext upstream API key for `provider`.
 *
 * @returns The plaintext key as a UTF-8 string.
 * @throws  {@link ProviderKeyUnavailableError} when the row is missing,
 *          when decryption fails, or when the provider name is outside
 *          the supported set. In every failure case an audit row has
 *          been written before the error is thrown.
 */
export async function resolveProviderKey(
  pool: Pool,
  provider: string,
  options: ResolveProviderKeyOptions = {},
): Promise<string> {
  // Reject unknown providers up front. We treat this as `missing` because
  // there is, by definition, no row for an unsupported provider; the
  // category is what the audit log and the proxy 503 will surface.
  if (!isProviderName(provider)) {
    await emitFailureAudit(pool, provider, 'missing', options.logger);
    throw new ProviderKeyUnavailableError(provider, 'missing');
  }

  let row: ProviderKeyRow | undefined;
  try {
    const result = await pool.query<ProviderKeyRow>(SELECT_KEY_SQL, [provider]);
    row = result.rows[0];
  } catch (err) {
    // Database errors during lookup are reported as `missing` because
    // the row could not be located; the underlying error message is
    // preserved in the audit metadata for operator triage but is never
    // propagated to clients.
    options.logger?.error('provider_key_lookup_failed', {
      provider,
      error_message: errorMessage(err),
    });
    await emitFailureAudit(pool, provider, 'missing', options.logger, {
      lookup_error: errorMessage(err),
    });
    throw new ProviderKeyUnavailableError(provider, 'missing', err);
  }

  if (row === undefined) {
    options.logger?.warn('provider_key_missing', { provider });
    await emitFailureAudit(pool, provider, 'missing', options.logger);
    throw new ProviderKeyUnavailableError(provider, 'missing');
  }

  let plaintext: Buffer;
  try {
    const envelope: EncryptionEnvelope = {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
    };
    plaintext = decrypt(envelope, `provider:${provider}`);
  } catch (err) {
    // GCM authentication failure, master-key mismatch, or a malformed
    // envelope all land here. The plaintext is not produced and the
    // ciphertext is never logged.
    options.logger?.error('provider_key_decrypt_failed', {
      provider,
      version: row.version,
      error_message: errorMessage(err),
    });
    await emitFailureAudit(pool, provider, 'decryption_failed', options.logger, {
      version: row.version,
    });
    throw new ProviderKeyUnavailableError(provider, 'decryption_failed', err);
  }

  // The returned string is the only place plaintext exists outside the
  // decryption call; callers MUST treat it as a secret (no logs, no
  // response bodies, no error fields). The `Logger` redaction set
  // already protects the conventional field names a caller might use.
  return plaintext.toString('utf8');
}

/**
 * Append a `provider_key_unavailable` audit row.
 *
 * Runs in its own short transaction so the audit is durable even when
 * the request handler has not opened (or has aborted) a transaction.
 * Audit-write failures are deliberately swallowed: the original
 * resolution failure is what the proxy needs to surface, and crashing
 * here would mask it. The logger receives a warning so audit-write
 * regressions remain observable.
 */
async function emitFailureAudit(
  pool: Pool,
  provider: string,
  category: ProviderKeyFailureCategory,
  logger?: Logger,
  extraMetadata: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await writeAudit(client, {
      actor: null,
      target: { resource: `provider:${provider}` },
      eventType: 'provider_key_unavailable',
      outcome: 'failure',
      reasonCode: category,
      metadata: { provider, category, ...extraMetadata },
    });
    await client.query('COMMIT');
  } catch (auditErr) {
    if (client !== undefined) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore: connection may already be in an aborted state.
      }
    }
    logger?.warn('provider_key_audit_write_failed', {
      provider,
      category,
      error_message: errorMessage(auditErr),
    });
  } finally {
    if (client !== undefined) {
      client.release();
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
