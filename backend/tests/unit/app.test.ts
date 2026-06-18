import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

describe('buildApp', () => {
  it('returns a Hono app instance whose fetch responds to /health', async () => {
    const app = buildApp();

    const res = await app.request('/health');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });

  it('does not bind to a network socket', () => {
    // buildApp must not call listen; constructing two apps in one process
    // should never throw EADDRINUSE.
    expect(() => {
      buildApp();
      buildApp();
    }).not.toThrow();
  });
});
