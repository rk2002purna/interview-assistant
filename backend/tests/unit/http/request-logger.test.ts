import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { Logger, createMemorySink, type LogRecord } from '../../../src/log/logger.js';
import { requestLogger } from '../../../src/http/request-logger.js';

/**
 * Unit tests for the request-logging middleware. Each test builds a tiny
 * Hono app with the middleware mounted outermost (as buildApp does), a
 * memory-sink logger so records can be asserted, and a fake monotonic
 * clock so latency is deterministic.
 */

function setup() {
  const { sink, records } = createMemorySink();
  // debug level so info/warn/error all pass the threshold.
  const logger = new Logger({ sink, minLevel: 'debug' });
  let t = 1000;
  const now = () => {
    t += 5; // each call advances 5ms
    return t;
  };
  const app = new Hono();
  app.use('*', requestLogger({ logger, now }));
  return { app, records };
}

function lastRequestRecord(records: LogRecord[]): LogRecord | undefined {
  return [...records].reverse().find((r) => r.message === 'http_request');
}

describe('requestLogger middleware', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('logs one record for a successful request with core fields', async () => {
    ctx.app.get('/packs', (c) => c.json({ ok: true }));

    const res = await ctx.app.request('/packs');

    expect(res.status).toBe(200);
    const rec = lastRequestRecord(ctx.records);
    expect(rec).toBeDefined();
    expect(rec?.level).toBe('info');
    expect(rec?.method).toBe('GET');
    expect(rec?.route).toBe('/packs');
    expect(rec?.path).toBe('/packs');
    expect(rec?.status).toBe(200);
    expect(rec?.outcome).toBe('success');
    expect(rec?.error_code).toBeNull();
    expect(typeof rec?.latency_ms).toBe('number');
    expect(rec?.request_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('sets an X-Request-Id response header matching the logged id', async () => {
    ctx.app.get('/packs', (c) => c.json({ ok: true }));

    const res = await ctx.app.request('/packs');
    const header = res.headers.get('X-Request-Id');

    expect(header).toBeTruthy();
    const rec = lastRequestRecord(ctx.records);
    expect(rec?.request_id).toBe(header);
  });

  it('honors a valid incoming X-Request-Id', async () => {
    ctx.app.get('/packs', (c) => c.json({ ok: true }));
    const incoming = '11111111-2222-3333-4444-555555555555';

    const res = await ctx.app.request('/packs', {
      headers: { 'X-Request-Id': incoming },
    });

    expect(res.headers.get('X-Request-Id')).toBe(incoming);
    expect(lastRequestRecord(ctx.records)?.request_id).toBe(incoming);
  });

  it('classifies 4xx responses as failures with a stable error code', async () => {
    ctx.app.get('/missing', (c) => c.json({ error: 'nope' }, 404));

    const res = await ctx.app.request('/missing');

    expect(res.status).toBe(404);
    const rec = lastRequestRecord(ctx.records);
    expect(rec?.level).toBe('warn');
    expect(rec?.outcome).toBe('failure');
    expect(rec?.status).toBe(404);
    expect(rec?.error_code).toBe('not_found');
  });

  it('records a thrown handler as a 500 failure and re-throws', async () => {
    ctx.app.get('/boom', () => {
      throw new Error('kaboom');
    });
    // App-level error handler mirrors buildApp so the request resolves.
    ctx.app.onError((_err, c) => c.json({ error: 'internal' }, 500));

    const res = await ctx.app.request('/boom');

    expect(res.status).toBe(500);
    const rec = lastRequestRecord(ctx.records);
    expect(rec?.level).toBe('error');
    expect(rec?.status).toBe(500);
    expect(rec?.outcome).toBe('failure');
    expect(rec?.error_code).toBe('internal_error');
    // The exception message must never appear in the record.
    expect(JSON.stringify(rec)).not.toContain('kaboom');
  });

  it('does not log skipped paths like /health', async () => {
    ctx.app.get('/health', (c) => c.json({ status: 'ok' }));

    const res = await ctx.app.request('/health');

    expect(res.status).toBe(200);
    expect(lastRequestRecord(ctx.records)).toBeUndefined();
  });

  it('does not log CORS preflight OPTIONS requests', async () => {
    ctx.app.get('/packs', (c) => c.json({ ok: true }));

    const res = await ctx.app.request('/packs', { method: 'OPTIONS' });

    expect(lastRequestRecord(ctx.records)).toBeUndefined();
    // still tagged for correlation
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('never logs the Authorization header value', async () => {
    ctx.app.get('/packs', (c) => c.json({ ok: true }));

    await ctx.app.request('/packs', {
      headers: { Authorization: 'Bearer super-secret-token' },
    });

    const rec = lastRequestRecord(ctx.records);
    expect(JSON.stringify(rec)).not.toContain('super-secret-token');
  });
});
