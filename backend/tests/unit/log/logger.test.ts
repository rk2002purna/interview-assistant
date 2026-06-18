import { describe, expect, it } from 'vitest';
import {
  Logger,
  REDACTED,
  createMemorySink,
  redact,
} from '../../../src/log/logger.js';

describe('Logger', () => {
  it('emits a JSON-shaped record with level, message, timestamp, and bindings', () => {
    const { sink, records } = createMemorySink();
    const fixedClock = () => new Date('2024-01-02T03:04:05.678Z');
    const log = new Logger({ sink, clock: fixedClock, minLevel: 'debug' });

    log.info('user_logged_in', { user_id: 'u1' });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info',
      message: 'user_logged_in',
      timestamp: '2024-01-02T03:04:05.678Z',
      user_id: 'u1',
    });
  });

  it('respects minLevel filter (debug records are dropped at info level)', () => {
    const { sink, records } = createMemorySink();
    const log = new Logger({ sink, minLevel: 'info' });

    log.debug('not_emitted');
    log.info('emitted');

    expect(records.map((r) => r.message)).toEqual(['emitted']);
  });

  it('redacts known secret keys at the top level', () => {
    const { sink, records } = createMemorySink();
    const log = new Logger({ sink, minLevel: 'debug' });

    log.info('provider_call', {
      provider_key: 'sk-supersecret-abc123',
      password: 'hunter2',
      refresh_token: 'rt-very-long-string',
      keep_me: 'visible',
    });

    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.provider_key).toBe(REDACTED);
    expect(r.password).toBe(REDACTED);
    expect(r.refresh_token).toBe(REDACTED);
    expect(r.keep_me).toBe('visible');
  });

  it('redacts secret keys nested inside arrays and objects', () => {
    const { sink, records } = createMemorySink();
    const log = new Logger({ sink, minLevel: 'debug' });

    log.info('nested', {
      headers: {
        Authorization: 'Bearer abc',
        'X-Trace': 'visible',
      },
      attempts: [
        { password: 'p1' },
        { password: 'p2', user: 'u1' },
      ],
      providers: { gemini: { provider_key: 'gem-secret', last4: '1234' } },
    });

    const r = records[0]! as unknown as {
      headers: Record<string, unknown>;
      attempts: Array<Record<string, unknown>>;
      providers: { gemini: Record<string, unknown> };
    };

    expect(r.headers.Authorization).toBe(REDACTED);
    expect(r.headers['X-Trace']).toBe('visible');
    expect(r.attempts[0]!.password).toBe(REDACTED);
    expect(r.attempts[1]!.password).toBe(REDACTED);
    expect(r.attempts[1]!.user).toBe('u1');
    expect(r.providers.gemini.provider_key).toBe(REDACTED);
    expect(r.providers.gemini.last4).toBe('1234');
  });

  it('redaction is case-insensitive on key names', () => {
    const { sink, records } = createMemorySink();
    const log = new Logger({ sink, minLevel: 'debug' });

    log.info('mixed_case', {
      Provider_Key: 'a',
      PASSWORD: 'b',
      RefreshToken: 'c',
    });

    const r = records[0]!;
    expect(r.Provider_Key).toBe(REDACTED);
    expect(r.PASSWORD).toBe(REDACTED);
    expect(r.RefreshToken).toBe(REDACTED);
  });

  it('child loggers inherit redaction and merge bindings', () => {
    const { sink, records } = createMemorySink();
    const root = new Logger({ sink, minLevel: 'debug', bindings: { service: 'auth' } });
    const child = root.child({ request_id: 'req-1' });

    child.info('login_attempt', { password: 'topsecret', user: 'u1' });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      service: 'auth',
      request_id: 'req-1',
      user: 'u1',
      password: REDACTED,
    });
  });

  it('JSON.stringify of an emitted record never contains the plaintext secret', () => {
    const { sink, records } = createMemorySink();
    const log = new Logger({ sink, minLevel: 'debug' });

    const secret = 'sk-very-distinctive-plaintext-value-XYZ';
    log.info('outbound', {
      provider_key: secret,
      headers: { Authorization: `Bearer ${secret}` },
      arr: [{ password: secret }],
    });

    const serialized = JSON.stringify(records[0]);
    expect(serialized.includes(secret)).toBe(false);
  });

  it('extraRedactKeys augments the default redaction set', () => {
    const { sink, records } = createMemorySink();
    const log = new Logger({
      sink,
      minLevel: 'debug',
      extraRedactKeys: ['session_token'],
    });

    log.info('issued', { session_token: 'jwt.value', request_id: 'r1' });

    const r = records[0]!;
    expect(r.session_token).toBe(REDACTED);
    expect(r.request_id).toBe('r1');
  });

  it('redact() handles cycles without overflowing the stack', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;

    const out = redact(node, new Set()) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });
});
