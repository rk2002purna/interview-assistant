/**
 * Admin Speech-to-Text (STT) model configuration endpoint.
 *
 * Stores the global Whisper model (and an optional fallback) used for audio
 * transcription in the app_config key-value table under the key 'stt_model'.
 * All STT runs on Groq's Whisper API, so the choices are Groq-hosted Whisper
 * model IDs. `/ai/audio` reads this config and tries the primary model, then
 * the fallback if the primary's upstream call fails.
 *
 * Endpoints:
 *   GET  /config/stt  — public read (for desktop clients)
 *   GET  /admin/stt   — read current config (admin only)
 *   PUT  /admin/stt   — update config (admin only)
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { verifyAccess, JwtError } from '../auth/jwt.js';

export interface SttConfigRouterDeps {
  readonly pool: Pool;
}

/**
 * Groq-hosted Whisper models available for transcription.
 * Keep this list in sync with the admin dashboard STT page.
 */
export const ALLOWED_STT_MODELS = [
  'whisper-large-v3-turbo',
  'whisper-large-v3',
] as const;

export const DEFAULT_STT_MODEL = 'whisper-large-v3-turbo';
export const DEFAULT_STT_FALLBACK_MODEL = 'whisper-large-v3';

const APP_CONFIG_KEY = 'stt_model';

interface SttConfig {
  model: string;
  /** Optional secondary model tried when the primary upstream call fails. */
  fallbackModel: string | null;
}

function isAllowedSttModel(model: string): boolean {
  return (ALLOWED_STT_MODELS as readonly string[]).includes(model);
}

function readSttConfig(value: string | undefined): SttConfig {
  if (!value) {
    return { model: DEFAULT_STT_MODEL, fallbackModel: DEFAULT_STT_FALLBACK_MODEL };
  }
  try {
    const parsed = JSON.parse(value) as { model?: unknown; fallbackModel?: unknown };
    const model =
      typeof parsed.model === 'string' && parsed.model.trim()
        ? parsed.model.trim()
        : DEFAULT_STT_MODEL;
    const fallbackModel =
      typeof parsed.fallbackModel === 'string' && parsed.fallbackModel.trim()
        ? parsed.fallbackModel.trim()
        : null;
    return { model, fallbackModel };
  } catch {
    return { model: DEFAULT_STT_MODEL, fallbackModel: DEFAULT_STT_FALLBACK_MODEL };
  }
}

/**
 * Verify the request carries a valid admin access token.
 */
async function requireAdmin(
  authHeader: string | undefined,
): Promise<{ ok: true } | { ok: false; status: 401 | 403; code: string; message: string }> {
  if (!authHeader) {
    return { ok: false, status: 401, code: 'unauthenticated', message: 'missing Authorization header' };
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  if (!match) {
    return { ok: false, status: 401, code: 'unauthenticated', message: 'malformed Authorization header' };
  }
  try {
    const claims = await verifyAccess(match[1]!);
    if (claims.role !== 'admin') {
      return { ok: false, status: 403, code: 'forbidden', message: 'admin role required' };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof JwtError) {
      return { ok: false, status: 401, code: 'unauthenticated', message: err.message };
    }
    throw err;
  }
}

export function buildSttConfigRouter(deps: SttConfigRouterDeps): Hono {
  const router = new Hono();

  // Public endpoint for desktop clients to fetch the configured STT model.
  router.get('/config/stt', async (c) => {
    const result = await deps.pool.query<{ value: string }>(
      `SELECT value FROM app_config WHERE key = $1 LIMIT 1`,
      [APP_CONFIG_KEY],
    );
    const row = result.rows[0];
    return c.json({ stt: readSttConfig(row?.value), allowed: ALLOWED_STT_MODELS });
  });

  // Admin read
  router.get('/admin/stt', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'));
    if (!auth.ok) {
      return c.json({ error: { code: auth.code, message: auth.message } }, auth.status);
    }

    const result = await deps.pool.query<{ value: string }>(
      `SELECT value FROM app_config WHERE key = $1 LIMIT 1`,
      [APP_CONFIG_KEY],
    );
    const row = result.rows[0];
    return c.json({ stt: readSttConfig(row?.value), allowed: ALLOWED_STT_MODELS });
  });

  // Admin write
  router.put('/admin/stt', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'));
    if (!auth.ok) {
      return c.json({ error: { code: auth.code, message: auth.message } }, auth.status);
    }

    const body = (await c.req.json().catch(() => null)) as
      | { stt?: { model?: unknown; fallbackModel?: unknown } }
      | null;

    const model = body?.stt?.model;
    if (typeof model !== 'string' || !model.trim()) {
      return c.json({ error: { code: 'invalid_input', message: 'stt.model is required' } }, 400);
    }
    const trimmedModel = model.trim();
    if (!isAllowedSttModel(trimmedModel)) {
      return c.json(
        {
          error: {
            code: 'invalid_input',
            message: `stt.model must be one of: ${ALLOWED_STT_MODELS.join(', ')}`,
          },
        },
        400,
      );
    }

    // Fallback is optional. Empty string / null / "none" clears it.
    const rawFallback = body?.stt?.fallbackModel;
    let fallbackModel: string | null = null;
    if (typeof rawFallback === 'string' && rawFallback.trim() && rawFallback.trim() !== 'none') {
      const trimmedFallback = rawFallback.trim();
      if (!isAllowedSttModel(trimmedFallback)) {
        return c.json(
          {
            error: {
              code: 'invalid_input',
              message: `stt.fallbackModel must be one of: ${ALLOWED_STT_MODELS.join(', ')}`,
            },
          },
          400,
        );
      }
      // A fallback identical to the primary is pointless; store null instead.
      fallbackModel = trimmedFallback === trimmedModel ? null : trimmedFallback;
    }

    const stored: SttConfig = { model: trimmedModel, fallbackModel };
    await deps.pool.query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ($2, $1, now())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
      [JSON.stringify(stored), APP_CONFIG_KEY],
    );

    return c.json({ stt: stored, allowed: ALLOWED_STT_MODELS });
  });

  return router;
}
