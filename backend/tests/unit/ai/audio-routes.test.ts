/**
 * Unit tests for POST /ai/audio endpoint.
 *
 * Tests cover:
 *   - Authentication (missing/invalid JWT → 401)
 *   - Active session check (no session → 402)
 *   - File validation (missing file → 400, too large → 400, empty → 400)
 *   - Duration validation (> 5 min → 400)
 *   - Storage quota gate (exceeded → 507)
 *   - Provider key unavailable → 503
 *   - Upstream timeout → 502
 *   - Upstream error → 502
 *   - Successful transcription → 200 with { text }
 *   - Idempotency cache hit → returns cached response
 *   - Idempotency key conflict → 409
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAudioRouter } from '../../../src/ai/audio-routes.js';
import type { TranscribeFn } from '../../../src/ai/audio-routes.js';
import { StorageQuotaGate, StorageQuotaExceededError } from '../../../src/storage/quota-gate.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock JWT verification
vi.mock('../../../src/auth/jwt.js', () => ({
  verifyAccess: vi.fn(),
  JwtError: class JwtError extends Error {
    code = 'token_expired';
  },
}));

// Mock provider key resolver
vi.mock('../../../src/ai/keys.js', () => ({
  resolveProviderKey: vi.fn(),
  ProviderKeyUnavailableError: class ProviderKeyUnavailableError extends Error {
    code = 'provider_key_unavailable';
    httpStatus = 503;
    constructor(public provider: string, public category: string) {
      super(`provider key unavailable: ${provider} (${category})`);
      this.name = 'ProviderKeyUnavailableError';
    }
  },
}));

// Mock idempotency cache
vi.mock('../../../src/ai/idempotency.js', () => ({
  computeRequestHash: vi.fn(() => Buffer.from('a'.repeat(32))),
  lookupIdempotencyCache: vi.fn(async () => ({ hit: false })),
  insertIdempotencyCache: vi.fn(async () => ({ inserted: true })),
  IdempotencyKeyConflictError: class IdempotencyKeyConflictError extends Error {
    code = 'idempotency_key_conflict';
    httpStatus = 409;
    constructor(userId: string, key: string) {
      super(`Idempotency key conflict: key ${key} for user ${userId}`);
      this.name = 'IdempotencyKeyConflictError';
    }
  },
}));

// Mock blob store
vi.mock('../../../src/storage/blob-store.js', () => ({
  storeAudioBlob: vi.fn(async () => ({
    id: 'blob-id-123',
    userId: 'user-1',
    sessionId: 'session-1',
    fileName: 'audio.webm',
    mimeType: 'audio/webm',
    sizeBytes: 1024,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })),
}));

import { verifyAccess } from '../../../src/auth/jwt.js';
import { resolveProviderKey, ProviderKeyUnavailableError } from '../../../src/ai/keys.js';
import { lookupIdempotencyCache, IdempotencyKeyConflictError } from '../../../src/ai/idempotency.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

function createMockPool(hasActiveSession = true) {
  const mockQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('interview_sessions') && sql.includes('active')) {
      if (hasActiveSession) {
        return {
          rows: [{
            id: SESSION_ID,
            started_at: new Date('2024-01-01T00:00:00Z'),
            expires_at: new Date('2024-01-01T01:30:00Z'),
          }],
        };
      }
      return { rows: [] };
    }
    // Usage insert
    if (sql.includes('INSERT INTO usage')) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  return { query: mockQuery, connect: vi.fn() } as any;
}

function createMockStorageGate(shouldReject = false): StorageQuotaGate {
  return {
    assertCanWriteBlob: vi.fn(async () => {
      if (shouldReject) {
        throw new StorageQuotaExceededError(500 * 1024 * 1024, 450 * 1024 * 1024);
      }
    }),
    invalidate: vi.fn(),
    peek: vi.fn(),
  } as any;
}

function createMockTranscribe(result = 'Hello world'): TranscribeFn {
  return vi.fn(async () => result);
}

function createAudioFormData(
  fileContent: Buffer = Buffer.from('fake audio data'),
  fileName = 'audio.webm',
  mimeType = 'audio/webm',
  model?: string,
  duration?: number,
): FormData {
  const formData = new FormData();
  const blob = new Blob([fileContent], { type: mimeType });
  formData.append('file', new File([blob], fileName, { type: mimeType }));
  if (model) formData.append('model', model);
  if (duration !== undefined) formData.append('duration', String(duration));
  return formData;
}

async function makeRequest(
  router: ReturnType<typeof buildAudioRouter>,
  formData: FormData,
  headers: Record<string, string> = {},
) {
  const req = new Request('http://localhost/ai/audio', {
    method: 'POST',
    body: formData,
    headers,
  });
  return router.fetch(req);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /ai/audio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (verifyAccess as any).mockResolvedValue({ sub: USER_ID, role: 'user', client_id: 'client-1' });
    (resolveProviderKey as any).mockResolvedValue('sk-test-key-12345');
    (lookupIdempotencyCache as any).mockResolvedValue({ hit: false });
  });

  describe('authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({ pool, storageGate: gate });

      const formData = createAudioFormData();
      const res = await makeRequest(router, formData);

      expect(res.status).toBe(401);
      const body = await res.json() as any;
      expect(body.error.code).toBe('unauthenticated');
    });

    it('returns 401 when token is invalid', async () => {
      (verifyAccess as any).mockRejectedValue(new Error('invalid token'));

      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({ pool, storageGate: gate });

      const formData = createAudioFormData();
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer invalid-token',
      });

      expect(res.status).toBe(401);
    });
  });

  describe('active session check', () => {
    it('returns 402 when no active session exists', async () => {
      const pool = createMockPool(false);
      const gate = createMockStorageGate();
      const router = buildAudioRouter({ pool, storageGate: gate });

      const formData = createAudioFormData();
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(402);
      const body = await res.json() as any;
      expect(body.error.code).toBe('no_active_session');
    });

    it('returns 402 when session has expired', async () => {
      const pool = createMockPool(true);
      const gate = createMockStorageGate();
      // Set now to after the session expires
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        now: () => new Date('2024-01-01T02:00:00Z'),
      });

      const formData = createAudioFormData();
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(402);
      const body = await res.json() as any;
      expect(body.error.code).toBe('no_active_session');
    });
  });

  describe('file validation', () => {
    it('returns 400 when no file is provided', async () => {
      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = new FormData();
      formData.append('model', 'whisper-large-v3');
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error.code).toBe('invalid_request');
    });

    it('returns 400 when file exceeds 25 MB', async () => {
      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      // Create a buffer slightly over 25 MB
      const largeBuffer = Buffer.alloc(25 * 1024 * 1024 + 1);
      const formData = createAudioFormData(largeBuffer);
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error.code).toBe('file_too_large');
      expect(body.error.details.max_bytes).toBe(25 * 1024 * 1024);
    });

    it('returns 400 when file is empty', async () => {
      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData(Buffer.alloc(0));
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error.code).toBe('invalid_request');
    });
  });

  describe('duration validation', () => {
    it('returns 400 when duration exceeds 5 minutes', async () => {
      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData(
        Buffer.from('audio data'),
        'audio.webm',
        'audio/webm',
        undefined,
        301, // 5 min + 1 second
      );
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error.code).toBe('duration_too_long');
      expect(body.error.details.max_seconds).toBe(300);
    });

    it('accepts audio at exactly 5 minutes', async () => {
      const pool = createMockPool();
      const gate = createMockStorageGate();
      const transcribe = createMockTranscribe('transcribed text');
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        transcribe,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData(
        Buffer.from('audio data'),
        'audio.webm',
        'audio/webm',
        undefined,
        300, // exactly 5 min
      );
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(200);
    });
  });

  describe('storage quota gate', () => {
    it('returns 507 when storage quota is exceeded', async () => {
      const pool = createMockPool();
      const gate = createMockStorageGate(true);
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData();
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(507);
      const body = await res.json() as any;
      expect(body.error.code).toBe('storage_quota_exceeded');
    });
  });

  describe('provider key resolution', () => {
    it('returns 503 when provider key is unavailable', async () => {
      (resolveProviderKey as any).mockRejectedValue(
        new ProviderKeyUnavailableError('groq', 'missing'),
      );

      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData();
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(503);
      const body = await res.json() as any;
      expect(body.error.code).toBe('provider_key_unavailable');
    });
  });

  describe('upstream transcription', () => {
    it('returns 502 on upstream timeout', async () => {
      const transcribe: TranscribeFn = vi.fn(async (_buf, _fn, _mt, _m, _k, signal) => {
        // Simulate abort
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      });

      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        transcribe,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData();
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(502);
      const body = await res.json() as any;
      expect(body.error.code).toBe('upstream_provider_error');
      expect(body.error.message).toContain('timed out');
    });

    it('returns 502 on upstream error', async () => {
      const transcribe: TranscribeFn = vi.fn(async () => {
        throw new Error('upstream failed');
      });

      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        transcribe,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData();
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(502);
      const body = await res.json() as any;
      expect(body.error.code).toBe('upstream_provider_error');
    });

    it('returns 200 with transcribed text on success', async () => {
      const transcribe = createMockTranscribe('Hello, this is a test transcription.');

      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        transcribe,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData();
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.text).toBe('Hello, this is a test transcription.');
    });

    it('passes the correct model to the transcribe function', async () => {
      const transcribe = createMockTranscribe('text');

      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        transcribe,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData(
        Buffer.from('audio'),
        'audio.webm',
        'audio/webm',
        'whisper-large-v3-turbo',
      );
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(200);
      expect(transcribe).toHaveBeenCalledWith(
        expect.any(Buffer),
        'audio.webm',
        'audio/webm',
        'whisper-large-v3-turbo',
        'sk-test-key-12345',
        expect.any(AbortSignal),
      );
    });

    it('uses default model whisper-large-v3 when none specified', async () => {
      const transcribe = createMockTranscribe('text');

      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        transcribe,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData(
        Buffer.from('audio'),
        'audio.webm',
        'audio/webm',
      );
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      expect(res.status).toBe(200);
      expect(transcribe).toHaveBeenCalledWith(
        expect.any(Buffer),
        'audio.webm',
        'audio/webm',
        'whisper-large-v3',
        expect.any(String),
        expect.any(AbortSignal),
      );
    });
  });

  describe('usage recording', () => {
    it('records a usage row on successful transcription', async () => {
      const transcribe = createMockTranscribe('text');
      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        transcribe,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData();
      await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      // Check that usage INSERT was called
      const usageCalls = pool.query.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO usage'),
      );
      expect(usageCalls.length).toBe(1);
      // Verify status is 'success'
      expect(usageCalls[0][1]).toContain('success');
    });

    it('records a failed usage row on upstream error', async () => {
      const transcribe: TranscribeFn = vi.fn(async () => {
        throw new Error('upstream failed');
      });

      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        transcribe,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData();
      await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
      });

      const usageCalls = pool.query.mock.calls.filter(
        (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO usage'),
      );
      expect(usageCalls.length).toBe(1);
      expect(usageCalls[0][1]).toContain('failed');
    });
  });

  describe('idempotency', () => {
    it('returns cached response on idempotency cache hit', async () => {
      (lookupIdempotencyCache as any).mockResolvedValue({
        hit: true,
        response: { text: 'cached transcription' },
      });

      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData();
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
        'Idempotency-Key': '33333333-3333-4333-8333-333333333333',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.text).toBe('cached transcription');
    });

    it('returns 409 on idempotency key conflict', async () => {
      (lookupIdempotencyCache as any).mockRejectedValue(
        new IdempotencyKeyConflictError(USER_ID, '33333333-3333-4333-8333-333333333333'),
      );

      const pool = createMockPool();
      const gate = createMockStorageGate();
      const router = buildAudioRouter({
        pool,
        storageGate: gate,
        now: () => new Date('2024-01-01T00:30:00Z'),
      });

      const formData = createAudioFormData();
      const res = await makeRequest(router, formData, {
        Authorization: 'Bearer valid-token',
        'Idempotency-Key': '33333333-3333-4333-8333-333333333333',
      });

      expect(res.status).toBe(409);
      const body = await res.json() as any;
      expect(body.error.code).toBe('idempotency_key_conflict');
    });
  });
});
