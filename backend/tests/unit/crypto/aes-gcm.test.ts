/**
 * Unit tests for the AES-256-GCM encryption module.
 *
 * These tests exercise the public surface (encrypt / decrypt) and the
 * configuration loading behavior. Property-based round-trip / nonce
 * uniqueness coverage lives in a sibling task (3.2) and is intentionally
 * out of scope here.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  decrypt,
  encrypt,
  resetMasterKeyForTesting,
} from '../../../src/crypto/aes-gcm.js';

const ORIGINAL_KEY = process.env['MASTER_ENCRYPTION_KEY'];

function setMasterKey(): void {
  process.env['MASTER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
  resetMasterKeyForTesting();
}

describe('crypto/aes-gcm', () => {
  beforeAll(() => {
    setMasterKey();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env['MASTER_ENCRYPTION_KEY'];
    } else {
      process.env['MASTER_ENCRYPTION_KEY'] = ORIGINAL_KEY;
    }
    resetMasterKeyForTesting();
    setMasterKey();
  });

  describe('encrypt', () => {
    it('returns an envelope whose lengths match the migration 0005 columns', () => {
      const env = encrypt('a-secret-provider-key', 'provider:gemini');
      expect(env.nonce).toHaveLength(12);
      expect(env.authTag).toHaveLength(16);
      // GCM ciphertext length equals plaintext length.
      expect(env.ciphertext).toHaveLength(
        Buffer.byteLength('a-secret-provider-key', 'utf8'),
      );
    });

    it('uses a fresh random nonce on every call', () => {
      const a = encrypt('key', 'provider:groq');
      const b = encrypt('key', 'provider:groq');
      expect(a.nonce.equals(b.nonce)).toBe(false);
      // Different nonces under the same key/plaintext yield different ciphertexts.
      expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    });

    it('accepts both string and Buffer plaintext', () => {
      const fromString = encrypt('hello', 'ctx');
      const fromBuffer = encrypt(Buffer.from('hello', 'utf8'), 'ctx');
      expect(decrypt(fromString, 'ctx').toString('utf8')).toBe('hello');
      expect(decrypt(fromBuffer, 'ctx').toString('utf8')).toBe('hello');
    });
  });

  describe('decrypt', () => {
    it('round-trips arbitrary plaintexts', () => {
      const plaintext = 'sk-live-' + randomBytes(24).toString('hex');
      const env = encrypt(plaintext, 'provider:deepseek');
      expect(decrypt(env, 'provider:deepseek').toString('utf8')).toBe(plaintext);
    });

    it('round-trips empty plaintext', () => {
      const env = encrypt('', 'provider:cerebras');
      expect(env.ciphertext).toHaveLength(0);
      expect(decrypt(env, 'provider:cerebras').toString('utf8')).toBe('');
    });

    it('fails authentication when info differs', () => {
      const env = encrypt('secret', 'provider:gemini');
      expect(() => decrypt(env, 'provider:groq')).toThrow();
    });

    it('fails authentication when ciphertext is tampered', () => {
      const env = encrypt('secret', 'ctx');
      // Flip a bit in the ciphertext.
      const tampered = Buffer.from(env.ciphertext);
      if (tampered.length > 0) {
        tampered[0] = (tampered[0] ?? 0) ^ 0x01;
      } else {
        // Empty plaintext: tamper the auth tag instead.
        env.authTag[0] = (env.authTag[0] ?? 0) ^ 0x01;
      }
      expect(() =>
        decrypt(
          {
            ciphertext: tampered.length > 0 ? tampered : env.ciphertext,
            nonce: env.nonce,
            authTag: env.authTag,
          },
          'ctx',
        ),
      ).toThrow();
    });

    it('fails authentication when authTag is tampered', () => {
      const env = encrypt('secret', 'ctx');
      const tag = Buffer.from(env.authTag);
      tag[0] = (tag[0] ?? 0) ^ 0x01;
      expect(() =>
        decrypt({ ciphertext: env.ciphertext, nonce: env.nonce, authTag: tag }, 'ctx'),
      ).toThrow();
    });

    it('rejects envelopes with a non-12-byte nonce', () => {
      const env = encrypt('secret', 'ctx');
      expect(() =>
        decrypt(
          {
            ciphertext: env.ciphertext,
            nonce: Buffer.alloc(11),
            authTag: env.authTag,
          },
          'ctx',
        ),
      ).toThrow(/nonce/);
    });

    it('rejects envelopes with a non-16-byte authTag', () => {
      const env = encrypt('secret', 'ctx');
      expect(() =>
        decrypt(
          {
            ciphertext: env.ciphertext,
            nonce: env.nonce,
            authTag: Buffer.alloc(15),
          },
          'ctx',
        ),
      ).toThrow(/authTag/);
    });
  });

  describe('master key loading', () => {
    beforeEach(() => {
      resetMasterKeyForTesting();
    });

    it('throws when MASTER_ENCRYPTION_KEY is unset', () => {
      delete process.env['MASTER_ENCRYPTION_KEY'];
      resetMasterKeyForTesting();
      expect(() => encrypt('x', 'ctx')).toThrow(/MASTER_ENCRYPTION_KEY/);
    });

    it('throws when MASTER_ENCRYPTION_KEY decodes to the wrong length', () => {
      process.env['MASTER_ENCRYPTION_KEY'] = Buffer.from('too-short').toString(
        'base64',
      );
      resetMasterKeyForTesting();
      expect(() => encrypt('x', 'ctx')).toThrow(/32/);
    });
  });
});
