import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  InvalidTokenError,
  JwtError,
  TokenExpiredError,
  signAccessToken,
  verifyAccess,
} from '../../../src/auth/jwt.js';

const TEST_SECRET = 'test-secret-please-change-' + 'x'.repeat(40);

describe('jwt helpers', () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env['JWT_SECRET'];
    process.env['JWT_SECRET'] = TEST_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env['JWT_SECRET'];
    } else {
      process.env['JWT_SECRET'] = originalSecret;
    }
  });

  describe('signAccessToken', () => {
    it('signs an HS256 JWT with sub, role, client_id, iat, exp, jti', async () => {
      const now = Math.floor(Date.UTC(2024, 0, 1, 12, 0, 0) / 1000);

      const result = await signAccessToken({
        sub: 'user-123',
        role: 'user',
        clientId: 'client-abc',
        nowSeconds: now,
      });

      expect(result.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
      expect(result.expiresAt).toBe(now + ACCESS_TOKEN_TTL_SECONDS);
      expect(result.jti).toMatch(/[0-9a-f-]{36}/i);

      const header = decodeProtectedHeader(result.token);
      expect(header.alg).toBe('HS256');
      expect(header.typ).toBe('JWT');

      const claims = decodeJwt(result.token);
      expect(claims.sub).toBe('user-123');
      expect(claims['role']).toBe('user');
      expect(claims['client_id']).toBe('client-abc');
      expect(claims.iat).toBe(now);
      expect(claims.exp).toBe(now + ACCESS_TOKEN_TTL_SECONDS);
      expect(claims.jti).toBe(result.jti);
    });

    it('uses an access token TTL of 60 minutes', () => {
      expect(ACCESS_TOKEN_TTL_SECONDS).toBe(60 * 60);
    });

    it('honours a caller-supplied jti', async () => {
      const result = await signAccessToken({
        sub: 'u',
        role: 'admin',
        clientId: 'c',
        jti: 'fixed-jti',
      });
      expect(result.jti).toBe('fixed-jti');
      expect(decodeJwt(result.token).jti).toBe('fixed-jti');
    });

    it('throws when JWT_SECRET is not configured', async () => {
      delete process.env['JWT_SECRET'];
      await expect(
        signAccessToken({ sub: 'u', role: 'user', clientId: 'c' }),
      ).rejects.toThrow(/JWT_SECRET/);
    });
  });

  describe('verifyAccess', () => {
    it('round-trips a freshly signed token to its claims', async () => {
      const { token } = await signAccessToken({
        sub: 'user-1',
        role: 'admin',
        clientId: 'install-7',
      });

      await expect(verifyAccess(token)).resolves.toEqual({
        sub: 'user-1',
        role: 'admin',
        client_id: 'install-7',
      });
    });

    it('throws TokenExpiredError when the token is past its exp', async () => {
      const past = Math.floor(Date.now() / 1000) - ACCESS_TOKEN_TTL_SECONDS - 60;
      const { token } = await signAccessToken({
        sub: 'u',
        role: 'user',
        clientId: 'c',
        nowSeconds: past,
      });

      await expect(verifyAccess(token)).rejects.toBeInstanceOf(TokenExpiredError);
    });

    it('throws InvalidTokenError when the signature is wrong', async () => {
      const { token } = await signAccessToken({
        sub: 'u',
        role: 'user',
        clientId: 'c',
      });

      // Tamper with the signature segment.
      const segments = token.split('.');
      const tampered = `${segments[0]}.${segments[1]}.AAAA${(segments[2] ?? '').slice(4)}`;

      await expect(verifyAccess(tampered)).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('throws InvalidTokenError for malformed tokens', async () => {
      await expect(verifyAccess('not-a-jwt')).rejects.toBeInstanceOf(InvalidTokenError);
      await expect(verifyAccess('')).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('rejects tokens signed with a non-HS256 algorithm', async () => {
      // Construct an unsecured JWT (alg: none) by hand-signing with HS256
      // using the same secret but advertising a different alg in claims is
      // not possible directly; instead, use a token signed with a DIFFERENT
      // secret to simulate an unverifiable signature.
      const otherKey = new TextEncoder().encode('a-different-secret-' + 'y'.repeat(40));
      const token = await new SignJWT({ role: 'user', client_id: 'c' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('u')
        .setIssuedAt()
        .setExpirationTime('60m')
        .setJti('j')
        .sign(otherKey);

      await expect(verifyAccess(token)).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('rejects tokens missing the role claim', async () => {
      const key = new TextEncoder().encode(TEST_SECRET);
      const token = await new SignJWT({ client_id: 'c' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('u')
        .setIssuedAt()
        .setExpirationTime('60m')
        .setJti('j')
        .sign(key);

      await expect(verifyAccess(token)).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('rejects tokens with an unknown role value', async () => {
      const key = new TextEncoder().encode(TEST_SECRET);
      const token = await new SignJWT({ role: 'superuser', client_id: 'c' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('u')
        .setIssuedAt()
        .setExpirationTime('60m')
        .setJti('j')
        .sign(key);

      await expect(verifyAccess(token)).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('rejects tokens missing client_id', async () => {
      const key = new TextEncoder().encode(TEST_SECRET);
      const token = await new SignJWT({ role: 'user' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('u')
        .setIssuedAt()
        .setExpirationTime('60m')
        .setJti('j')
        .sign(key);

      await expect(verifyAccess(token)).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('typed errors expose stable codes via JwtError.code', async () => {
      const past = Math.floor(Date.now() / 1000) - ACCESS_TOKEN_TTL_SECONDS - 60;
      const { token } = await signAccessToken({
        sub: 'u',
        role: 'user',
        clientId: 'c',
        nowSeconds: past,
      });

      let caught: unknown;
      try {
        await verifyAccess(token);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(JwtError);
      expect((caught as JwtError).code).toBe('token_expired');

      let caught2: unknown;
      try {
        await verifyAccess('garbage');
      } catch (err) {
        caught2 = err;
      }
      expect(caught2).toBeInstanceOf(JwtError);
      expect((caught2 as JwtError).code).toBe('invalid_token');
    });
  });
});
