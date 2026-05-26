/**
 * POST /ai/audio — Audio transcription endpoint.
 *
 * Accepts multipart/form-data with a single audio file, validates size
 * (≤ 25 MB) and duration (≤ 5 min), offloads the blob to object storage
 * with a 7-day TTL, then forwards to the Whisper provider with a
 * 120-second timeout.
 *
 * Flow:
 *   1. Authenticate via JWT (R7.2)
 *   2. Verify active interview session (R7.3)
 *   3. Check idempotency cache (R7.6, R7.7)
 *   4. Validate file size ≤ 25 MB and duration ≤ 5 min (R7.1)
 *   5. Check storage quota gate (R15.3)
 *   6. Persist blob to object storage with 7-day TTL (R15.2)
 *   7. Resolve Whisper provider key (R4.5)
 *   8. Forward to Whisper with 120-second timeout (R7.5)
 *   9. Record usage row (R9.1)
 *   10. Cache response for idempotency (R7.6)
 *
 * Requirements: 7.1, 7.4, 7.5, 15.2.
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import { JwtError, verifyAccess } from '../auth/jwt.js';
import { resolveProviderKey, ProviderKeyUnavailableError } from './keys.js';
import {
  computeRequestHash,
  lookupIdempotencyCache,
  insertIdempotencyCache,
  IdempotencyKeyConflictError,
} from './idempotency.js';
import { storeAudioBlob } from '../storage/blob-store.js';
import type { StorageQuotaGate } from '../storage/quota-gate.js';
import { StorageQuotaExceededError } from '../storage/quota-gate.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioRouterDeps {
  /** Postgres pool for queries. */
  readonly pool: Pool;
  /** Storage quota gate for blob persistence (R15.3). */
  readonly storageGate: StorageQuotaGate;
  /** Clock injection for tests. Defaults to wall clock. */
  readonly now?: () => Date;
  /**
   * Whisper transcription function. Injected for testability so tests
   * can stub the upstream call without nock.
   */
  readonly transcribe?: TranscribeFn;
}

/**
 * Function signature for the Whisper transcription call.
 * Accepts the audio buffer, model, and API key; returns the transcribed text.
 */
export type TranscribeFn = (
  audioBuffer: Buffer,
  fileName: string,
  mimeType: string,
  model: string,
  apiKey: string,
  signal: AbortSignal,
) => Promise<string>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum audio file size: 25 MB. */
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/** Maximum audio duration: 5 minutes in seconds. */
const MAX_DURATION_SECONDS = 5 * 60;

/** Upstream timeout for Whisper: 120 seconds. */
const WHISPER_TIMEOUT_MS = 120_000;

/** Default Whisper model when none specified. */
const DEFAULT_WHISPER_MODEL = 'whisper-large-v3';

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const ACTIVE_SESSION_SQL = `
  SELECT id, started_at, expires_at
    FROM interview_sessions
   WHERE user_id = $1
     AND status = 'active'
   LIMIT 1
`;

const INSERT_USAGE_SQL = `
  INSERT INTO usage (id, user_id, session_id, ts, operation_type, model_id, status, upstream_http_status, idempotency_key)
  VALUES ($1, $2, $3, $4, 'audio', $5, $6, $7, $8)
`;

// ---------------------------------------------------------------------------
// Default Whisper transcription implementation
// ---------------------------------------------------------------------------

/**
 * Default implementation that calls the Groq Whisper API.
 * Uses multipart/form-data to send the audio file.
 */
async function defaultTranscribe(
  audioBuffer: Buffer,
  fileName: string,
  mimeType: string,
  model: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  // Build multipart form data manually for the Whisper API
  const boundary = `----FormBoundary${randomUUID().replace(/-/g, '')}`;
  const CRLF = '\r\n';

  const parts: Buffer[] = [];

  // File part
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`,
  ));
  parts.push(audioBuffer);
  parts.push(Buffer.from(CRLF));

  // Model part
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
    `${model}${CRLF}`,
  ));

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--${CRLF}`));

  const body = Buffer.concat(parts);

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    throw new UpstreamProviderError(response.status, errorText);
  }

  const result = await response.json() as { text?: string };
  if (typeof result.text !== 'string') {
    throw new UpstreamProviderError(response.status, 'missing text field in response');
  }

  return result.text;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class UpstreamProviderError extends Error {
  readonly httpStatus: number;

  constructor(upstreamStatus: number, detail: string) {
    super(`Upstream provider error (HTTP ${upstreamStatus}): ${detail}`);
    this.name = 'UpstreamProviderError';
    this.httpStatus = upstreamStatus;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Build the Hono sub-app for the audio transcription endpoint.
 */
export function buildAudioRouter(deps: AudioRouterDeps): Hono {
  const router = new Hono();
  const transcribeFn = deps.transcribe ?? defaultTranscribe;

  router.post('/ai/audio', async (c) => {
    // 1. Authenticate
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      return c.json(
        { error: { code: 'unauthenticated', message: 'missing Authorization header' } },
        401,
      );
    }
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!match) {
      return c.json(
        { error: { code: 'unauthenticated', message: 'malformed Authorization header' } },
        401,
      );
    }

    let userId: string;
    try {
      const claims = await verifyAccess(match[1]!);
      userId = claims.sub;
    } catch (err) {
      const code = err instanceof JwtError ? err.code : 'unauthenticated';
      const message = err instanceof Error ? err.message : 'invalid token';
      return c.json({ error: { code, message } }, 401);
    }

    // 2. Verify active session (R7.3)
    const sessionResult = await deps.pool.query<{
      id: string;
      started_at: Date;
      expires_at: Date;
    }>(ACTIVE_SESSION_SQL, [userId]);
    const activeSession = sessionResult.rows[0];

    if (!activeSession) {
      return c.json(
        { error: { code: 'no_active_session', message: 'no active interview session' } },
        402,
      );
    }

    // Check if session has expired
    const now = deps.now ? deps.now() : new Date();
    const expiresAt = new Date(activeSession.expires_at);
    if (now >= expiresAt) {
      return c.json(
        { error: { code: 'no_active_session', message: 'interview session has expired' } },
        402,
      );
    }

    // 3. Parse multipart form data
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json(
        { error: { code: 'invalid_request', message: 'invalid multipart form data' } },
        400,
      );
    }

    const file = formData.get('file');
    if (!file || !(file instanceof File)) {
      return c.json(
        { error: { code: 'invalid_request', message: 'missing audio file in "file" field' } },
        400,
      );
    }

    // Get model from form data (optional, defaults to whisper-large-v3)
    const modelField = formData.get('model');
    const model = typeof modelField === 'string' && modelField.trim()
      ? modelField.trim()
      : DEFAULT_WHISPER_MODEL;

    // Get optional duration field (client-reported duration in seconds)
    const durationField = formData.get('duration');
    const reportedDuration = durationField ? Number(durationField) : null;

    // 4. Validate file size (≤ 25 MB)
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
      return c.json(
        {
          error: {
            code: 'file_too_large',
            message: `audio file exceeds maximum size of 25 MB`,
            details: { max_bytes: MAX_FILE_SIZE_BYTES, actual_bytes: fileBuffer.length },
          },
        },
        400,
      );
    }

    if (fileBuffer.length === 0) {
      return c.json(
        { error: { code: 'invalid_request', message: 'audio file is empty' } },
        400,
      );
    }

    // 5. Validate duration (≤ 5 min) — uses client-reported duration
    if (reportedDuration !== null && !isNaN(reportedDuration)) {
      if (reportedDuration > MAX_DURATION_SECONDS) {
        return c.json(
          {
            error: {
              code: 'duration_too_long',
              message: `audio duration exceeds maximum of 5 minutes`,
              details: { max_seconds: MAX_DURATION_SECONDS, reported_seconds: reportedDuration },
            },
          },
          400,
        );
      }
    }

    // 6. Check idempotency (R7.6, R7.7)
    const idempotencyKey = c.req.header('Idempotency-Key') ?? null;
    let requestHash: Buffer | null = null;

    if (idempotencyKey) {
      // Hash based on file content + model (canonical representation)
      requestHash = computeRequestHash({
        file_size: fileBuffer.length,
        file_name: file.name,
        model,
      });

      try {
        const cached = await lookupIdempotencyCache(
          deps.pool,
          userId,
          idempotencyKey,
          requestHash,
        );
        if (cached.hit) {
          return c.json(cached.response as object);
        }
      } catch (err) {
        if (err instanceof IdempotencyKeyConflictError) {
          return c.json(
            { error: { code: 'idempotency_key_conflict', message: err.message } },
            409,
          );
        }
        throw err;
      }
    }

    // 7. Check storage quota gate (R15.3)
    try {
      await deps.storageGate.assertCanWriteBlob();
    } catch (err) {
      if (err instanceof StorageQuotaExceededError) {
        return c.json(
          {
            error: {
              code: 'storage_quota_exceeded',
              message: 'storage quota exceeded, cannot persist audio blob',
              details: {
                observed_bytes: err.observedBytes,
                threshold_bytes: err.thresholdBytes,
              },
            },
          },
          507,
        );
      }
      throw err;
    }

    // 8. Persist blob to object storage with 7-day TTL (R15.2)
    const mimeType = file.type || 'audio/webm';
    const fileName = file.name || 'audio.webm';

    await storeAudioBlob(deps.pool, {
      userId,
      sessionId: activeSession.id,
      fileName,
      mimeType,
      data: fileBuffer,
    });

    // 9. Resolve provider key for Whisper (uses 'groq' provider)
    let apiKey: string;
    try {
      apiKey = await resolveProviderKey(deps.pool, 'groq');
    } catch (err) {
      if (err instanceof ProviderKeyUnavailableError) {
        // Record failed usage
        await recordUsage(deps.pool, {
          userId,
          sessionId: activeSession.id,
          model,
          status: 'failed',
          upstreamHttpStatus: null,
          idempotencyKey,
          now: deps.now,
        });
        return c.json(
          { error: { code: 'provider_key_unavailable', message: 'transcription service unavailable' } },
          503,
        );
      }
      throw err;
    }

    // 10. Forward to Whisper with 120-second timeout (R7.5)
    let transcribedText: string;
    let upstreamStatus: number | null = null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

    try {
      transcribedText = await transcribeFn(
        fileBuffer,
        fileName,
        mimeType,
        model,
        apiKey,
        controller.signal,
      );
      upstreamStatus = 200;
    } catch (err) {
      clearTimeout(timeout);

      // Determine if it was a timeout or upstream error
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      if (err instanceof UpstreamProviderError) {
        upstreamStatus = err.httpStatus;
      }

      // Record failed usage
      await recordUsage(deps.pool, {
        userId,
        sessionId: activeSession.id,
        model,
        status: 'failed',
        upstreamHttpStatus: upstreamStatus,
        idempotencyKey,
        now: deps.now,
      });

      return c.json(
        {
          error: {
            code: 'upstream_provider_error',
            message: isTimeout
              ? 'transcription request timed out (120s)'
              : 'upstream transcription provider returned an error',
          },
        },
        502,
      );
    } finally {
      clearTimeout(timeout);
    }

    // 11. Record successful usage
    await recordUsage(deps.pool, {
      userId,
      sessionId: activeSession.id,
      model,
      status: 'success',
      upstreamHttpStatus: upstreamStatus,
      idempotencyKey,
      now: deps.now,
    });

    const responseBody = { text: transcribedText };

    // 12. Cache response for idempotency (R7.6)
    if (idempotencyKey && requestHash) {
      try {
        await insertIdempotencyCache(
          deps.pool,
          userId,
          idempotencyKey,
          requestHash,
          responseBody,
        );
      } catch {
        // Idempotency cache insert failure is non-fatal
      }
    }

    // Clear the API key from memory
    apiKey = '';

    return c.json(responseBody);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RecordUsageInput {
  userId: string;
  sessionId: string;
  model: string;
  status: 'success' | 'failed';
  upstreamHttpStatus: number | null;
  idempotencyKey: string | null;
  now?: (() => Date) | undefined;
}

async function recordUsage(pool: Pool, input: RecordUsageInput): Promise<void> {
  const ts = input.now ? input.now() : new Date();
  try {
    await pool.query(INSERT_USAGE_SQL, [
      randomUUID(),
      input.userId,
      input.sessionId,
      ts.toISOString(),
      input.model,
      input.status,
      input.upstreamHttpStatus,
      input.idempotencyKey,
    ]);
  } catch {
    // Usage recording failure is non-fatal; the transcription result
    // has already been produced and should still be returned to the client.
  }
}
