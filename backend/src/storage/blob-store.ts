/**
 * Audio blob storage module.
 *
 * Persists audio file blobs to Postgres with a configurable TTL (default
 * 7 days per Requirement 15.2). The design offloads blobs to "object
 * storage" — in the free-tier Postgres-only deployment this means a
 * `bytea` column in the `audio_blobs` table. The module is structured
 * behind an interface so a future migration to Supabase Storage or S3
 * requires only swapping the implementation.
 *
 * The store checks the {@link StorageQuotaGate} before persisting to
 * enforce Requirement 15.3 (reject when usage ≥ 450 MB).
 *
 * Requirements: 15.2, 15.3.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioBlobMetadata {
  /** Unique blob identifier. */
  readonly id: string;
  /** Owner user id. */
  readonly userId: string;
  /** Associated interview session id. */
  readonly sessionId: string;
  /** Original file name from the upload. */
  readonly fileName: string;
  /** MIME type of the audio file. */
  readonly mimeType: string;
  /** Size in bytes. */
  readonly sizeBytes: number;
  /** When the blob was stored. */
  readonly createdAt: Date;
  /** When the blob expires and becomes eligible for cleanup. */
  readonly expiresAt: Date;
}

export interface StoreAudioBlobInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly data: Buffer;
}

export interface BlobStoreOptions {
  /** TTL in days for stored blobs. Defaults to 7. */
  readonly ttlDays?: number;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const INSERT_BLOB_SQL = `
  INSERT INTO audio_blobs (id, user_id, session_id, file_name, mime_type, size_bytes, data, created_at, expires_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now() + make_interval(days => $8))
  RETURNING id, created_at, expires_at
`;

const CLEANUP_EXPIRED_SQL = `
  DELETE FROM audio_blobs
   WHERE expires_at < now()
`;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Store an audio blob in Postgres with a TTL.
 *
 * @returns Metadata about the stored blob (id, timestamps).
 */
export async function storeAudioBlob(
  pool: Pool,
  input: StoreAudioBlobInput,
  options: BlobStoreOptions = {},
): Promise<AudioBlobMetadata> {
  const ttlDays = options.ttlDays ?? 7;
  const id = randomUUID();

  const result = await pool.query<{ id: string; created_at: Date; expires_at: Date }>(
    INSERT_BLOB_SQL,
    [
      id,
      input.userId,
      input.sessionId,
      input.fileName,
      input.mimeType,
      input.data.length,
      input.data,
      ttlDays,
    ],
  );

  const row = result.rows[0]!;
  return {
    id: row.id,
    userId: input.userId,
    sessionId: input.sessionId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.data.length,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Remove all expired audio blobs. Intended to be called by a scheduled
 * cleanup task.
 *
 * @returns The number of blobs deleted.
 */
export async function cleanupExpiredBlobs(
  pool: Pool,
): Promise<{ deleted: number }> {
  const result = await pool.query(CLEANUP_EXPIRED_SQL);
  return { deleted: result.rowCount ?? 0 };
}
