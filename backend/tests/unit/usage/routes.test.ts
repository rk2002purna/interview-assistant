import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgMem, type PgMemContext } from '../../helpers/postgres-pgmem.js';
import { buildApp } from '../../../src/app.js';
import { signAccessToken } from '../../../src/auth/jwt.js';

/**
 * Unit tests for `GET /me/usage`.
 *
 * Validates: Requirements 9.2, 9.3, 9.4
 * - Default 30-day range, max 92-day range
 * - Default page_size 50, max 200, min 1
 * - Reverse-chronological order with cursor pagination
 * - 400 invalid_range_or_page_size for invalid params
 */

const INIT_SQL = `
  CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    role text NOT NULL
  );

  CREATE TABLE interview_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    status text NOT NULL,
    started_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    ended_at timestamptz NULL,
    ended_reason text NULL
  );

  CREATE TABLE usage (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    session_id uuid NOT NULL REFERENCES interview_sessions(id),
    ts timestamptz NOT NULL DEFAULT now(),
    operation_type text NOT NULL,
    model_id text NOT NULL,
    input_tokens integer NULL,
    input_image_count integer NULL,
    output_tokens integer NULL,
    status text NOT NULL,
    upstream_http_status integer NULL,
    idempotency_key uuid NULL
  );

  CREATE INDEX usage_user_id_ts_desc_idx ON usage (user_id, ts DESC);
`;

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';

let ctx: PgMemContext;
let restore: () => void;
let originalSecret: string | undefined;

beforeAll(async () => {
  originalSecret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'test-secret-for-usage-routes-12345';
  ctx = await createPgMem({ initSql: INIT_SQL });
});

afterAll(async () => {
  await ctx.stop();
  if (originalSecret === undefined) {
    delete process.env['JWT_SECRET'];
  } else {
    process.env['JWT_SECRET'] = originalSecret;
  }
});

beforeEach(() => {
  restore = ctx.snapshot();
  return ctx.withClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, email, role) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [USER_ID, 'user@example.com', 'user', OTHER_USER_ID, 'other@example.com', 'user'],
    );
    await client.query(
      `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at)
       VALUES ($1, $2, 'ended', '2024-06-01T00:00:00Z', '2024-06-01T01:30:00Z')`,
      [SESSION_ID, USER_ID],
    );
  });
});

afterEach(() => {
  restore();
});

async function getToken(userId = USER_ID): Promise<string> {
  const { token } = await signAccessToken({
    sub: userId,
    role: 'user',
    clientId: CLIENT_ID,
  });
  return token;
}

/** Fixed "now" for deterministic tests. */
const FIXED_NOW = new Date('2024-07-01T12:00:00Z');

function buildTestApp() {
  return buildApp({ pool: ctx.pool, now: () => FIXED_NOW });
}

describe('GET /me/usage', () => {
  describe('authentication', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const app = buildTestApp();
      const res = await app.request('/me/usage');
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthenticated');
    });

    it('returns 401 for malformed Authorization header', async () => {
      const app = buildTestApp();
      const res = await app.request('/me/usage', {
        headers: { Authorization: 'Basic abc123' },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthenticated');
    });
  });

  describe('validation', () => {
    it('returns 400 for page_size exceeding 200', async () => {
      const app = buildTestApp();
      const token = await getToken();
      const res = await app.request('/me/usage?page_size=201', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_range_or_page_size');
    });

    it('returns 400 for page_size less than 1', async () => {
      const app = buildTestApp();
      const token = await getToken();
      const res = await app.request('/me/usage?page_size=0', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_range_or_page_size');
    });

    it('returns 400 for non-integer page_size', async () => {
      const app = buildTestApp();
      const token = await getToken();
      const res = await app.request('/me/usage?page_size=abc', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_range_or_page_size');
    });

    it('returns 400 when range exceeds 92 days', async () => {
      const app = buildTestApp();
      const token = await getToken();
      const res = await app.request(
        '/me/usage?from=2024-01-01T00:00:00Z&to=2024-05-01T00:00:00Z',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_range_or_page_size');
    });

    it('returns 400 when from is after to', async () => {
      const app = buildTestApp();
      const token = await getToken();
      const res = await app.request(
        '/me/usage?from=2024-07-01T00:00:00Z&to=2024-06-01T00:00:00Z',
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_range_or_page_size');
    });

    it('returns 400 for invalid from date format', async () => {
      const app = buildTestApp();
      const token = await getToken();
      const res = await app.request('/me/usage?from=not-a-date', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_range_or_page_size');
    });

    it('returns 400 for invalid to date format', async () => {
      const app = buildTestApp();
      const token = await getToken();
      const res = await app.request('/me/usage?from=2024-06-01T00:00:00Z&to=not-a-date', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_range_or_page_size');
    });
  });

  describe('defaults', () => {
    it('defaults to 30-day range when from/to are omitted', async () => {
      const app = buildTestApp();
      const token = await getToken();
      // Insert a usage row within the default 30-day window
      await ctx.withClient(async (client) => {
        await client.query(
          `INSERT INTO usage (id, user_id, session_id, ts, operation_type, model_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            USER_ID,
            SESSION_ID,
            '2024-06-15T10:00:00Z', // within 30 days of FIXED_NOW (2024-07-01)
            'text',
            'gemini-pro',
            'success',
          ],
        );
      });

      const res = await app.request('/me/usage', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { items: unknown[]; next_cursor: string | null };
      expect(body.items).toHaveLength(1);
      expect(body.next_cursor).toBeNull();
    });

    it('returns empty items when no usage exists', async () => {
      const app = buildTestApp();
      const token = await getToken();
      const res = await app.request('/me/usage', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { items: unknown[]; next_cursor: string | null };
      expect(body.items).toHaveLength(0);
      expect(body.next_cursor).toBeNull();
    });
  });

  describe('pagination', () => {
    it('returns next_cursor when more results exist', async () => {
      const app = buildTestApp();
      const token = await getToken();

      // Insert 3 usage rows
      await ctx.withClient(async (client) => {
        await client.query(
          `INSERT INTO usage (id, user_id, session_id, ts, operation_type, model_id, status)
           VALUES
             ($1, $2, $3, '2024-06-20T10:00:00Z', 'text', 'gemini-pro', 'success'),
             ($4, $2, $3, '2024-06-20T11:00:00Z', 'vision', 'gemini-pro', 'success'),
             ($5, $2, $3, '2024-06-20T12:00:00Z', 'audio', 'whisper', 'success')`,
          [
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            USER_ID,
            SESSION_ID,
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          ],
        );
      });

      // Request with page_size=2
      const res = await app.request('/me/usage?page_size=2', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { items: { id: string }[]; next_cursor: string | null };
      expect(body.items).toHaveLength(2);
      expect(body.next_cursor).not.toBeNull();
    });

    it('cursor pagination returns the next page', async () => {
      const app = buildTestApp();
      const token = await getToken();

      // Insert 3 usage rows with distinct timestamps
      await ctx.withClient(async (client) => {
        await client.query(
          `INSERT INTO usage (id, user_id, session_id, ts, operation_type, model_id, status)
           VALUES
             ($1, $2, $3, '2024-06-20T10:00:00Z', 'text', 'gemini-pro', 'success'),
             ($4, $2, $3, '2024-06-20T11:00:00Z', 'vision', 'gemini-pro', 'success'),
             ($5, $2, $3, '2024-06-20T12:00:00Z', 'audio', 'whisper', 'success')`,
          [
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            USER_ID,
            SESSION_ID,
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          ],
        );
      });

      // First page
      const res1 = await app.request('/me/usage?page_size=2', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body1 = await res1.json() as { items: { id: string }[]; next_cursor: string | null };
      expect(body1.items).toHaveLength(2);
      expect(body1.next_cursor).not.toBeNull();

      // Second page using cursor
      const res2 = await app.request(`/me/usage?page_size=2&cursor=${body1.next_cursor}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body2 = await res2.json() as { items: { id: string }[]; next_cursor: string | null };
      expect(body2.items).toHaveLength(1);
      expect(body2.next_cursor).toBeNull();
    });

    it('returns items in reverse-chronological order', async () => {
      const app = buildTestApp();
      const token = await getToken();

      await ctx.withClient(async (client) => {
        await client.query(
          `INSERT INTO usage (id, user_id, session_id, ts, operation_type, model_id, status)
           VALUES
             ($1, $2, $3, '2024-06-20T08:00:00Z', 'text', 'gemini-pro', 'success'),
             ($4, $2, $3, '2024-06-20T12:00:00Z', 'vision', 'gemini-pro', 'success'),
             ($5, $2, $3, '2024-06-20T10:00:00Z', 'audio', 'whisper', 'success')`,
          [
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            USER_ID,
            SESSION_ID,
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          ],
        );
      });

      const res = await app.request('/me/usage', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { items: { ts: string; operation_type: string }[] };
      // Should be ordered: 12:00 (vision), 10:00 (audio), 08:00 (text)
      expect(body.items[0]!.operation_type).toBe('vision');
      expect(body.items[1]!.operation_type).toBe('audio');
      expect(body.items[2]!.operation_type).toBe('text');
    });
  });

  describe('isolation', () => {
    it('does not return another user\'s usage', async () => {
      const app = buildTestApp();
      const token = await getToken();

      const otherSessionId = '55555555-5555-4555-8555-555555555555';
      await ctx.withClient(async (client) => {
        await client.query(
          `INSERT INTO interview_sessions (id, user_id, status, started_at, expires_at)
           VALUES ($1, $2, 'ended', '2024-06-01T00:00:00Z', '2024-06-01T01:30:00Z')`,
          [otherSessionId, OTHER_USER_ID],
        );
        await client.query(
          `INSERT INTO usage (id, user_id, session_id, ts, operation_type, model_id, status)
           VALUES ($1, $2, $3, '2024-06-20T10:00:00Z', 'text', 'gemini-pro', 'success')`,
          ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', OTHER_USER_ID, otherSessionId],
        );
      });

      const res = await app.request('/me/usage', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { items: unknown[] };
      expect(body.items).toHaveLength(0);
    });
  });

  describe('response shape', () => {
    it('returns all expected fields in usage items', async () => {
      const app = buildTestApp();
      const token = await getToken();

      await ctx.withClient(async (client) => {
        await client.query(
          `INSERT INTO usage (id, user_id, session_id, ts, operation_type, model_id,
                              input_tokens, input_image_count, output_tokens, status,
                              upstream_http_status, idempotency_key)
           VALUES ($1, $2, $3, '2024-06-20T10:00:00Z', 'text', 'gemini-pro',
                   100, NULL, 50, 'success', 200, $4)`,
          [
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            USER_ID,
            SESSION_ID,
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          ],
        );
      });

      const res = await app.request('/me/usage', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { items: Record<string, unknown>[]; next_cursor: string | null };
      expect(body.items).toHaveLength(1);
      const item = body.items[0]!;
      expect(item).toHaveProperty('id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(item).toHaveProperty('session_id', SESSION_ID);
      expect(item).toHaveProperty('operation_type', 'text');
      expect(item).toHaveProperty('model_id', 'gemini-pro');
      expect(item).toHaveProperty('input_tokens', 100);
      expect(item).toHaveProperty('input_image_count', null);
      expect(item).toHaveProperty('output_tokens', 50);
      expect(item).toHaveProperty('status', 'success');
      expect(item).toHaveProperty('upstream_http_status', 200);
      expect(item).toHaveProperty('idempotency_key', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
      expect(item).toHaveProperty('ts');
      expect(body.next_cursor).toBeNull();
    });
  });
});
