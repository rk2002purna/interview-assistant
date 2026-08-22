/**
 * AI Text completion route — `POST /ai/text` (SSE streaming).
 *
 * The provider/model is chosen **server-side** from the admin routing config
 * (`app_config.model_routing`), not from the client request body. The client
 * still sends `messages` (and optional `systemPrompt`), but the model it asks
 * for is ignored — the backend is the source of truth. This lets an operator
 * change models (or route around a decommissioned one) from the admin
 * dashboard with no desktop app release.
 *
 * Resolution + fallback:
 *   1. Read routing → ordered [primary, fallback] candidates.
 *   2. For each candidate: resolve the provider key and call the upstream.
 *   3. The first candidate whose upstream returns 2xx is streamed downstream.
 *   4. If a candidate's key is missing or the upstream errors/times out, the
 *      next candidate is tried. Fallback happens before any bytes are
 *      streamed, so a partial response is never mixed between providers.
 *   5. If every candidate fails, return 503 (all keys unavailable) or 502.
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
  computeRequestHash,
  IdempotencyKeyConflictError,
} from './idempotency.js';
import {
  PROVIDER_ENDPOINTS,
  readRoutingConfig,
  textCandidates,
  routingSlug,
} from './model-routing.js';
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
    const systemPrompt = body.systemPrompt ?? body.system_prompt;

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

    // --- 4. Resolve provider/model server-side from admin routing config ---
    const routing = await readRoutingConfig(deps.pool);
    const candidates = textCandidates(routing);
    if (candidates.length === 0) {
      return c.json(
        { error: { code: 'upstream_provider_error', message: 'no text model is configured' } },
        502,
      );
    }

    // --- 5. Idempotency check (Requirements 7.6, 7.7) ---
    // Hash is based on the client-controlled inputs (messages + systemPrompt);
    // the model is server-chosen and therefore not part of the request identity.
    const idempotencyKey = c.req.header('Idempotency-Key') ?? null;
    if (idempotencyKey) {
      const requestHash = computeRequestHash({ messages, systemPrompt: systemPrompt ?? null });
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

    // Build the upstream messages array once (shared across candidates).
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

    // --- 6. Try each candidate (primary, then fallback) ---
    let lastErrorCode: 'provider_key_unavailable' | 'upstream_provider_error' =
      'upstream_provider_error';

    for (const candidate of candidates) {
      const modelSlug = routingSlug(candidate);
      const endpoint = PROVIDER_ENDPOINTS[candidate.provider]!;

      // Resolve provider key; on failure, try the next candidate.
      let providerKey: string;
      try {
        providerKey = await resolveProviderKey(deps.pool, candidate.provider, {
          ...(deps.logger ? { logger: deps.logger } : {}),
        });
      } catch (err) {
        if (err instanceof ProviderKeyUnavailableError) {
          lastErrorCode = 'provider_key_unavailable';
          await writeUsageRow(deps.pool, {
            userId,
            sessionId,
            now: getNow(),
            modelId: modelSlug,
            status: 'failed',
            upstreamHttpStatus: null,
            idempotencyKey,
            inputTokens: null,
            outputTokens: null,
          });
          deps.logger?.warn('ai_text_provider_key_unavailable', {
            user_id: userId,
            session_id: sessionId,
            provider: candidate.provider,
            model_id: modelSlug,
          });
          continue;
        }
        throw err;
      }

      const upstreamBody = JSON.stringify({
        model: candidate.model,
        messages: upstreamMessages,
        stream: true,
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      const startTime = Date.now();

      let upstreamResponse: Response;
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
      } catch (err) {
        clearTimeout(timeout);
        lastErrorCode = 'upstream_provider_error';
        await writeUsageRow(deps.pool, {
          userId,
          sessionId,
          now: getNow(),
          modelId: modelSlug,
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
          model_id: modelSlug,
          status: 'failed',
          latency_ms: Date.now() - startTime,
          error_type: (err as Error).name === 'AbortError' ? 'timeout' : 'network_error',
        });
        continue;
      }

      if (!upstreamResponse.ok || !upstreamResponse.body) {
        clearTimeout(timeout);
        lastErrorCode = 'upstream_provider_error';
        await writeUsageRow(deps.pool, {
          userId,
          sessionId,
          now: getNow(),
          modelId: modelSlug,
          status: 'failed',
          upstreamHttpStatus: upstreamResponse.status,
          idempotencyKey,
          inputTokens: null,
          outputTokens: null,
        });
        deps.logger?.error('ai_text_upstream_error', {
          user_id: userId,
          session_id: sessionId,
          operation_type: 'text',
          model_id: modelSlug,
          status: 'failed',
          latency_ms: Date.now() - startTime,
          upstream_http_status: upstreamResponse.status,
        });
        continue;
      }

      // --- Success: stream this candidate's SSE response downstream ---
      const upstreamStatus = upstreamResponse.status;
      const upstreamBodyStream = upstreamResponse.body;
      const stream = new ReadableStream({
        async start(streamController) {
          const reader = upstreamBodyStream.getReader();
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

              if (chunk.includes('"usage"')) {
                try {
                  const lines = chunk.split('\n');
                  for (const line of lines) {
                    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                      const parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
                      if (parsed.usage && typeof parsed.usage === 'object') {
                        const usage = parsed.usage as Record<string, unknown>;
                        if (typeof usage.prompt_tokens === 'number') inputTokens = usage.prompt_tokens;
                        if (typeof usage.completion_tokens === 'number') outputTokens = usage.completion_tokens;
                      }
                    }
                  }
                } catch {
                  // Ignore parse errors in usage extraction.
                }
              }
            }
          } catch (err) {
            streamFailed = true;
            deps.logger?.error('ai_text_stream_error', {
              user_id: userId,
              session_id: sessionId,
              operation_type: 'text',
              model_id: modelSlug,
              error_type: (err as Error).name === 'AbortError' ? 'timeout' : 'stream_error',
            });
          } finally {
            clearTimeout(timeout);
            streamController.close();

            await writeUsageRow(deps.pool, {
              userId,
              sessionId,
              now: getNow(),
              modelId: modelSlug,
              status: streamFailed ? 'failed' : 'success',
              upstreamHttpStatus: upstreamStatus,
              idempotencyKey,
              inputTokens,
              outputTokens,
            });

            deps.logger?.info('ai_operation_complete', {
              user_id: userId,
              session_id: sessionId,
              operation_type: 'text',
              model_id: modelSlug,
              status: streamFailed ? 'failed' : 'success',
              latency_ms: Date.now() - startTime,
              upstream_http_status: upstreamStatus,
              idempotency_key: idempotencyKey,
            });
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
    }

    // --- 7. All candidates failed ---
    const status = lastErrorCode === 'provider_key_unavailable' ? 503 : 502;
    const message =
      lastErrorCode === 'provider_key_unavailable'
        ? 'AI provider is currently unavailable'
        : 'all configured AI providers failed';
    return c.json({ error: { code: lastErrorCode, message } }, status);
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
 * Write a usage row to the `usage` table. Records the terminal status of an
 * AI operation (success or failed) per Requirement 9.1. Errors are swallowed:
 * usage rows are observability data and must not fail the request.
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
  }
}
