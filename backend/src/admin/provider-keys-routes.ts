import { Hono } from 'hono';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import { encrypt } from '../crypto/aes-gcm.js';
import { writeAudit } from '../log/audit.js';

/**
 * Admin Provider_Key HTTP routes.
 *
 *   GET    /admin/provider-keys             - masked list of every stored key
 *   POST   /admin/provider-keys             - create a new key for one provider
 *   PATCH  /admin/provider-keys/:provider   - rotate (replace + bump version)
 *   DELETE /admin/provider-keys/:provider   - delete a stored key
 *
 * Validates: Requirements 4.1, 4.3, 4.4, 4.6, 4.7, 4.8, 4.9, 11.9.
 *
 * The router lives in its own file so it can be wired into `buildApp`
 * independently from the other admin sub-apps. The global middleware
 * chain (`src/http/middleware.ts`) is not yet mounted application-
 * wide, so the router performs its own bearer-token + admin-role
 * check inline (mirroring `welcome-offer-routes.ts` and
 * `packs-routes.ts`); when the chain lands the inline auth helper
 * will be removed in favour of `c.get('claims')`.
 *
 * The plaintext key only ever exists inside this module's request-
 * handler scope: it is encrypted before any database write, never
 * returned in any response body, and never written to a log field.
 * The structured logger's default redaction set already protects the
 * `provider_key` / `apiKey` field names; this module simply never
 * places the plaintext into a logged field at all.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Supported providers. Mirrors the CHECK constraint on
 * `provider_keys.provider` in migration 0005 and the `PROVIDERS`
 * tuple in `src/ai/keys.ts`.
 */
const PROVIDER_VALUES = ['gemini', 'groq', 'deepseek', 'cerebras'] as const;
type Provider = (typeof PROVIDER_VALUES)[number];

/** Maximum key length per Requirement 4.1. */
const MAX_KEY_LENGTH = 512;

/**
 * Fixed-length mask placeholder used in masked list responses. R4.3:
 * "the masked portion as a fixed-length placeholder of 8 characters
 * regardless of original key length".
 */
const MASK_PREFIX = '********';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AdminProviderKeysRouterDeps {
  /** Postgres pool used for all reads, writes, and audit inserts. */
  readonly pool: Pool;
}

/**
 * Wire-format provider key record returned by the listing endpoint
 * and by successful create / rotate responses. The plaintext key is
 * never present; only the 8-character mask placeholder, the last 4
 * characters of the original plaintext, and metadata are surfaced.
 */
export interface ProviderKeyResponse {
  provider: Provider;
  /** 8-char mask placeholder (always `********`). */
  masked: string;
  /** Last 4 chars of the most recently stored plaintext. */
  last4: string;
  version: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Internal types / schemas
// ---------------------------------------------------------------------------

interface ProviderKeyRow {
  provider: string;
  last4: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * Validation rules for the plaintext provider key (R4.1, R4.8):
 *   - 1..512 characters
 *   - no leading or trailing whitespace
 *
 * The schema is shared by the create and rotate endpoints so the
 * error message is identical for both.
 */
const keyStringSchema = z
  .string()
  .min(1, { message: 'key must be 1..512 characters' })
  .max(MAX_KEY_LENGTH, { message: 'key must be 1..512 characters' })
  .refine((v) => v === v.trim(), {
    message: 'key must not contain leading or trailing whitespace',
  });

const providerSlugSchema = z.enum(PROVIDER_VALUES, {
  errorMap: () => ({
    message: `provider must be one of: ${PROVIDER_VALUES.join(', ')}`,
  }),
});

const createBodySchema = z
  .object({
    provider: providerSlugSchema,
    key: keyStringSchema,
  })
  .strict();

const rotateBodySchema = z
  .object({
    key: keyStringSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function buildAdminProviderKeysRouter(
  deps: AdminProviderKeysRouterDeps,
): Hono {
  const router = new Hono();

  // -------------------------------------------------------------------------
  // GET /admin/provider-keys
  // -------------------------------------------------------------------------
  router.get('/admin/provider-keys', async (c) => {
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    const result = await deps.pool.query<ProviderKeyRow>(
      `SELECT provider, last4, version, created_at, updated_at
         FROM provider_keys`,
    );

    const ordered = [...result.rows].sort(
      (a, b) => providerOrderIndex(a.provider) - providerOrderIndex(b.provider),
    );

    const keys: ProviderKeyResponse[] = ordered.map(rowToResponse);
    return c.json({ provider_keys: keys });
  });

  // -------------------------------------------------------------------------
  // POST /admin/provider-keys
  // -------------------------------------------------------------------------
  router.post('/admin/provider-keys', async (c) => {
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    const parsed = await parseJsonBody(c.req, createBodySchema);
    if (!parsed.ok) return c.json(parsed.body, parsed.status);
    const { provider, key } = parsed.value;

    const last4 = computeLast4(key);
    const envelope = encrypt(key, `provider:${provider}`);

    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<{ provider: string }>(
        `SELECT provider FROM provider_keys WHERE provider = $1 FOR UPDATE`,
        [provider],
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return c.json(
          {
            error: {
              code: 'provider_key_exists',
              message:
                'a provider key already exists for this provider; rotate it instead',
              details: { provider },
            },
          },
          409,
        );
      }

      const inserted = await client.query<ProviderKeyRow>(
        `INSERT INTO provider_keys
            (provider, ciphertext, nonce, auth_tag, last4, version)
          VALUES ($1, $2, $3, $4, $5, 1)
          RETURNING provider, last4, version, created_at, updated_at`,
        [
          provider,
          envelope.ciphertext,
          envelope.nonce,
          envelope.authTag,
          last4,
        ],
      );

      // R4.9: audit row on create. The plaintext key is not part of
      // the metadata; only the provider, action, and version are.
      await writeAudit(client, {
        actor: { userId: auth.sub },
        target: { resource: `provider_key:${provider}` },
        eventType: 'provider_key_create',
        outcome: 'success',
        metadata: {
          provider,
          action: 'create',
          version: 1,
        },
      });

      await client.query('COMMIT');

      const row = inserted.rows[0]!;
      return c.json({ provider_key: rowToResponse(row) }, 201);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Connection may already be in an aborted state.
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /admin/provider-keys/:provider   (rotate)
  // -------------------------------------------------------------------------
  router.patch('/admin/provider-keys/:provider', async (c) => {
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    const providerParam = c.req.param('provider');
    if (!isProvider(providerParam)) {
      return c.json(
        {
          error: {
            code: 'invalid_provider_key',
            message: `provider must be one of: ${PROVIDER_VALUES.join(', ')}`,
            details: { field: 'provider' },
          },
        },
        400,
      );
    }
    const provider = providerParam;

    const parsed = await parseJsonBody(c.req, rotateBodySchema);
    if (!parsed.ok) return c.json(parsed.body, parsed.status);
    const { key } = parsed.value;

    const last4 = computeLast4(key);
    const envelope = encrypt(key, `provider:${provider}`);

    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<{ version: number }>(
        `SELECT version FROM provider_keys WHERE provider = $1 FOR UPDATE`,
        [provider],
      );
      const existingRow = existing.rows[0];
      if (!existingRow) {
        await client.query('ROLLBACK');
        return c.json(
          {
            error: {
              code: 'provider_key_not_found',
              message: 'no provider key exists for this provider',
              details: { provider },
            },
          },
          404,
        );
      }
      const previousVersion = existingRow.version;
      const newVersion = previousVersion + 1;

      const updated = await client.query<ProviderKeyRow>(
        `UPDATE provider_keys
            SET ciphertext = $1,
                nonce = $2,
                auth_tag = $3,
                last4 = $4,
                version = $5,
                updated_at = now()
          WHERE provider = $6
          RETURNING provider, last4, version, created_at, updated_at`,
        [
          envelope.ciphertext,
          envelope.nonce,
          envelope.authTag,
          last4,
          newVersion,
          provider,
        ],
      );

      // R4.4: audit row on rotate; records the acting admin's user
      // id, the provider name, and the new version number.
      await writeAudit(client, {
        actor: { userId: auth.sub },
        target: { resource: `provider_key:${provider}` },
        eventType: 'provider_key_rotate',
        outcome: 'success',
        metadata: {
          provider,
          action: 'rotate',
          previous_version: previousVersion,
          version: newVersion,
        },
      });

      await client.query('COMMIT');

      const row = updated.rows[0]!;
      return c.json({ provider_key: rowToResponse(row) }, 200);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /admin/provider-keys/:provider
  // -------------------------------------------------------------------------
  router.delete('/admin/provider-keys/:provider', async (c) => {
    const auth = await authenticateAdmin(c.req.header('Authorization'));
    if ('errorBody' in auth) {
      return c.json(auth.errorBody, auth.status);
    }

    const providerParam = c.req.param('provider');
    if (!isProvider(providerParam)) {
      return c.json(
        {
          error: {
            code: 'invalid_provider_key',
            message: `provider must be one of: ${PROVIDER_VALUES.join(', ')}`,
            details: { field: 'provider' },
          },
        },
        400,
      );
    }
    const provider = providerParam;

    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      const deleted = await client.query<{ version: number }>(
        `DELETE FROM provider_keys
          WHERE provider = $1
          RETURNING version`,
        [provider],
      );
      if (deleted.rows.length === 0) {
        await client.query('ROLLBACK');
        return c.json(
          {
            error: {
              code: 'provider_key_not_found',
              message: 'no provider key exists for this provider',
              details: { provider },
            },
          },
          404,
        );
      }

      // R4.9: audit row on delete.
      await writeAudit(client, {
        actor: { userId: auth.sub },
        target: { resource: `provider_key:${provider}` },
        eventType: 'provider_key_delete',
        outcome: 'success',
        metadata: {
          provider,
          action: 'delete',
          deleted_version: deleted.rows[0]!.version,
        },
      });

      await client.query('COMMIT');

      return c.json({ deleted: true, provider }, 200);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw err;
    } finally {
      client.release();
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToResponse(row: ProviderKeyRow): ProviderKeyResponse {
  return {
    provider: row.provider as Provider,
    masked: MASK_PREFIX,
    last4: row.last4,
    version: row.version,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isProvider(value: string): value is Provider {
  return (PROVIDER_VALUES as readonly string[]).includes(value);
}

function providerOrderIndex(provider: string): number {
  const idx = (PROVIDER_VALUES as readonly string[]).indexOf(provider);
  return idx === -1 ? PROVIDER_VALUES.length : idx;
}

/**
 * Compute the 4-char last-4 mask. R4.3 requires storing the last 4
 * characters; for keys shorter than 4 we left-pad with `x` so the
 * `length(last4) = 4` CHECK constraint in migration 0005 is always
 * satisfied. The validation in `keyStringSchema` already requires
 * `length >= 1`, so the input is never empty.
 */
function computeLast4(key: string): string {
  const tail = key.slice(-4);
  if (tail.length === 4) return tail;
  return tail.padStart(4, 'x');
}

// ---------------------------------------------------------------------------
// Body parsing helper
// ---------------------------------------------------------------------------

interface ParsedOk<T> {
  readonly ok: true;
  readonly value: T;
}

interface ParsedErr {
  readonly ok: false;
  readonly status: 400;
  readonly body: {
    error: {
      code: string;
      message: string;
      details?: Readonly<Record<string, unknown>>;
    };
  };
}

/**
 * Parse a JSON request body against `schema`. Both malformed JSON and
 * schema-validation failures produce HTTP 400 with error code
 * `invalid_provider_key`, matching Requirement 4.8: "the Backend_API
 * SHALL reject the operation with HTTP 400 and error code
 * `invalid_provider_key` and SHALL leave any previously stored
 * Provider_Key for that provider unchanged".
 *
 * Because validation runs before the database transaction is opened,
 * "leave previously stored Provider_Key unchanged" is guaranteed
 * structurally: no SQL has executed when this helper rejects.
 */
async function parseJsonBody<T>(
  req: { json: () => Promise<unknown> },
  schema: z.ZodType<T>,
): Promise<ParsedOk<T> | ParsedErr> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          code: 'invalid_provider_key',
          message: 'request body must be valid JSON',
          details: { field: '<body>' },
        },
      },
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') ?? '<body>';
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          code: 'invalid_provider_key',
          message: issue?.message ?? 'invalid provider key',
          details: { field },
        },
      },
    };
  }
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Inline admin auth helper
// ---------------------------------------------------------------------------

interface AdminAuthSuccess {
  sub: string;
  role: 'admin';
  client_id: string;
}

interface AdminAuthFailure {
  status: 403;
  errorBody: { error: { code: string; message: string } };
}

/**
 * Inline authentication + role gate. Returns the byte-equal 403
 * envelope for every non-admin case (no header, malformed header,
 * invalid token, role !== admin) so responses are identical regardless
 * of whether the targeted resource exists, satisfying R2.3 / Property
 * 14.
 */
async function authenticateAdmin(
  authorization: string | undefined,
): Promise<AdminAuthSuccess | AdminAuthFailure> {
  const forbidden: AdminAuthFailure = {
    status: 403,
    errorBody: {
      error: {
        code: 'forbidden_role',
        message: 'caller does not have the required role',
      },
    },
  };

  if (!authorization) return forbidden;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) return forbidden;
  try {
    const claims = await verifyAccess(match[1]!);
    if (claims.role !== 'admin') return forbidden;
    return { sub: claims.sub, role: 'admin', client_id: claims.client_id };
  } catch (err) {
    if (err instanceof JwtError) return forbidden;
    throw err;
  }
}

// Re-export for tests.
export type { PoolClient };
