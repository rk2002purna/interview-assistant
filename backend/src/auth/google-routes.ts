/**
 * Google OAuth sign-in route: POST /auth/google
 *
 * Flow ("Sign in with Google" via Google Identity Services):
 *   1. The web app obtains a Google ID token (a signed JWT) client-side using
 *      the public Google OAuth client ID — the user never types a password.
 *   2. It POSTs { id_token, client_id } here.
 *   3. This route verifies the ID token against Google's published JWKS,
 *      checking the signature, issuer, and audience (our GOOGLE_CLIENT_ID).
 *   4. It upserts the user (link by google_sub, else by email, else create)
 *      and issues the same access + refresh token pair as /auth/login.
 *
 * Only the public client ID is needed (no client secret): verification is
 * audience-checked against GOOGLE_CLIENT_ID. `jose` (already a dependency)
 * performs the JWKS verification, so no new package is required.
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from './jwt.js';

/** Refresh token TTL (30 days) — matches /auth/login. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Refresh token random byte length before base64url encoding. */
export const REFRESH_TOKEN_BYTES = 32;

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Identity extracted from a verified Google ID token. */
export interface GoogleIdentity {
  /** Stable Google account id (the token `sub`). */
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
}

/** Verifier signature — injectable so tests can stub Google verification. */
export type VerifyGoogleIdToken = (idToken: string) => Promise<GoogleIdentity>;

export interface GoogleRoutesDeps {
  readonly pool: Pool;
  readonly now?: () => Date;
  /** Override the Google ID-token verifier (tests). Defaults to JWKS verify. */
  readonly verifyGoogleIdToken?: VerifyGoogleIdToken;
}

/** Error type carrying a machine-readable code for the HTTP envelope. */
export class GoogleAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoogleAuthError';
    this.code = code;
  }
}

// Lazily-created, cached remote JWKS (jose caches keys and refreshes on demand).
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getGoogleJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!cachedJwks) {
    cachedJwks = createRemoteJWKSet(new URL(GOOGLE_CERTS_URL));
  }
  return cachedJwks;
}

/**
 * Default verifier: validates the Google ID token signature/issuer/audience
 * and extracts identity claims. Audience is our public GOOGLE_CLIENT_ID.
 */
async function defaultVerifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const audience = process.env['GOOGLE_CLIENT_ID'];
  if (!audience || audience.length === 0) {
    throw new GoogleAuthError('google_not_configured', 'Google sign-in is not configured on the server');
  }

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(idToken, getGoogleJwks(), {
      issuer: GOOGLE_ISSUERS,
      audience,
    }));
  } catch (e) {
    throw new GoogleAuthError('invalid_google_token', e instanceof Error ? e.message : 'token verification failed');
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const emailRaw = payload['email'];
  const email = typeof emailRaw === 'string' ? emailRaw : '';
  const verifiedRaw = payload['email_verified'];
  const emailVerified = verifiedRaw === true || verifiedRaw === 'true';
  const nameRaw = payload['name'];
  const name = typeof nameRaw === 'string' ? nameRaw : null;

  if (!sub || !email) {
    throw new GoogleAuthError('invalid_google_token', 'Google token is missing required claims');
  }
  return { sub, email, emailVerified, name };
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

function err(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

async function readJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

const googleBody = z.object({
  id_token: z.string().min(1).max(8192),
  client_id: z.string().uuid(),
});

interface UserRow {
  id: string;
  email: string;
  role: string;
  display_name: string | null;
}

/**
 * Build the Google auth sub-router. Mount with
 * `app.route('/', buildAuthGoogleRouter(deps))`.
 */
export function buildAuthGoogleRouter(deps: GoogleRoutesDeps): Hono {
  const router = new Hono();
  const clock = deps.now ?? ((): Date => new Date());
  const verify = deps.verifyGoogleIdToken ?? defaultVerifyGoogleIdToken;

  router.post('/auth/google', async (c) => {
    const raw = await readJson(c.req.raw);
    if (raw === null) {
      return c.json(err('invalid_json', 'request body must be JSON'), 400);
    }
    const parsed = googleBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(err('invalid_input', 'id_token and client_id are required'), 400);
    }
    const { id_token: idToken, client_id: clientId } = parsed.data;

    // 1. Verify the Google ID token.
    let identity: GoogleIdentity;
    try {
      identity = await verify(idToken);
    } catch (e) {
      if (e instanceof GoogleAuthError && e.code === 'google_not_configured') {
        return c.json(err('google_not_configured', e.message), 503);
      }
      return c.json(err('invalid_google_token', 'Google sign-in could not be verified'), 401);
    }

    if (!identity.emailVerified) {
      return c.json(err('email_not_verified', 'Google account email is not verified'), 403);
    }

    const email = identity.email.toLowerCase();
    const now = clock();

    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');

      // 2a. Existing account linked by Google sub.
      let user = (
        await client.query<UserRow>(
          `SELECT id, email, role, display_name FROM users WHERE google_sub = $1`,
          [identity.sub],
        )
      ).rows[0];

      // 2b. Else an account with the same email — link Google to it.
      if (!user) {
        const byEmail = (
          await client.query<UserRow>(
            `SELECT id, email, role, display_name FROM users WHERE LOWER(email) = $1`,
            [email],
          )
        ).rows[0];
        if (byEmail) {
          await client.query(
            `UPDATE users
                SET google_sub = $1,
                    email_verified_at = COALESCE(email_verified_at, $2),
                    display_name = COALESCE(display_name, $3)
              WHERE id = $4`,
            [identity.sub, now.toISOString(), identity.name, byEmail.id],
          );
          user = byEmail;
        }
      }

      // 2c. Else create a new OAuth-only account (no password_hash).
      if (!user) {
        const newId = randomUUID();
        await client.query(
          `INSERT INTO users (id, email, google_sub, display_name, email_verified_at, role)
           VALUES ($1, $2, $3, $4, $5, 'user')`,
          [newId, email, identity.sub, identity.name, now.toISOString()],
        );
        user = { id: newId, email, role: 'user', display_name: identity.name ?? null };
      }

      // Re-read the authoritative role + display name (covers the bootstrap-admin
      // trigger that may promote the first-ever user to admin on insert).
      const fresh = (
        await client.query<{ role: string; display_name: string | null; email: string }>(
          `SELECT role, display_name, email FROM users WHERE id = $1`,
          [user.id],
        )
      ).rows[0];
      const role = (fresh?.role ?? user.role) as 'user' | 'admin';
      const displayName = fresh?.display_name ?? user.display_name;
      const userEmail = fresh?.email ?? user.email;

      // 3. Issue access token (60 min).
      const access = await signAccessToken({
        sub: user.id,
        role,
        clientId,
        email: userEmail,
        displayName,
      });

      // 4. Issue + persist refresh token (30 days), same as /auth/login.
      const refreshTokenRaw = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
      const refreshTokenHash = sha256Hex(refreshTokenRaw);
      const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
      await client.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, client_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          user.id,
          refreshTokenHash,
          clientId,
          refreshExpiresAt.toISOString(),
          now.toISOString(),
        ],
      );

      await client.query('COMMIT');

      return c.json({
        access_token: access.token,
        refresh_token: refreshTokenRaw,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        role,
        display_name: displayName,
      });
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // connection already torn down
      }
      throw e;
    } finally {
      client.release();
    }
  });

  return router;
}
