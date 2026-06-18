/**
 * AI Vision proxy route — `POST /ai/vision` (SSE streaming).
 *
 * Implements the AI_Proxy vision completion endpoint per the design:
 *   - Validates body (≤ 10 images, each ≤ 10 MB, text ≤ 32k chars)
 *   - Authenticates via JWT and verifies an active Interview Session
 *   - Resolves provider by `model` slug
 *   - Forwards request to upstream provider with server-held key
 *   - Streams response chunks downstream as Server-Sent Events
 *   - 60-second AbortController timeout
 *   - On error/timeout returns 502 `upstream_provider_error`
 *   - On terminal status, writes a `usage` row (success or failed)
 *
 * Same flow as `POST /ai/text` with additional image validation.
 *
 * Requirements: 7.1, 7.4, 7.5.
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import { verifyAccess, JwtError } from '../auth/jwt.js';
import { resolveProviderKey, ProviderKeyUnavailableError } from './keys.js';
import {
  lookupIdempotencyCache,
  insertIdempotencyCache,
  computeRequestHash,
  IdempotencyKeyConflictError,
} from './idempotency.js';
import type { Logger } from '../log/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiVisionRouteDeps {
  /** Postgres pool for queries. */
  readonly pool: Pool;
  /** Optional logger for structured logging. */
  readonly logger?: Logger;
  /** Clock injection for testing. Defaults to wall clock. */
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of images per request (Requirement 7.1). */
const MAX_IMAGES = 10;

/** Maximum size per image in bytes (10 MB per Requirement 7.1). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Maximum input text length in characters (Requirement 7.1). */
const MAX_INPUT_CHARS = 32_000;

/** Upstream request timeout in milliseconds (Requirement 7.5). */
const UPSTREAM_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Model → Provider mapping
// ---------------------------------------------------------------------------

/** Model-to-provider mapping. The model slug prefix determines the provider. */
const MODEL_PROVIDER_MAP: Record<string, string> = {
  gemini: 'gemini',
  groq: 'groq',
  deepseek: 'deepseek',
  cerebras: 'cerebras',
};

/**
 * Resolve a model slug to its provider name.
 * Convention: the model slug is prefixed with the provider name
 * (e.g. "gemini/gemini-1.5-flash", "groq/llava-v1.5-7b").
 * If no slash is present, the entire slug is treated as the provider name.
 */
function resolveProvider(model: string): string | null {
  const slashIdx = model.indexOf('/');
  const prefix = slashIdx >= 0 ? model.slice(0, slashIdx) : model;
  const normalized = prefix.toLowerCase().trim();
  return MODEL_PROVIDER_MAP[normalized] ?? null;
}

/**
 * Upstream provider endpoint URLs.
 */
const PROVIDER_ENDPOINTS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const ACTIVE_SESSION_SQL = `
  SELECT id, expires_at
    FROM interview_sessions
   WHERE user_id = $1
     AND status = 'active'
   LIMIT 1
`;

const INSERT_USAGE_SQL = `
  INSERT INTO usage (id, user_id, session_id, ts, operation_type, model_id,
                     input_tokens, input_image_count, output_tokens, status,
                     upstream_http_status, idempotency_key)
  VALUES ($1, $2, $3, $4, 'vision', $5, $6, $7, $8, $9, $10, $11)
`;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Estimate the byte size of a base64 data URL image.
 * For data URLs: strip the prefix, compute base64 decoded size.
 * For regular URLs: returns null (cannot determine without fetching).
 */
function estimateImageBytes(url: string): number | null {
  const dataUrlMatch = /^data:[^;]+;base64,(.+)$/i.exec(url);
  if (dataUrlMatch) {
    const base64Data = dataUrlMatch[1]!;
    // Base64 encodes 3 bytes per 4 chars (minus padding)
    const padding = (base64Data.match(/=+$/) ?? [''])[0].length;
    return Math.floor((base64Data.length * 3) / 4) - padding;
  }
  return null;
}

/** A content part within a message (text or image_url). */
interface ContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string };
}

/**
 * Extract all image URLs from the messages array.
 * Messages may have `content` as a string or as an array of content parts.
 */
function extractImageUrls(messages: unknown[]): string[] {
  const urls: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as ContentPart;
      if (p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') {
        urls.push(p.image_url.url);
      }
    }
  }
  return urls;
}

/**
 * Compute total text character count across all messages.
 * Handles both string content and array-of-parts content.
 */
function countTextChars(messages: unknown[], systemPrompt?: string): number {
  let total = 0;
  if (typeof systemPrompt === 'string') {
    total += systemPrompt.length;
  }
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;
    const content = m.content;
    if (typeof content === 'string') {
      total += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as ContentPart;
        if (p.type === 'text' && typeof p.text === 'string') {
          total += p.text.length;
        }
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Build a Hono sub-app exposing `POST /ai/vision`.
 */
export function buildVisionRouter(deps: AiVisionRouteDeps): Hono {
  const router = new Hono();
  const getNow = deps.now ?? (() => new Date());

  router.post('/ai/vision', async (c) => {
    // --- 1. Authentication (Requirement 7.2) ---
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
      if (err instanceof JwtError) {
        return c.json(
          { error: { code: 'unauthenticated', message: err.message } },
          401,
        );
      }
      throw err;
    }

    // --- 2. Verify active session (Requirement 7.3) ---
    const sessionResult = await deps.pool.query<{ id: string; expires_at: Date | string }>(
      ACTIVE_SESSION_SQL,
      [userId],
    );
    const sessionRow = sessionResult.rows[0];
    if (!sessionRow) {
      return c.json(
        { error: { code: 'no_active_session', message: 'no active interview session' } },
        402,
      );
    }

    const now = getNow();
    const expiresAt = new Date(
      sessionRow.expires_at instanceof Date
        ? sessionRow.expires_at.getTime()
        : new Date(sessionRow.expires_at).getTime(),
    );
    if (now.getTime() >= expiresAt.getTime()) {
      return c.json(
        { error: { code: 'no_active_session', message: 'interview session has expired' } },
        402,
      );
    }

    const sessionId = sessionRow.id;

    // --- 3. Parse and validate body (Requirement 7.1) ---
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(
        { error: { code: 'invalid_request', message: 'request body must be valid JSON' } },
        400,
      );
    }

    const messages = body.messages;
    const model = body.model;
    const systemPrompt = body.systemPrompt ?? body.system_prompt;

    if (!model || typeof model !== 'string') {
      return c.json(
        { error: { code: 'invalid_request', message: 'model field is required and must be a string' } },
        400,
      );
    }

    if (!messages || !Array.isArray(messages)) {
      return c.json(
        { error: { code: 'invalid_request', message: 'messages field is required and must be an array' } },
        400,
      );
    }

    // Validate text length (≤ 32k chars)
    const totalChars = countTextChars(
      messages,
      typeof systemPrompt === 'string' ? systemPrompt : undefined,
    );
    if (totalChars > MAX_INPUT_CHARS) {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: `total input text exceeds ${MAX_INPUT_CHARS} characters`,
          },
        },
        400,
      );
    }

    // Validate images: ≤ 10 images, each ≤ 10 MB
    const imageUrls = extractImageUrls(messages);
    if (imageUrls.length > MAX_IMAGES) {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: `request contains ${imageUrls.length} images; maximum is ${MAX_IMAGES}`,
          },
        },
        400,
      );
    }

    for (let i = 0; i < imageUrls.length; i++) {
      const size = estimateImageBytes(imageUrls[i]!);
      if (size !== null && size > MAX_IMAGE_BYTES) {
        return c.json(
          {
            error: {
              code: 'invalid_request',
              message: `image at index ${i} exceeds the 10 MB size limit`,
            },
          },
          400,
        );
      }
    }

    // --- 4. Resolve provider (design: model slug → provider) ---
    const provider = resolveProvider(model);
    if (!provider) {
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: `unsupported model: ${model}`,
          },
        },
        400,
      );
    }

    // --- 5. Idempotency check (Requirements 7.6, 7.7) ---
    const idempotencyKey = c.req.header('Idempotency-Key') ?? null;
    let requestHash: Buffer | null = null;

    if (idempotencyKey) {
      requestHash = computeRequestHash({ messages, model, systemPrompt: systemPrompt ?? null });
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

    // --- 6. Resolve provider key (Requirement 4.5) ---
    let providerKey: string;
    try {
      providerKey = await resolveProviderKey(deps.pool, provider, {
        ...(deps.logger ? { logger: deps.logger } : {}),
      });
    } catch (err) {
      if (err instanceof ProviderKeyUnavailableError) {
        return c.json(
          { error: { code: 'provider_key_unavailable', message: 'AI provider is currently unavailable' } },
          503,
        );
      }
      throw err;
    }

    // --- 7. Build upstream request ---
    const endpoint = PROVIDER_ENDPOINTS[provider];
    if (!endpoint) {
      return c.json(
        { error: { code: 'upstream_provider_error', message: 'provider endpoint not configured' } },
        502,
      );
    }

    // Build the messages array for the upstream provider.
    // Vision messages include content parts with image_url entries.
    const upstreamMessages: unknown[] = [];
    if (typeof systemPrompt === 'string' && systemPrompt.length > 0) {
      upstreamMessages.push({ role: 'system', content: systemPrompt });
    }
    for (const msg of messages) {
      if (msg && typeof msg === 'object') {
        const m = msg as Record<string, unknown>;
        upstreamMessages.push({
          role: String(m.role ?? 'user'),
          content: m.content, // Preserve content parts (text + image_url) as-is
        });
      }
    }

    // Extract the actual model name (after the provider prefix)
    const slashIdx = model.indexOf('/');
    const modelId = slashIdx >= 0 ? model.slice(slashIdx + 1) : model;

    const upstreamBody = JSON.stringify({
      model: modelId,
      messages: upstreamMessages,
      stream: true,
    });

    // --- 8. Forward to upstream with 60s timeout (Requirement 7.5) ---
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const startTime = Date.now();

    let upstreamResponse: Response;
    let upstreamStatus: number | null = null;

    try {
      upstreamResponse = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${providerKey}`,
        },
        body: upstreamBody,
        signal: controller.signal,
      });
      upstreamStatus = upstreamResponse.status;
    } catch (err) {
      clearTimeout(timeout);
      const latencyMs = Date.now() - startTime;

      // Write usage row with failed status
      await writeUsageRow(deps.pool, {
        userId,
        sessionId,
        now: getNow(),
        modelId: model,
        status: 'failed',
        upstreamHttpStatus: null,
        idempotencyKey,
        inputTokens: null,
        inputImageCount: imageUrls.length,
        outputTokens: null,
      });

      deps.logger?.error('ai_vision_upstream_error', {
        user_id: userId,
        session_id: sessionId,
        operation_type: 'vision',
        model_id: model,
        status: 'failed',
        latency_ms: latencyMs,
        error_type: (err as Error).name === 'AbortError' ? 'timeout' : 'network_error',
      });

      return c.json(
        { error: { code: 'upstream_provider_error', message: 'upstream provider request failed' } },
        502,
      );
    }

    // If upstream returned a non-2xx status, treat as error
    if (!upstreamResponse.ok) {
      clearTimeout(timeout);
      const latencyMs = Date.now() - startTime;

      await writeUsageRow(deps.pool, {
        userId,
        sessionId,
        now: getNow(),
        modelId: model,
        status: 'failed',
        upstreamHttpStatus: upstreamStatus,
        idempotencyKey,
        inputTokens: null,
        inputImageCount: imageUrls.length,
        outputTokens: null,
      });

      deps.logger?.error('ai_vision_upstream_error', {
        user_id: userId,
        session_id: sessionId,
        operation_type: 'vision',
        model_id: model,
        status: 'failed',
        latency_ms: latencyMs,
        upstream_http_status: upstreamStatus,
      });

      return c.json(
        { error: { code: 'upstream_provider_error', message: 'upstream provider returned an error' } },
        502,
      );
    }

    // --- 9. Stream SSE response downstream (Requirement 7.8) ---
    const responseBody = upstreamResponse.body;
    if (!responseBody) {
      clearTimeout(timeout);

      await writeUsageRow(deps.pool, {
        userId,
        sessionId,
        now: getNow(),
        modelId: model,
        status: 'failed',
        upstreamHttpStatus: upstreamStatus,
        idempotencyKey,
        inputTokens: null,
        inputImageCount: imageUrls.length,
        outputTokens: null,
      });

      return c.json(
        { error: { code: 'upstream_provider_error', message: 'upstream provider returned no body' } },
        502,
      );
    }

    // Stream the response using a ReadableStream that reads from upstream
    const sseStream = new ReadableStream({
      async start(streamController) {
        const reader = responseBody.getReader();
        const decoder = new TextDecoder();
        let inputTokens: number | null = null;
        let outputTokens: number | null = null;
        let streamFailed = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            streamController.enqueue(new TextEncoder().encode(chunk));

            // Try to extract token usage from the final chunk
            if (chunk.includes('"usage"')) {
              try {
                const lines = chunk.split('\n');
                for (const line of lines) {
                  if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    const jsonStr = line.slice(6);
                    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
                    if (parsed.usage && typeof parsed.usage === 'object') {
                      const usage = parsed.usage as Record<string, unknown>;
                      if (typeof usage.prompt_tokens === 'number') {
                        inputTokens = usage.prompt_tokens;
                      }
                      if (typeof usage.completion_tokens === 'number') {
                        outputTokens = usage.completion_tokens;
                      }
                    }
                  }
                }
              } catch {
                // Ignore parse errors in usage extraction
              }
            }
          }
        } catch (err) {
          streamFailed = true;
          deps.logger?.error('ai_vision_stream_error', {
            user_id: userId,
            session_id: sessionId,
            operation_type: 'vision',
            model_id: model,
            error_type: (err as Error).name === 'AbortError' ? 'timeout' : 'stream_error',
          });
        } finally {
          clearTimeout(timeout);
          streamController.close();

          const latencyMs = Date.now() - startTime;
          const finalStatus = streamFailed ? 'failed' : 'success';

          // Write usage row on terminal status (Requirement 9.1)
          await writeUsageRow(deps.pool, {
            userId,
            sessionId,
            now: getNow(),
            modelId: model,
            status: finalStatus,
            upstreamHttpStatus: upstreamStatus,
            idempotencyKey,
            inputTokens,
            inputImageCount: imageUrls.length,
            outputTokens,
          });

          // Emit structured log record
          deps.logger?.info('ai_operation_complete', {
            user_id: userId,
            session_id: sessionId,
            operation_type: 'vision',
            model_id: model,
            status: finalStatus,
            latency_ms: latencyMs,
            upstream_http_status: upstreamStatus,
            idempotency_key: idempotencyKey,
            image_count: imageUrls.length,
          });
        }
      },
    });

    return new Response(sseStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Usage row writer
// ---------------------------------------------------------------------------

interface WriteUsageInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly now: Date;
  readonly modelId: string;
  readonly status: 'success' | 'failed';
  readonly upstreamHttpStatus: number | null;
  readonly idempotencyKey: string | null;
  readonly inputTokens: number | null;
  readonly inputImageCount: number;
  readonly outputTokens: number | null;
}

/**
 * Write a usage row to the `usage` table. Records the terminal status
 * of an AI vision operation (success or failed) per Requirement 9.1.
 *
 * Errors are swallowed: the usage row is observability data and must
 * not cause the request to fail if the insert encounters a transient
 * DB issue.
 */
async function writeUsageRow(pool: Pool, input: WriteUsageInput): Promise<void> {
  try {
    await pool.query(INSERT_USAGE_SQL, [
      randomUUID(),
      input.userId,
      input.sessionId,
      input.now.toISOString(),
      input.modelId,
      input.inputTokens,
      input.inputImageCount,
      input.outputTokens,
      input.status,
      input.upstreamHttpStatus,
      input.idempotencyKey,
    ]);
  } catch {
    // Swallow: usage recording is best-effort observability.
  }
}
