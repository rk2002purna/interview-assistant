import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { randomUUID } from 'node:crypto';

/**
 * JWT helpers for the Auth_Service.
 *
 * Access tokens are HS256 JWTs signed with the server-held `JWT_SECRET`.
 * Claims required by the design (Auth_Service section, Requirement 1.2):
 *   - sub:       the user id
 *   - role:      'user' | 'admin'
 *   - client_id: the install id bound at issuance (Requirement 13.5)
 *   - iat / exp: issued-at and expiry (60 minute TTL)
 *   - jti:       unique token id for replay tracking and revocation
 *
 * The middleware in `src/http/middleware.ts` consumes `verifyAccess` and
 * maps the typed errors thrown here onto HTTP responses; callers therefore
 * never need to inspect raw `jose` errors.
 */

/** Access token TTL in seconds. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export type Role = 'user' | 'admin';

/** Verified access token claims surfaced to handlers. */
export interface AccessTokenClaims {
  sub: string;
  role: Role;
  client_id: string;
  email?: string;
  display_name?: string;
}

/** Inputs accepted by `signAccessToken`. */
export interface SignAccessTokenInput {
  sub: string;
  role: Role;
  clientId: string;
  /** Email address to include in the token payload. */
  email?: string | null;
  /** Optional display name to include in the token payload. */
  displayName?: string | null;
  /** Optional override for `jti`; primarily used by tests. */
  jti?: string;
  /**
   * Optional override for `iat` (seconds since epoch). Primarily used by
   * tests that need deterministic timestamps.
   */
  nowSeconds?: number;
}

/** Result returned by `signAccessToken`. */
export interface SignedAccessToken {
  token: string;
  jti: string;
  /** Expiry as a unix timestamp in seconds. */
  expiresAt: number;
  /** TTL in seconds (always equals {@link ACCESS_TOKEN_TTL_SECONDS}). */
  expiresIn: number;
}

/** Base class for all JWT-related errors thrown by this module. */
export class JwtError extends Error {
  /** Stable machine-readable error code suitable for HTTP error envelopes. */
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'JwtError';
    this.code = code;
  }
}

/** The token is malformed, has an invalid signature, or claims are wrong. */
export class InvalidTokenError extends JwtError {
  public constructor(message = 'invalid token') {
    super('invalid_token', message);
    this.name = 'InvalidTokenError';
  }
}

/** The token parsed and verified but is past its `exp`. */
export class TokenExpiredError extends JwtError {
  public constructor(message = 'token expired') {
    super('token_expired', message);
    this.name = 'TokenExpiredError';
  }
}

const HS256_ALG = 'HS256';

let cachedSecretMaterial: Uint8Array | undefined;
let cachedSecretSource: string | undefined;

function getSecretKey(): Uint8Array {
  const secret = process.env['JWT_SECRET'];
  if (!secret || secret.length === 0) {
    throw new Error('JWT_SECRET is not configured');
  }
  if (cachedSecretMaterial && cachedSecretSource === secret) {
    return cachedSecretMaterial;
  }
  cachedSecretMaterial = new TextEncoder().encode(secret);
  cachedSecretSource = secret;
  return cachedSecretMaterial;
}

function isRole(value: unknown): value is Role {
  return value === 'user' || value === 'admin';
}

/**
 * Sign a new access token with a 60-minute TTL.
 *
 * Throws synchronously if `JWT_SECRET` is not configured. All other failures
 * surface as rejected promises.
 */
export async function signAccessToken(
  input: SignAccessTokenInput,
): Promise<SignedAccessToken> {
  const key = getSecretKey();
  const jti = input.jti ?? randomUUID();
  const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + ACCESS_TOKEN_TTL_SECONDS;

  const payload: Record<string, unknown> = {
    role: input.role,
    client_id: input.clientId,
  };
  if (input.email) {
    payload.email = input.email;
  }
  if (input.displayName) {
    payload.display_name = input.displayName;
  }

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: HS256_ALG, typ: 'JWT' })
    .setSubject(input.sub)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);

  return { token, jti, expiresAt: exp, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Verify an access token and return its identity claims.
 *
 * Throws {@link TokenExpiredError} if the token's `exp` has passed and
 * {@link InvalidTokenError} for any other validation failure (bad signature,
 * malformed token, wrong algorithm, missing or malformed claims).
 */
export async function verifyAccess(token: string): Promise<AccessTokenClaims> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new InvalidTokenError('token is empty');
  }

  const key = getSecretKey();

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(token, key, { algorithms: [HS256_ALG] }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new TokenExpiredError();
    }
    if (err instanceof joseErrors.JOSEError) {
      throw new InvalidTokenError(err.message);
    }
    throw new InvalidTokenError('token verification failed');
  }

  const { sub, role, client_id: clientId, email, display_name: displayName } = payload as {
    sub?: unknown;
    role?: unknown;
    client_id?: unknown;
    email?: unknown;
    display_name?: unknown;
  };

  if (typeof sub !== 'string' || sub.length === 0) {
    throw new InvalidTokenError('missing sub claim');
  }
  if (!isRole(role)) {
    throw new InvalidTokenError('missing or invalid role claim');
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new InvalidTokenError('missing client_id claim');
  }

  const claims: AccessTokenClaims = { sub, role, client_id: clientId };
  if (typeof email === 'string' && email.length > 0) {
    claims.email = email;
  }
  if (typeof displayName === 'string' && displayName.length > 0) {
    claims.display_name = displayName;
  }
  return claims;
}
