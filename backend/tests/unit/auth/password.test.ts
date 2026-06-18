import { describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import {
  ARGON2_PARAMS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_SALT_BYTES,
  PasswordPolicyError,
  hash,
  validatePolicy,
  verify,
} from '../../../src/auth/password.js';

const VALID_PASSWORD = 'Aa1!aaaaaaaa'; // 12 chars, all four classes
const STRONG_PASSWORD = 'Str0ngP@ssw0rd!';

describe('password.validatePolicy', () => {
  it('accepts a 12-char password containing all four classes', () => {
    expect(validatePolicy(VALID_PASSWORD)).toEqual({ valid: true });
  });

  it('accepts a 128-char password containing all four classes', () => {
    const pw = 'Aa1!' + 'a'.repeat(MAX_PASSWORD_LENGTH - 4);
    expect(pw.length).toBe(MAX_PASSWORD_LENGTH);
    expect(validatePolicy(pw)).toEqual({ valid: true });
  });

  it('rejects passwords shorter than the minimum length', () => {
    const pw = 'Aa1!aaaaaaa'; // 11 chars
    expect(pw.length).toBe(MIN_PASSWORD_LENGTH - 1);
    expect(validatePolicy(pw)).toMatchObject({
      valid: false,
      code: 'password_too_short',
    });
  });

  it('rejects passwords longer than the maximum length', () => {
    const pw = 'Aa1!' + 'a'.repeat(MAX_PASSWORD_LENGTH);
    expect(pw.length).toBe(MAX_PASSWORD_LENGTH + 4);
    expect(validatePolicy(pw)).toMatchObject({
      valid: false,
      code: 'password_too_long',
    });
  });

  it('rejects when missing a lowercase letter', () => {
    expect(validatePolicy('AAAA1111!!!!')).toMatchObject({
      valid: false,
      code: 'password_missing_lowercase',
    });
  });

  it('rejects when missing an uppercase letter', () => {
    expect(validatePolicy('aaaa1111!!!!')).toMatchObject({
      valid: false,
      code: 'password_missing_uppercase',
    });
  });

  it('rejects when missing a digit', () => {
    expect(validatePolicy('Aaaaaaaa!!!!')).toMatchObject({
      valid: false,
      code: 'password_missing_digit',
    });
  });

  it('rejects when missing a symbol', () => {
    expect(validatePolicy('Aaaaaaaa1111')).toMatchObject({
      valid: false,
      code: 'password_missing_symbol',
    });
  });

  it('rejects non-string inputs', () => {
    expect(validatePolicy(undefined)).toMatchObject({
      valid: false,
      code: 'password_not_a_string',
    });
    expect(validatePolicy(12345678)).toMatchObject({
      valid: false,
      code: 'password_not_a_string',
    });
    expect(validatePolicy(null)).toMatchObject({
      valid: false,
      code: 'password_not_a_string',
    });
  });
});

describe('password.hash', () => {
  it('produces an Argon2id encoded hash with the configured parameters', async () => {
    const encoded = await hash(STRONG_PASSWORD);

    expect(encoded.startsWith('$argon2id$')).toBe(true);
    // Encoded format includes m=, t=, p= for the parameters.
    expect(encoded).toMatch(/m=65536/);
    expect(encoded).toMatch(/t=3/);
    expect(encoded).toMatch(/p=1/);
  });

  it('uses a per-call random salt of at least 16 bytes', async () => {
    const a = await hash(STRONG_PASSWORD);
    const b = await hash(STRONG_PASSWORD);

    // Different salts ⇒ different encoded hashes for the same password.
    expect(a).not.toBe(b);

    // The encoded format places the salt as the second-to-last segment in
    // base64 (no padding). Decode and assert ≥ 16 bytes.
    const segments = a.split('$');
    const saltSegment = segments[segments.length - 2] ?? '';
    const saltBytes = Buffer.from(saltSegment, 'base64').length;
    expect(saltBytes).toBeGreaterThanOrEqual(PASSWORD_SALT_BYTES);
  });

  it('throws PasswordPolicyError for passwords that fail the policy', async () => {
    await expect(hash('short')).rejects.toBeInstanceOf(PasswordPolicyError);
    await expect(hash('alllowercase1!!!')).rejects.toMatchObject({
      code: 'password_missing_uppercase',
    });
  });

  it('does not embed the plaintext password in the encoded hash', async () => {
    const encoded = await hash(STRONG_PASSWORD);
    expect(encoded).not.toContain(STRONG_PASSWORD);
  });
});

describe('password.verify', () => {
  it('returns true for a matching password', async () => {
    const encoded = await hash(STRONG_PASSWORD);
    await expect(verify(encoded, STRONG_PASSWORD)).resolves.toBe(true);
  });

  it('returns false for a non-matching password', async () => {
    const encoded = await hash(STRONG_PASSWORD);
    await expect(verify(encoded, STRONG_PASSWORD + 'x')).resolves.toBe(false);
    await expect(verify(encoded, 'Different1!aa')).resolves.toBe(false);
  });

  it('returns false for malformed or empty hashes without throwing', async () => {
    await expect(verify('', STRONG_PASSWORD)).resolves.toBe(false);
    await expect(verify('not-a-hash', STRONG_PASSWORD)).resolves.toBe(false);
    await expect(verify('$argon2id$broken', STRONG_PASSWORD)).resolves.toBe(false);
  });

  it('returns false for empty candidate passwords', async () => {
    const encoded = await hash(STRONG_PASSWORD);
    await expect(verify(encoded, '')).resolves.toBe(false);
  });

  it('verifies a hash produced by argon2 with the same parameters', async () => {
    // Sanity-check that the exported ARGON2_PARAMS match what argon2 expects.
    const encoded = await argon2.hash(STRONG_PASSWORD, {
      type: ARGON2_PARAMS.type,
      memoryCost: ARGON2_PARAMS.memoryCost,
      timeCost: ARGON2_PARAMS.timeCost,
      parallelism: ARGON2_PARAMS.parallelism,
    });
    await expect(verify(encoded, STRONG_PASSWORD)).resolves.toBe(true);
  });
});
