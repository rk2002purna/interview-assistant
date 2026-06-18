/**
 * Unit tests for the provider key resolver (`src/ai/keys.ts`).
 *
 * The tests cover:
 *   - Successful round-trip: encrypt a known plaintext with the same
 *     `provider:<name>` info string, persist the envelope, then assert
 *     the resolver returns the original plaintext.
 *   - Missing row → `ProviderKeyUnavailableError` with category
 *     `missing` and an audit row written with reason `missing`.
 *   - Decrypt failure → category `decryption_failed` with an audit row
 *     written with reason `decryption_failed`.
 *   - Unknown provider name → category `missing` (rejected up front).
 *   - Logger never receives plaintext key material (Property 10).
 *   - Plaintext key never appears in the thrown error or audit row.
 *
 * The tests use a small in-process pg-shaped fake that preserves
 * `Buffer` round-trips exactly. pg-mem is unsuitable here because it
 * encodes `bytea` values through UTF-8 and silently corrupts any byte
 * outside the ASCII range, which breaks the AES-256-GCM auth tag and
 * any high-entropy ciphertext or nonce. Real Postgres preserves bytes
 * verbatim, and a CI-time integration test exercises the resolver
 * against a real instance via the testcontainers helper.
 *
 * Validates: Requirements 4.5, 4.6, 4.7, 7.9.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import {
  encrypt,
  resetMasterKeyForTesting,
} from '../../../src/crypto/aes-gcm.js';
import {
  ProviderKeyUnavailableError,
  resolveProviderKey,
} from '../../../src/ai/keys.js';
import {
  Logger,
  createMemorySink,
  type LogRecord,
} from '../../../src/log/logger.js';

// ---------------------------------------------------------------------------
// In-process pg-shaped fake
// ---------------------------------------------------------------------------

interface ProviderKeyRow {
  provider: string;
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  last4: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface AuditRow {
  id: string;
  ts: Date;
  actor_user_id: string | null;
  target_user_id: string | null;
  target_resource: string | null;
  event_type: string;
  outcome: string;
  reason_code: string | null;
  metadata: Record<string, unknown>;
}

interface FakeDb {
  providerKeys: Map<string, ProviderKeyRow>;
  auditLog: AuditRow[];
}

interface FakePoolHandle {
  pool: Pool;
  db: FakeDb;
}

function createFakePool(): FakePoolHandle {
  const db: FakeDb = {
    providerKeys: new Map(),
    auditLog: [],
  };

  const exec = async (
    text: string,
    values: ReadonlyArray<unknown> = [],
  ): Promise<{ rows: unknown[] }> => {
    const sql = text.trim();
    const upper = sql.toUpperCase();

    if (upper.startsWith('BEGIN') || upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
      return { rows: [] };
    }

    if (upper.startsWith('SELECT CIPHERTEXT')) {
      const provider = values[0] as string;
      const row = db.providerKeys.get(provider);
      return { rows: row === undefined ? [] : [row] };
    }

    if (upper.startsWith('INSERT INTO AUDIT_LOG')) {
      const [
        id,
        actorUserId,
        targetUserId,
        targetResource,
        eventType,
        outcome,
        reasonCode,
        metadataJson,
      ] = values as [
        string,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string | null,
        string,
      ];
      const row: AuditRow = {
        id,
        ts: new Date(),
        actor_user_id: actorUserId,
        target_user_id: targetUserId,
        target_resource: targetResource,
        event_type: eventType,
        outcome,
        reason_code: reasonCode,
        metadata: JSON.parse(metadataJson) as Record<string, unknown>,
      };
      db.auditLog.push(row);
      return { rows: [{ id: row.id, ts: row.ts }] };
    }

    throw new Error(`fake-pool: unsupported SQL: ${sql}`);
  };

  const fakeClient: PoolClient = {
    query: ((text: string, values?: ReadonlyArray<unknown>) =>
      exec(text, values ?? [])) as PoolClient['query'],
    release: () => {},
  } as unknown as PoolClient;

  const pool = {
    query: ((text: string, values?: ReadonlyArray<unknown>) =>
      exec(text, values ?? [])) as Pool['query'],
    connect: (async () => fakeClient) as Pool['connect'],
  } as unknown as Pool;

  return { pool, db };
}

const ORIGINAL_KEY = process.env['MASTER_ENCRYPTION_KEY'];

function insertEncryptedKey(
  db: FakeDb,
  provider: string,
  plaintext: string,
  version = 1,
): void {
  const env = encrypt(plaintext, `provider:${provider}`);
  db.providerKeys.set(provider, {
    provider,
    ciphertext: env.ciphertext,
    nonce: env.nonce,
    auth_tag: env.authTag,
    last4: plaintext.slice(-4).padStart(4, 'x'),
    version,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

function insertCorruptKey(db: FakeDb, provider: string, version = 7): void {
  const env = encrypt('original-secret', `provider:${provider}`);
  // Tamper the auth tag so GCM verification fails.
  const tag = Buffer.from(env.authTag);
  tag[0] = (tag[0] ?? 0) ^ 0x01;
  db.providerKeys.set(provider, {
    provider,
    ciphertext: env.ciphertext,
    nonce: env.nonce,
    auth_tag: tag,
    last4: 'cret',
    version,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

describe('ai/keys: resolveProviderKey', () => {
  let handle: FakePoolHandle;

  beforeAll(() => {
    process.env['MASTER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
    resetMasterKeyForTesting();
  });

  beforeEach(() => {
    handle = createFakePool();
  });

  afterEach(() => {
    if (ORIGINAL_KEY !== undefined) {
      process.env['MASTER_ENCRYPTION_KEY'] = ORIGINAL_KEY;
      resetMasterKeyForTesting();
    }
  });

  it('returns the plaintext key when the row exists and decrypts cleanly', async () => {
    const secret = 'sk-live-' + randomBytes(20).toString('hex');
    insertEncryptedKey(handle.db, 'gemini', secret);

    const resolved = await resolveProviderKey(handle.pool, 'gemini');

    expect(resolved).toBe(secret);
    // No audit row on success.
    expect(handle.db.auditLog).toHaveLength(0);
  });

  it('uses the provider-bound info so each provider has its own subkey', async () => {
    // Same plaintext, different providers; both must round-trip.
    const secret = 'shared-plaintext';
    insertEncryptedKey(handle.db, 'gemini', secret);
    insertEncryptedKey(handle.db, 'groq', secret);

    expect(await resolveProviderKey(handle.pool, 'gemini')).toBe(secret);
    expect(await resolveProviderKey(handle.pool, 'groq')).toBe(secret);
  });

  it('throws ProviderKeyUnavailableError(missing) when no row exists', async () => {
    await expect(resolveProviderKey(handle.pool, 'gemini')).rejects.toBeInstanceOf(
      ProviderKeyUnavailableError,
    );

    try {
      await resolveProviderKey(handle.pool, 'gemini');
    } catch (err) {
      const e = err as ProviderKeyUnavailableError;
      expect(e.code).toBe('provider_key_unavailable');
      expect(e.httpStatus).toBe(503);
      expect(e.provider).toBe('gemini');
      expect(e.category).toBe('missing');
    }

    // Two attempts above → two audit rows.
    expect(handle.db.auditLog).toHaveLength(2);
    expect(handle.db.auditLog[0]).toMatchObject({
      event_type: 'provider_key_unavailable',
      outcome: 'failure',
      reason_code: 'missing',
      target_resource: 'provider:gemini',
    });
    expect(handle.db.auditLog[0]!.metadata).toMatchObject({
      provider: 'gemini',
      category: 'missing',
    });
  });

  it('throws ProviderKeyUnavailableError(decryption_failed) on tampered envelope', async () => {
    insertCorruptKey(handle.db, 'deepseek', 7);

    await expect(resolveProviderKey(handle.pool, 'deepseek')).rejects.toMatchObject({
      code: 'provider_key_unavailable',
      category: 'decryption_failed',
      provider: 'deepseek',
    });

    expect(handle.db.auditLog).toHaveLength(1);
    expect(handle.db.auditLog[0]).toMatchObject({
      event_type: 'provider_key_unavailable',
      outcome: 'failure',
      reason_code: 'decryption_failed',
      target_resource: 'provider:deepseek',
    });
    expect(handle.db.auditLog[0]!.metadata).toMatchObject({
      provider: 'deepseek',
      category: 'decryption_failed',
      version: 7,
    });
  });

  it('rejects unknown provider names with category=missing', async () => {
    await expect(
      resolveProviderKey(handle.pool, 'openai' as never),
    ).rejects.toMatchObject({
      category: 'missing',
      provider: 'openai',
    });

    expect(handle.db.auditLog).toHaveLength(1);
    expect(handle.db.auditLog[0]!.target_resource).toBe('provider:openai');
  });

  it('never logs the plaintext key', async () => {
    const secret = 'sk-live-' + randomBytes(24).toString('hex');
    insertEncryptedKey(handle.db, 'cerebras', secret);

    const { sink, records } = createMemorySink();
    const logger = new Logger({ sink, minLevel: 'debug' });

    const resolved = await resolveProviderKey(handle.pool, 'cerebras', { logger });
    expect(resolved).toBe(secret);

    // Even on success, no record should ever contain the plaintext.
    assertNoSecret(records, secret);

    // And on failure, still no plaintext leaks.
    insertCorruptKey(handle.db, 'gemini');
    await expect(
      resolveProviderKey(handle.pool, 'gemini', { logger }),
    ).rejects.toBeInstanceOf(ProviderKeyUnavailableError);

    assertNoSecret(records, 'original-secret');
  });

  it('the thrown error does not include plaintext key material', async () => {
    insertCorruptKey(handle.db, 'groq');
    try {
      await resolveProviderKey(handle.pool, 'groq');
      expect.fail('expected ProviderKeyUnavailableError');
    } catch (err) {
      const e = err as ProviderKeyUnavailableError;
      const serialized = JSON.stringify({
        errorMessage: e.message,
        errorName: e.name,
        provider: e.provider,
        category: e.category,
        code: e.code,
        httpStatus: e.httpStatus,
      });
      expect(serialized).not.toContain('original-secret');
    }
  });

  it('emits an audit row even when the request handler has no transaction', async () => {
    // Resolver must be safe to call from any context; the audit writer
    // opens its own short transaction.
    insertCorruptKey(handle.db, 'gemini');
    await expect(resolveProviderKey(handle.pool, 'gemini')).rejects.toBeInstanceOf(
      ProviderKeyUnavailableError,
    );
    expect(handle.db.auditLog).toHaveLength(1);
    // Audit id is a UUID.
    expect(handle.db.auditLog[0]!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('uses unique uuids for each audit row', async () => {
    // Multiple failures should produce distinct audit row ids; the
    // resolver delegates id generation to the audit writer which uses
    // randomUUID (also referenced here just to assert availability).
    expect(typeof randomUUID()).toBe('string');
    await expect(resolveProviderKey(handle.pool, 'gemini')).rejects.toBeInstanceOf(
      ProviderKeyUnavailableError,
    );
    await expect(resolveProviderKey(handle.pool, 'gemini')).rejects.toBeInstanceOf(
      ProviderKeyUnavailableError,
    );
    expect(handle.db.auditLog).toHaveLength(2);
    expect(handle.db.auditLog[0]!.id).not.toBe(handle.db.auditLog[1]!.id);
  });
});

function assertNoSecret(records: LogRecord[], secret: string): void {
  for (const r of records) {
    const blob = JSON.stringify(r);
    expect(blob).not.toContain(secret);
  }
}
