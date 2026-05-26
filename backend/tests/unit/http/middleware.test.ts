import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { signAccessToken } from '../../../src/auth/jwt.js';
import {
  buildVersionGate,
  clientIdGate,
  jwtAuth,
  rateLimit,
  requireRole,
  type ClientIdMismatchHandler,
  type MiddlewareVariables,
  type RateLimiter,
} from '../../../src/http/middleware.js';

const TEST_SECRET = 'test-secret-please-change-' + 'x'.repeat(40);

type AppEnv = { Variables: MiddlewareVariables };

function newApp() {
  return new Hono<AppEnv>();
}

async function readEnvelope(res: Response) {
  return (await res.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } };
}

describe('clientIdGate', () => {
  it('rejects requests missing X-Client-Id with 400 missing_client_id', async () => {
    const app = newApp().use('*', clientIdGate()).get('/x', (c) => c.text('ok'));
    const res = await app.request('/x');
    expect(res.status).toBe(400);
    expect((await readEnvelope(res)).error.code).toBe('missing_client_id');
  });

  it('rejects non-UUIDv4 X-Client-Id with 400 missing_client_id', async () => {
    const app = newApp().use('*', clientIdGate()).get('/x', (c) => c.text('ok'));
    // valid v3 UUID (third group starts with 3, not 4) — must be rejected
    const v3Uuid = '6fa459ea-ee8a-3ca4-894e-db77e160355e';
    const res = await app.request('/x', { headers: { 'X-Client-Id': v3Uuid } });
    expect(res.status).toBe(400);
    expect((await readEnvelope(res)).error.code).toBe('missing_client_id');
  });

  it('accepts a valid v4 UUID and publishes c.var.clientId', async () => {
    const id = randomUUID();
    let seen: string | undefined;
    const app = newApp()
      .use('*', clientIdGate())
      .get('/x', (c) => {
        seen = c.get('clientId');
        return c.text('ok');
      });
    const res = await app.request('/x', { headers: { 'X-Client-Id': id } });
    expect(res.status).toBe(200);
    expect(seen).toBe(id);
  });

  it('returns the uniform error envelope shape', async () => {
    const app = newApp().use('*', clientIdGate()).get('/x', (c) => c.text('ok'));
    const res = await app.request('/x');
    const body = await readEnvelope(res);
    expect(body).toEqual({ error: { code: 'missing_client_id', message: expect.any(String) } });
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });
});

describe('buildVersionGate', () => {
  const headers = (extra: Record<string, string> = {}) => ({
    'X-Client-Id': randomUUID(),
    ...extra,
  });

  it('rejects missing X-Build-Version with 426 client_upgrade_required', async () => {
    const app = newApp()
      .use('*', clientIdGate())
      .use('*', buildVersionGate({ minVersion: '1.0.0' }))
      .get('/x', (c) => c.text('ok'));
    const res = await app.request('/x', { headers: headers() });
    expect(res.status).toBe(426);
    const body = await readEnvelope(res);
    expect(body.error.code).toBe('client_upgrade_required');
    expect(body.error.details).toEqual({ min_build_version: '1.0.0' });
  });

  it('rejects builds older than the minimum', async () => {
    const app = newApp()
      .use('*', clientIdGate())
      .use('*', buildVersionGate({ minVersion: '2.0.0' }))
      .get('/x', (c) => c.text('ok'));
    const res = await app.request('/x', { headers: headers({ 'X-Build-Version': '1.9.99' }) });
    expect(res.status).toBe(426);
    expect((await readEnvelope(res)).error.code).toBe('client_upgrade_required');
  });

  it('accepts builds equal to or above the minimum', async () => {
    const app = newApp()
      .use('*', clientIdGate())
      .use('*', buildVersionGate({ minVersion: '1.2.3' }))
      .get('/x', (c) => c.text('ok'));
    for (const v of ['1.2.3', '1.2.4', '2.0.0', 'v1.5.0', '1.2.3-beta.1']) {
      const res = await app.request('/x', { headers: headers({ 'X-Build-Version': v }) });
      expect(res.status, `version ${v}`).toBe(200);
    }
  });

  it('rejects malformed build version strings', async () => {
    const app = newApp()
      .use('*', clientIdGate())
      .use('*', buildVersionGate({ minVersion: '1.0.0' }))
      .get('/x', (c) => c.text('ok'));
    for (const v of ['', 'abc', '1', '1.0', 'v.x.y']) {
      const res = await app.request('/x', { headers: headers({ 'X-Build-Version': v }) });
      expect(res.status, `version ${JSON.stringify(v)}`).toBe(426);
    }
  });

  it('reads MIN_BUILD_VERSION from env when no minVersion option is given', async () => {
    const prev = process.env['MIN_BUILD_VERSION'];
    process.env['MIN_BUILD_VERSION'] = '3.0.0';
    try {
      const app = newApp()
        .use('*', clientIdGate())
        .use('*', buildVersionGate())
        .get('/x', (c) => c.text('ok'));
      const low = await app.request('/x', { headers: headers({ 'X-Build-Version': '2.5.0' }) });
      expect(low.status).toBe(426);
      const ok = await app.request('/x', { headers: headers({ 'X-Build-Version': '3.0.0' }) });
      expect(ok.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env['MIN_BUILD_VERSION'];
      else process.env['MIN_BUILD_VERSION'] = prev;
    }
  });
});

describe('jwtAuth', () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env['JWT_SECRET'];
    process.env['JWT_SECRET'] = TEST_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env['JWT_SECRET'];
    else process.env['JWT_SECRET'] = originalSecret;
  });

  function chain(extra?: { onClientIdMismatch?: ClientIdMismatchHandler }) {
    const app = newApp()
      .use('*', clientIdGate())
      .use('*', buildVersionGate({ minVersion: '1.0.0' }))
      .use('*', jwtAuth(extra ?? {}))
      .get('/secure', (c) =>
        c.json({ userId: c.get('userId'), role: c.get('role'), clientId: c.get('clientId') }),
      );
    return app;
  }

  function fullHeaders(token: string, clientId: string): Record<string, string> {
    return {
      'X-Client-Id': clientId,
      'X-Build-Version': '1.0.0',
      Authorization: `Bearer ${token}`,
    };
  }

  it('rejects missing Authorization header with 401 unauthenticated', async () => {
    const app = chain();
    const res = await app.request('/secure', {
      headers: { 'X-Client-Id': randomUUID(), 'X-Build-Version': '1.0.0' },
    });
    expect(res.status).toBe(401);
    expect((await readEnvelope(res)).error.code).toBe('unauthenticated');
  });

  it('rejects malformed Authorization header', async () => {
    const app = chain();
    const res = await app.request('/secure', {
      headers: {
        'X-Client-Id': randomUUID(),
        'X-Build-Version': '1.0.0',
        Authorization: 'Token abc',
      },
    });
    expect(res.status).toBe(401);
    expect((await readEnvelope(res)).error.code).toBe('unauthenticated');
  });

  it('rejects expired tokens with 401 unauthenticated', async () => {
    const clientId = randomUUID();
    const past = Math.floor(Date.now() / 1000) - 60 * 60 - 60;
    const { token } = await signAccessToken({
      sub: 'user-1',
      role: 'user',
      clientId,
      nowSeconds: past,
    });
    const app = chain();
    const res = await app.request('/secure', { headers: fullHeaders(token, clientId) });
    expect(res.status).toBe(401);
    expect((await readEnvelope(res)).error.code).toBe('unauthenticated');
  });

  it('rejects invalid signatures with 401 unauthenticated', async () => {
    const clientId = randomUUID();
    const { token } = await signAccessToken({ sub: 'u', role: 'user', clientId });
    const tampered = token.slice(0, -4) + 'AAAA';
    const app = chain();
    const res = await app.request('/secure', { headers: fullHeaders(tampered, clientId) });
    expect(res.status).toBe(401);
  });

  it('accepts a valid token and publishes claims on context', async () => {
    const clientId = randomUUID();
    const { token } = await signAccessToken({ sub: 'user-7', role: 'admin', clientId });
    const app = chain();
    const res = await app.request('/secure', { headers: fullHeaders(token, clientId) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'user-7', role: 'admin', clientId });
  });

  it('rejects with 401 client_id_mismatch when X-Client-Id differs from the token claim', async () => {
    const issuingClientId = randomUUID();
    const presentingClientId = randomUUID();
    const { token } = await signAccessToken({
      sub: 'user-mismatch',
      role: 'user',
      clientId: issuingClientId,
    });
    const onMismatch: ClientIdMismatchHandler = vi.fn(async () => {});
    const app = chain({ onClientIdMismatch: onMismatch });
    const res = await app.request('/secure', {
      headers: fullHeaders(token, presentingClientId),
    });
    expect(res.status).toBe(401);
    const body = await readEnvelope(res);
    expect(body.error.code).toBe('client_id_mismatch');
    const mock = onMismatch as unknown as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    const arg = mock.mock.calls[0]?.[0] as
      | { userId: string; issuingClientId: string; presentingClientId: string; jti: string }
      | undefined;
    expect(arg).toBeDefined();
    expect(arg!.userId).toBe('user-mismatch');
    expect(arg!.issuingClientId).toBe(issuingClientId);
    expect(arg!.presentingClientId).toBe(presentingClientId);
    expect(typeof arg!.jti).toBe('string');
  });

  it('still returns 401 client_id_mismatch when the audit handler throws', async () => {
    const issuing = randomUUID();
    const presenting = randomUUID();
    const { token } = await signAccessToken({ sub: 'u', role: 'user', clientId: issuing });
    const onMismatch = vi.fn(async () => {
      throw new Error('audit write failed');
    });
    const app = chain({ onClientIdMismatch: onMismatch });
    const res = await app.request('/secure', { headers: fullHeaders(token, presenting) });
    expect(res.status).toBe(401);
    expect((await readEnvelope(res)).error.code).toBe('client_id_mismatch');
  });
});

describe('requireRole', () => {
  let originalSecret: string | undefined;
  beforeEach(() => {
    originalSecret = process.env['JWT_SECRET'];
    process.env['JWT_SECRET'] = TEST_SECRET;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env['JWT_SECRET'];
    else process.env['JWT_SECRET'] = originalSecret;
  });

  function adminApp() {
    return newApp()
      .use('*', clientIdGate())
      .use('*', buildVersionGate({ minVersion: '1.0.0' }))
      .use('*', jwtAuth())
      .use('*', requireRole('admin'))
      .get('/admin/x', (c) => c.json({ ok: true }))
      .get('/admin/missing/:id', (c) => c.json({ ok: true, id: c.req.param('id') }));
  }

  function authHeaders(token: string, clientId: string) {
    return {
      'X-Client-Id': clientId,
      'X-Build-Version': '1.0.0',
      Authorization: `Bearer ${token}`,
    };
  }

  it('rejects callers whose role claim is not admin with 403 forbidden_role', async () => {
    const clientId = randomUUID();
    const { token } = await signAccessToken({ sub: 'u', role: 'user', clientId });
    const res = await adminApp().request('/admin/x', { headers: authHeaders(token, clientId) });
    expect(res.status).toBe(403);
    expect((await readEnvelope(res)).error.code).toBe('forbidden_role');
  });

  it('returns identical 403 envelope regardless of resource existence (Property 14 shape)', async () => {
    const clientId = randomUUID();
    const { token } = await signAccessToken({ sub: 'u', role: 'user', clientId });
    const a = await adminApp().request('/admin/x', { headers: authHeaders(token, clientId) });
    const b = await adminApp().request('/admin/missing/does-not-exist', {
      headers: authHeaders(token, clientId),
    });
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });

  it('admits callers with role=admin', async () => {
    const clientId = randomUUID();
    const { token } = await signAccessToken({ sub: 'admin-1', role: 'admin', clientId });
    const res = await adminApp().request('/admin/x', { headers: authHeaders(token, clientId) });
    expect(res.status).toBe(200);
  });
});

describe('rateLimit', () => {
  let originalSecret: string | undefined;
  beforeEach(() => {
    originalSecret = process.env['JWT_SECRET'];
    process.env['JWT_SECRET'] = TEST_SECRET;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env['JWT_SECRET'];
    else process.env['JWT_SECRET'] = originalSecret;
  });

  function build(limiter: RateLimiter) {
    return newApp()
      .use('*', clientIdGate())
      .use('*', buildVersionGate({ minVersion: '1.0.0' }))
      .use('*', jwtAuth())
      .use('*', rateLimit({ limiter, kind: 'ai_op' }))
      .get('/ai/text', (c) => c.json({ ok: true }));
  }

  async function authedHeaders() {
    const clientId = randomUUID();
    const { token } = await signAccessToken({ sub: 'user-rl', role: 'user', clientId });
    return {
      headers: {
        'X-Client-Id': clientId,
        'X-Build-Version': '1.0.0',
        Authorization: `Bearer ${token}`,
      },
    };
  }

  it('allows the request when limiter.check returns allowed', async () => {
    const limiter: RateLimiter = { check: vi.fn(async () => ({ allowed: true })) };
    const app = build(limiter);
    const { headers } = await authedHeaders();
    const res = await app.request('/ai/text', { headers });
    expect(res.status).toBe(200);
    expect(limiter.check).toHaveBeenCalledTimes(1);
    const arg = (limiter.check as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { userId: string; kind: string }
      | undefined;
    expect(arg?.userId).toBe('user-rl');
    expect(arg?.kind).toBe('ai_op');
  });

  it('returns 429 rate_limited with Retry-After when limiter denies', async () => {
    const limiter: RateLimiter = {
      check: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 7 })),
    };
    const app = build(limiter);
    const { headers } = await authedHeaders();
    const res = await app.request('/ai/text', { headers });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
    const body = await readEnvelope(res);
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.details).toEqual({ retry_after: 7 });
  });

  it('rounds up fractional retryAfterSeconds and floors to 1', async () => {
    const limiter: RateLimiter = {
      check: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 0.2 })),
    };
    const app = build(limiter);
    const { headers } = await authedHeaders();
    const res = await app.request('/ai/text', { headers });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('1');
  });

  it('forwards client IP from X-Forwarded-For first hop', async () => {
    const check = vi.fn(async () => ({ allowed: true }));
    const limiter: RateLimiter = { check };
    const app = build(limiter);
    const { headers } = await authedHeaders();
    const res = await app.request('/ai/text', {
      headers: { ...headers, 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' },
    });
    expect(res.status).toBe(200);
    const calls = (check as unknown as ReturnType<typeof vi.fn>).mock.calls as ReadonlyArray<
      readonly unknown[]
    >;
    const firstCall = calls[0]?.[0] as { ip?: string } | undefined;
    expect(firstCall?.ip).toBe('203.0.113.7');
  });

  it('fails closed with 401 when rate limit runs without an authenticated user', async () => {
    const limiter: RateLimiter = { check: vi.fn(async () => ({ allowed: true })) };
    const app = newApp()
      .use('*', clientIdGate())
      .use('*', rateLimit({ limiter, kind: 'ai_op' }))
      .get('/x', (c) => c.text('ok'));
    const res = await app.request('/x', { headers: { 'X-Client-Id': randomUUID() } });
    expect(res.status).toBe(401);
    expect(limiter.check).not.toHaveBeenCalled();
  });
});

describe('full chain ordering', () => {
  let originalSecret: string | undefined;
  beforeEach(() => {
    originalSecret = process.env['JWT_SECRET'];
    process.env['JWT_SECRET'] = TEST_SECRET;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env['JWT_SECRET'];
    else process.env['JWT_SECRET'] = originalSecret;
  });

  it('client-id failure short-circuits before build-version, jwt, role, and rate limit', async () => {
    const limiter: RateLimiter = { check: vi.fn(async () => ({ allowed: true })) };
    const app = newApp()
      .use('*', clientIdGate())
      .use('*', buildVersionGate({ minVersion: '1.0.0' }))
      .use('*', jwtAuth())
      .use('*', requireRole('admin'))
      .use('*', rateLimit({ limiter, kind: 'ai_op' }))
      .get('/x', (c) => c.text('ok'));
    const res = await app.request('/x'); // no headers at all
    expect(res.status).toBe(400);
    expect((await readEnvelope(res)).error.code).toBe('missing_client_id');
    expect(limiter.check).not.toHaveBeenCalled();
  });

  it('build-version failure short-circuits before jwt verification', async () => {
    const limiter: RateLimiter = { check: vi.fn(async () => ({ allowed: true })) };
    const app = newApp()
      .use('*', clientIdGate())
      .use('*', buildVersionGate({ minVersion: '5.0.0' }))
      .use('*', jwtAuth())
      .use('*', rateLimit({ limiter, kind: 'ai_op' }))
      .get('/x', (c) => c.text('ok'));
    // Send a syntactically valid token; if jwtAuth ran it would still
    // succeed, so a 426 here proves buildVersionGate runs first.
    const clientId = randomUUID();
    const { token } = await signAccessToken({ sub: 'u', role: 'user', clientId });
    const res = await app.request('/x', {
      headers: {
        'X-Client-Id': clientId,
        'X-Build-Version': '1.0.0',
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(426);
    expect(limiter.check).not.toHaveBeenCalled();
  });

  it('role failure short-circuits before rate limit', async () => {
    const limiter: RateLimiter = { check: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 1 })) };
    const clientId = randomUUID();
    const { token } = await signAccessToken({ sub: 'u', role: 'user', clientId });
    const app = newApp()
      .use('*', clientIdGate())
      .use('*', buildVersionGate({ minVersion: '1.0.0' }))
      .use('*', jwtAuth())
      .use('*', requireRole('admin'))
      .use('*', rateLimit({ limiter, kind: 'ai_op' }))
      .get('/x', (c) => c.text('ok'));
    const res = await app.request('/x', {
      headers: {
        'X-Client-Id': clientId,
        'X-Build-Version': '1.0.0',
        Authorization: `Bearer ${token}`,
      },
    });
    expect(res.status).toBe(403);
    expect(limiter.check).not.toHaveBeenCalled();
  });
});
