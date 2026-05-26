/**
 * Admin model routing configuration endpoint.
 *
 * Stores the global AI model routing config (which providers/models to use
 * for text and vision) in a simple key-value table. Desktop clients fetch
 * this on startup to know which models to request.
 *
 * Endpoints:
 *   GET  /admin/model-routing  — read current config
 *   PUT  /admin/model-routing  — update config (admin only)
 *   GET  /config/model-routing — public read (for desktop clients)
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { verifyAccess, JwtError } from '../auth/jwt.js';

export interface ModelRoutingRouterDeps {
  readonly pool: Pool;
}

const DEFAULT_ROUTING = {
  textPrimary: { provider: 'gemini', model: 'gemini-flash-latest' },
  textFallback: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  visionPrimary: { provider: 'gemini', model: 'gemini-flash-latest' },
  visionFallback: { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
};

export function buildModelRoutingRouter(deps: ModelRoutingRouterDeps): Hono {
  const router = new Hono();

  // Public endpoint for desktop clients to fetch routing config
  router.get('/config/model-routing', async (c) => {
    const result = await deps.pool.query(
      `SELECT value FROM app_config WHERE key = 'model_routing' LIMIT 1`,
    );
    const row = result.rows[0] as { value: string } | undefined;
    if (!row) {
      return c.json({ routing: DEFAULT_ROUTING });
    }
    return c.json({ routing: JSON.parse(row.value) });
  });

  // Admin read
  router.get('/admin/model-routing', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      return c.json({ error: { code: 'unauthenticated', message: 'missing Authorization header' } }, 401);
    }
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!match) {
      return c.json({ error: { code: 'unauthenticated', message: 'malformed Authorization header' } }, 401);
    }
    try {
      const claims = await verifyAccess(match[1]!);
      if (claims.role !== 'admin') {
        return c.json({ error: { code: 'forbidden', message: 'admin role required' } }, 403);
      }
    } catch (err) {
      if (err instanceof JwtError) {
        return c.json({ error: { code: 'unauthenticated', message: err.message } }, 401);
      }
      throw err;
    }

    const result = await deps.pool.query(
      `SELECT value FROM app_config WHERE key = 'model_routing' LIMIT 1`,
    );
    const row = result.rows[0] as { value: string } | undefined;
    if (!row) {
      return c.json({ routing: DEFAULT_ROUTING });
    }
    return c.json({ routing: JSON.parse(row.value) });
  });

  // Admin write
  router.put('/admin/model-routing', async (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      return c.json({ error: { code: 'unauthenticated', message: 'missing Authorization header' } }, 401);
    }
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!match) {
      return c.json({ error: { code: 'unauthenticated', message: 'malformed Authorization header' } }, 401);
    }
    try {
      const claims = await verifyAccess(match[1]!);
      if (claims.role !== 'admin') {
        return c.json({ error: { code: 'forbidden', message: 'admin role required' } }, 403);
      }
    } catch (err) {
      if (err instanceof JwtError) {
        return c.json({ error: { code: 'unauthenticated', message: err.message } }, 401);
      }
      throw err;
    }

    const body = await c.req.json() as { routing: unknown };
    if (!body.routing || typeof body.routing !== 'object') {
      return c.json({ error: { code: 'invalid_input', message: 'routing object is required' } }, 400);
    }

    await deps.pool.query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('model_routing', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
      [JSON.stringify(body.routing)],
    );

    return c.json({ routing: body.routing });
  });

  return router;
}
