/**
 * Admin Speech-to-Text (STT) model configuration endpoint.
 *
 * Stores the global Whisper model used for audio transcription in the
 * app_config key-value table under the key 'stt_model'. All STT runs on
 * Groq's Whisper API, so the choices are Groq-hosted Whisper model IDs.
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

export const DEFAULT_STT_MODEL = 'whisper-large-v3';

const APP_CONFIG_KEY = 'stt_model';

interface SttConfig {
  model: string;
}

function readSttConfig(value: string | undefined): SttConfig {
  if (!value) return { model: DEFAULT_STT_MODEL };
  try {
    const parsed = JSON.parse(value) as { model?: unknown };
    if (parsed && typeof parsed.model === 'string' && parsed.model.trim()) {
      return { model: parsed.model.trim() };
    }
  } catch {
    // Fall through to default on malformed JSON.
  }
  return { model: DEFAULT_STT_MODEL };
}

/**
 * Verify the request carries a valid admin access token.
 * Returns a Response to short-circuit on failure, or null when authorized.
 */
async function requireAdmin(authHeader: string | undefined): Promise<{ ok: true } | { ok: false; status: 401 | 403; code: string; message: string }> {
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
    const result = await deps.pool.query(
      `SELECT value FROM app_config WHERE key = '${APP_CONFIG_KEY}' LIMIT 1`,
    );
    const row = result.rows[0] as { value: string } | undefined;
    return c.json({ stt: readSttConfig(row?.value), allowed: ALLOWED_STT_MODELS });
  });

  // Admin read
  router.get('/admin/stt', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'));
    if (!auth.ok) {
      return c.json({ error: { code: auth.code, message: auth.message } }, auth.status);
    }

    const result = await deps.pool.query(
      `SELECT value FROM app_config WHERE key = '${APP_CONFIG_KEY}' LIMIT 1`,
    );
    const row = result.rows[0] as { value: string } | undefined;
    return c.json({ stt: readSttConfig(row?.value), allowed: ALLOWED_STT_MODELS });
  });

  // Admin write
  router.put('/admin/stt', async (c) => {
    const auth = await requireAdmin(c.req.header('Authorization'));
    if (!auth.ok) {
      return c.json({ error: { code: auth.code, message: auth.message } }, auth.status);
    }

    const body = await c.req.json().catch(() => null) as { stt?: { model?: unknown } } | null;
    const model = body?.stt?.model;
    if (typeof model !== 'string' || !model.trim()) {
      return c.json({ error: { code: 'invalid_input', message: 'stt.model is required' } }, 400);
    }
    const trimmed = model.trim();
    if (!(ALLOWED_STT_MODELS as readonly string[]).includes(trimmed)) {
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

    await deps.pool.query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('${APP_CONFIG_KEY}', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
      [JSON.stringify({ model: trimmed })],
    );

    return c.json({ stt: { model: trimmed }, allowed: ALLOWED_STT_MODELS });
  });

  return router;
}
