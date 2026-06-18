/**
 * AI Text completion route — `POST /ai/text` (SSE streaming).
 *
 * Implements the AI_Proxy text completion endpoint per the design:
 *   - Validates body (≤ 32k chars total input text)
 *   - Authenticates via JWT and verifies an active Interview Session
 *   - Resolves provider by `model` slug
 *   - Forwards request to upstream provider with server-held key
 *   - Streams response chunks downstream as Server-Sent Events
 *   - 60-second AbortController timeout
 *   - On error/timeout returns 502 `upstream_provider_error`
 *   - On terminal status, writes a `usage` row (success or failed)
 *
 * Requirements: 7.1, 7.4, 7.5, 7.8, 9.1.
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

export interface AiTextRouteDeps {
  /** Postgres pool for queries. */
  readonly pool: Pool;
  /** Optional logger for structured logging. */
  readonly logger?: Logger;
  /** Clock injection for testing. Defaults to wall clock. */
  readonly now?: () => Date;
}

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
 * (e.g. "groq/llama-3.1-70b", "gemini/gemini-1.5-flash", "deepseek/deepseek-chat").
 * If no slash is present, the entire slug is treated as the provider name.
 */
function resolveProvider(model: string): string | null {
  const slashIdx = model.indexOf('/');
  const prefix = slashIdx >= 0 ? model.slice(0, slashIdx) : model;
  const normalized = prefix.toLowerCase().trim();
  return MODEL_PROVIDER_MAP[normalized] ?? null;
}

/**
 * Upstream provider endpoint URLs. Each provider has a chat completions
 * endpoint that accepts OpenAI-compatible request bodies (or similar).
 */
const PROVIDER_ENDPOINTS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};

/** Maximum input text length in characters (Requirement 7.1). */
const MAX_INPUT_CHARS = 32_000;

/** Upstream request timeout in milliseconds (Requirement 7.5). */
const UPSTREAM_TIMEOUT_MS = 60_000;

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
                     input_tokens, output_tokens, status, upstream_http_status, idempotency_key)
  VALUES ($1, $2, $3, $4, 'text', $5, $6, $7, $8, $9, $10)
`;

// ---------------------------------------------------------------------------
// Route builder
// ---------------------------------------------------------------------------

/**
 * Build a Hono sub-app exposing `POST /ai/text`.
 */
export function buildAiTextRouter(deps: AiTextRouteDeps): Hono {
  const router = new Hono();
  const getNow = deps.now ?? (() => new Date());

  router.post('/ai/text', async (c) => {
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

    // --- 3. Parse and validate body (Requirement 7.1: ≤ 32k chars) ---
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

    // Compute total input text length
    let totalChars = 0;
    if (typeof systemPrompt === 'string') {
      totalChars += systemPrompt.length;
    }
    for (const msg of messages) {
      if (msg && typeof msg === 'object' && 'content' in msg) {
        const content = (msg as Record<string, unknown>).content;
        if (typeof content === 'string') {
          totalChars += content.length;
        }
      }
    }

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

    // Build the messages array for the upstream provider
    const upstreamMessages: Array<{ role: string; content: string }> = [];
    if (typeof systemPrompt === 'string' && systemPrompt.length > 0) {
      upstreamMessages.push({ role: 'system', content: systemPrompt });
    }
    for (const msg of messages) {
      if (msg && typeof msg === 'object') {
        const m = msg as Record<string, unknown>;
        upstreamMessages.push({
          role: String(m.role ?? 'user'),
          content: String(m.content ?? ''),
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
        outputTokens: null,
      });

      deps.logger?.error('ai_text_upstream_error', {
        user_id: userId,
        session_id: sessionId,
        operation_type: 'text',
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
        outputTokens: null,
      });

      deps.logger?.error('ai_text_upstream_error', {
        user_id: userId,
        session_id: sessionId,
        operation_type: 'text',
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
    const upstreamBody2 = upstreamResponse.body;
    if (!upstreamBody2) {
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
        outputTokens: null,
      });

      return c.json(
        { error: { code: 'upstream_provider_error', message: 'upstream provider returned no body' } },
        502,
      );
    }

    // Stream the response using a ReadableStream that reads from upstream
    const stream = new ReadableStream({
      async start(streamController) {
        const reader = upstreamBody2.getReader();
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
            // OpenAI-compatible APIs send usage in the last data chunk
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
          // Stream read error (could be timeout via abort)
          deps.logger?.error('ai_text_stream_error', {
            user_id: userId,
            session_id: sessionId,
            operation_type: 'text',
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
            outputTokens,
          });

          // Emit structured log record (Requirement 14.1)
          deps.logger?.info('ai_operation_complete', {
            user_id: userId,
            session_id: sessionId,
            operation_type: 'text',
            model_id: model,
            status: finalStatus,
            latency_ms: latencyMs,
            upstream_http_status: upstreamStatus,
            idempotency_key: idempotencyKey,
          });

          // Cache the response for idempotency if applicable
          // Note: For streaming responses, we don't cache the full stream
          // since it's not practical. Idempotency for streaming is best-effort.
        }
      },
    });

    return new Response(stream, {
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
  readonly outputTokens: number | null;
}

/**
 * Write a usage row to the `usage` table. This records the terminal
 * status of an AI operation (success or failed) per Requirement 9.1.
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
      input.outputTokens,
      input.status,
      input.upstreamHttpStatus,
      input.idempotencyKey,
    ]);
  } catch {
    // Swallow: usage recording is best-effort observability.
    // The primary obligation is to serve the AI response.
  }
}
