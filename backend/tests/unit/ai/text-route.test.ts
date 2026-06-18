/**
 * Unit tests for `POST /ai/text` (SSE streaming).
 *
 * Tests cover:
 *   - Authentication: missing/invalid token → 401
 *   - Active session check: no session → 402
 *   - Body validation: missing model, missing messages, exceeds 32k chars → 400
 *   - Provider resolution: unsupported model → 400
 *   - Provider key unavailable → 503
 *   - Upstream timeout → 502 with usage row written
 *   - Upstream error (non-2xx) → 502 with usage row written
 *   - Successful streaming → 200 with text/event-stream content type
 *   - Usage row written on success
 *
 * Uses a fake pool and nock for upstream provider mocking.
 *
 * Validates: Requirements 7.1, 7.4, 7.5, 7.8, 9.1.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';

import { buildAiTextRouter } from '../../../src/ai/text-route.js';
import { encrypt, resetMasterKeyForTesting } from '../../../src/crypto/aes-gcm.js';
import { createMemorySink, Logger } from '../../../src/log/logger.js';
import * as jose from 'jose';

// ---------------------------------------------------------------------------
// Test JWT helper
// ---------------------------------------------------------------------------

const JWT_SECRET = 'test-secret-key-for-unit-tests-only';

async function createTestToken(claims: {
  sub: string;
  role: string;
  client_id: string;
}): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET);
  return new jose.SignJWT({
    sub: claims.sub,
    role: claims.role,
    client_id: claims.client_id,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setJti(randomUUID())
    .sign(secret);
}

// ---------------------------------------------------------------------------
// Fake pool
// ---------------------------------------------------------------------------

interface FakeDb {
  sessions: Array<{
    id: string;
    user_id: string;
    status: string;
    expires_at: Date;
  }>;
  providerKeys: Map<
    string,
    { ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer; version: number }
  >;
  usageRows: Array<Record<string, unknown>>;
  auditLog: Array<Record<string, unknown>>;
}

function createFakePool(db: FakeDb): Pool {
  const fakeClient: Partial<PoolClient> = {
    query: async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      return handleQuery(db, sql, params);
    },
    release: () => {},
  };

  const pool = {
    query: async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      return handleQuery(db, sql, params);
    },
    connect: async () => fakeClient as PoolClient,
  } as unknown as Pool;

  return pool;
}

function handleQuery(
  db: FakeDb,
  sql: string,
  params?: unknown[],
): QueryResult {
  const trimmed = sql.trim().toLowerCase();

  // Active session lookup
  if (trimmed.includes('interview_sessions') && trimmed.includes("status = 'active'")) {
    const userId = params?.[0] as string;
    const session = db.sessions.find(
      (s) => s.user_id === userId && s.status === 'active',
    );
    return {
      rows: session ? [{ id: session.id, expires_at: session.expires_at }] : [],
      rowCount: session ? 1 : 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    };
  }

  // Provider key lookup
  if (trimmed.includes('provider_keys') && trimmed.includes('select')) {
    const provider = params?.[0] as string;
    const key = db.providerKeys.get(provider);
    return {
      rows: key ? [key] : [],
      rowCount: key ? 1 : 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    };
  }

  // Idempotency cache lookup
  if (trimmed.includes('idempotency_cache') && trimmed.includes('select')) {
    return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
  }

  // Usage insert
  if (trimmed.includes('insert into usage')) {
    db.usageRows.push({
      id: params?.[0],
      user_id: params?.[1],
      session_id: params?.[2],
      ts: params?.[3],
      model_id: params?.[4],
      input_tokens: params?.[5],
      output_tokens: params?.[6],
      status: params?.[7],
      upstream_http_status: params?.[8],
      idempotency_key: params?.[9],
    });
    return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
  }

  // Audit log insert (from key resolver)
  if (trimmed.includes('audit_log') || trimmed.includes('begin') || trimmed.includes('commit') || trimmed.includes('rollback')) {
    if (trimmed.includes('audit_log')) {
      db.auditLog.push({ sql, params });
    }
    return { rows: [], rowCount: 0, command: 'INSERT', oid: 0, fields: [] };
  }

  return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('POST /ai/text', () => {
  let db: FakeDb;
  let pool: Pool;
  let router: ReturnType<typeof buildAiTextRouter>;
  let logRecords: Array<Record<string, unknown>>;
  let logger: Logger;

  const userId = randomUUID();
  const clientId = randomUUID();
  const sessionId = randomUUID();

  beforeAll(() => {
    process.env['JWT_SECRET'] = JWT_SECRET;
    process.env['MASTER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
    resetMasterKeyForTesting();
  });

  beforeEach(() => {
    db = {
      sessions: [
        {
          id: sessionId,
          user_id: userId,
          status: 'active',
          expires_at: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
        },
      ],
      providerKeys: new Map(),
      usageRows: [],
      auditLog: [],
    };

    // Set up an encrypted provider key for groq
    const plaintext = 'gsk_test_key_1234567890';
    const envelope = encrypt(Buffer.from(plaintext, 'utf8'), 'provider:groq');
    db.providerKeys.set('groq', {
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      auth_tag: envelope.authTag,
      version: 1,
    });

    pool = createFakePool(db);

    const { sink, records } = createMemorySink();
    logRecords = records;
    logger = new Logger({ sink, minLevel: 'debug' });

    router = buildAiTextRouter({
      pool,
      logger,
      now: () => new Date(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Authentication tests
  // -------------------------------------------------------------------------

  it('returns 401 when Authorization header is missing', async () => {
    const req = new Request('http://localhost/ai/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'groq/llama-3.1-70b', messages: [] }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthenticated');
  });

  it('returns 401 when token is invalid', async () => {
    const req = new Request('http://localhost/ai/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid-token',
      },
      body: JSON.stringify({ model: 'groq/llama-3.1-70b', messages: [] }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthenticated');
  });

  // -------------------------------------------------------------------------
  // Active session tests
  // -------------------------------------------------------------------------

  it('returns 402 when no active session exists', async () => {
    db.sessions = []; // No active sessions
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    const req = new Request('http://localhost/ai/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'groq/llama-3.1-70b', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe('no_active_session');
  });

  it('returns 402 when session has expired', async () => {
    db.sessions = [
      {
        id: sessionId,
        user_id: userId,
        status: 'active',
        expires_at: new Date(Date.now() - 1000), // Expired 1 second ago
      },
    ];
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    const req = new Request('http://localhost/ai/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'groq/llama-3.1-70b', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe('no_active_session');
  });

  // -------------------------------------------------------------------------
  // Body validation tests
  // -------------------------------------------------------------------------

  it('returns 400 when body is not valid JSON', async () => {
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    const req = new Request('http://localhost/ai/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: 'not json',
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 400 when model field is missing', async () => {
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    const req = new Request('http://localhost/ai/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('model');
  });

  it('returns 400 when messages field is missing', async () => {
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    const req = new Request('http://localhost/ai/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model: 'groq/llama-3.1-70b' }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('messages');
  });

  it('returns 400 when total input text exceeds 32k chars', async () => {
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });
    const longContent = 'x'.repeat(33_000);

    const req = new Request('http://localhost/ai/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'groq/llama-3.1-70b',
        messages: [{ role: 'user', content: longContent }],
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('32000');
  });

  // -------------------------------------------------------------------------
  // Provider resolution tests
  // -------------------------------------------------------------------------

  it('returns 400 for unsupported model slug', async () => {
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    const req = new Request('http://localhost/ai/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'unknown-provider/some-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('unsupported model');
  });

  // -------------------------------------------------------------------------
  // Provider key unavailable tests
  // -------------------------------------------------------------------------

  it('returns 503 when provider key is not available', async () => {
    db.providerKeys.clear(); // No keys available
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    const req = new Request('http://localhost/ai/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'groq/llama-3.1-70b',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('provider_key_unavailable');
  });

  // -------------------------------------------------------------------------
  // Upstream error tests
  // -------------------------------------------------------------------------

  it('returns 502 when upstream returns non-2xx status and writes usage row', async () => {
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    // Mock fetch to return a 500 error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'internal error' }), { status: 500 }),
    );

    try {
      const req = new Request('http://localhost/ai/text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: 'groq/llama-3.1-70b',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      const res = await router.fetch(req);
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.code).toBe('upstream_provider_error');

      // Verify usage row was written with 'failed' status
      expect(db.usageRows.length).toBe(1);
      expect(db.usageRows[0]!.status).toBe('failed');
      expect(db.usageRows[0]!.upstream_http_status).toBe(500);
      expect(db.usageRows[0]!.user_id).toBe(userId);
      expect(db.usageRows[0]!.session_id).toBe(sessionId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns 502 on network/timeout error and writes usage row', async () => {
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    // Mock fetch to throw a network error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));

    try {
      const req = new Request('http://localhost/ai/text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: 'groq/llama-3.1-70b',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      const res = await router.fetch(req);
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.code).toBe('upstream_provider_error');

      // Verify usage row was written with 'failed' status
      expect(db.usageRows.length).toBe(1);
      expect(db.usageRows[0]!.status).toBe('failed');
      expect(db.usageRows[0]!.upstream_http_status).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // -------------------------------------------------------------------------
  // Successful streaming tests
  // -------------------------------------------------------------------------

  it('streams SSE response on success and writes usage row', async () => {
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    // Mock fetch to return a streaming response
    const sseData = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseData) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    try {
      const req = new Request('http://localhost/ai/text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: 'groq/llama-3.1-70b',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });

      const res = await router.fetch(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');

      // Read the full stream
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
      }

      // Verify the stream contains the expected SSE data
      expect(fullText).toContain('Hello');
      expect(fullText).toContain(' world');
      expect(fullText).toContain('[DONE]');

      // Verify usage row was written with 'success' status
      expect(db.usageRows.length).toBe(1);
      expect(db.usageRows[0]!.status).toBe('success');
      expect(db.usageRows[0]!.user_id).toBe(userId);
      expect(db.usageRows[0]!.session_id).toBe(sessionId);
      expect(db.usageRows[0]!.model_id).toBe('groq/llama-3.1-70b');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('correctly resolves provider from model slug with slash', async () => {
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    // Add a deepseek key
    const plaintext = 'sk-deepseek-test-key';
    const envelope = encrypt(Buffer.from(plaintext, 'utf8'), 'provider:deepseek');
    db.providerKeys.set('deepseek', {
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      auth_tag: envelope.authTag,
      version: 1,
    });

    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    globalThis.fetch = mockFetch;

    try {
      const req = new Request('http://localhost/ai/text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: 'deepseek/deepseek-chat',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      const res = await router.fetch(req);
      expect(res.status).toBe(200);

      // Consume the stream to trigger usage write
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      // Verify the upstream call was made to the deepseek endpoint
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.deepseek.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${plaintext}`,
          }),
        }),
      );

      // Verify the model name sent upstream strips the provider prefix
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.model).toBe('deepseek-chat');
      expect(callBody.stream).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes system prompt in upstream messages when provided', async () => {
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });

    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    globalThis.fetch = mockFetch;

    try {
      const req = new Request('http://localhost/ai/text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: 'groq/llama-3.1-70b',
          messages: [{ role: 'user', content: 'hello' }],
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      const res = await router.fetch(req);
      expect(res.status).toBe(200);

      // Consume the stream
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      // Verify system prompt was included as first message
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.messages[0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.',
      });
      expect(callBody.messages[1]).toEqual({
        role: 'user',
        content: 'hello',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('counts system prompt chars toward the 32k limit', async () => {
    const token = await createTestToken({ sub: userId, role: 'user', client_id: clientId });
    // System prompt of 20k + message of 13k = 33k > 32k limit
    const systemPrompt = 'x'.repeat(20_000);
    const messageContent = 'y'.repeat(13_000);

    const req = new Request('http://localhost/ai/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'groq/llama-3.1-70b',
        messages: [{ role: 'user', content: messageContent }],
        systemPrompt,
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('32000');
  });
});
