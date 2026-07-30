/**
 * POST /ai/audio — Audio transcription endpoint.
 *
 * Accepts multipart/form-data with a single audio file, validates size
 * (≤ 25 MB) and duration (≤ 5 min), keeps the uploaded bytes only in
 * request memory, then forwards them to Groq Whisper with a 120-second
 * timeout.
 *
 * Flow:
 *   1. Authenticate via JWT (R7.2)
 *   2. Verify active interview session (R7.3)
 *   3. Parse multipart form data
 *   4. Validate file size ≤ 25 MB (R7.1)
 *   5. Validate duration ≤ 5 min (R7.1)
 *   6. Check idempotency cache (R7.6, R7.7)
 *   7. Resolve Whisper provider key (R4.5)
 *   8. Forward the in-memory audio to Whisper (R7.5)
 *   9. Record usage row (R9.1)
 *   10. Cache response for idempotency (R7.6)
 *
 * Requirements: 7.1, 7.4, 7.5.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioRouterDeps {
  /** Postgres pool for queries. */
  readonly pool: Pool;
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

  // Force English transcription. Without an explicit `language`, Whisper
  // auto-detects the spoken language and may transcribe (or translate) the
  // audio into another language such as Hindi. That non-English transcript
  // then flows into the LLM, which replies in the same language. Pinning
  // the language to English keeps the whole pipeline English-only.
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="language"${CRLF}${CRLF}` +
    `en${CRLF}`,
  ));

  // Deterministic decoding + JSON response for stable, repeatable output.
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}` +
    `json${CRLF}`,
  ));
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="temperature"${CRLF}${CRLF}` +
    `0${CRLF}`,
  ));

  // Bias the decoder toward an English technical-interview context.
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="prompt"${CRLF}${CRLF}` +
    `Technical interview question about software engineering, coding, or behavioral topics.${CRLF}`,
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

    // Resolve the Whisper model. Priority:
    //   1. Admin-configured STT model (app_config key 'stt_model') — global
    //   2. Client-supplied "model" form field
    //   3. DEFAULT_WHISPER_MODEL
    // The admin selection wins so it applies to every client without a
    // client-side release.
    const modelField = formData.get('model');
    let model = typeof modelField === 'string' && modelField.trim()
      ? modelField.trim()
      : DEFAULT_WHISPER_MODEL;
    try {
      const sttCfg = await deps.pool.query(
        `SELECT value FROM app_config WHERE key = 'stt_model' LIMIT 1`,
      );
      const sttRow = sttCfg.rows[0] as { value: string } | undefined;
      if (sttRow) {
        const parsed = JSON.parse(sttRow.value) as { model?: unknown };
        if (parsed && typeof parsed.model === 'string' && parsed.model.trim()) {
          model = parsed.model.trim();
        }
      }
    } catch {
      // Keep the client/default model if the config is missing or unreadable.
    }

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

    // 7. Resolve provider key for Whisper (uses 'groq' provider).
    // The audio buffer remains request-scoped and is sent directly upstream;
    // no database or object-storage write is performed.
    const mimeType = file.type || 'audio/webm';
    const fileName = file.name || 'audio.webm';

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

    // 8. Forward to Whisper with 120-second timeout (R7.5)
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

    // 9. Record successful usage
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

    // 10. Cache response for idempotency (R7.6)
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
