import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

/**
 * Password hashing and validation for the Auth_Service.
 *
 * Hashing uses Argon2id with the parameters mandated by the design
 * (Auth_Service section, Requirement 1.8):
 *   - memory cost: 64 MiB (65536 KiB)
 *   - time cost:   3
 *   - parallelism: 1
 *   - salt:        per-user, 16 random bytes (argon2's encoded format
 *                  records the salt alongside the hash)
 *
 * Policy validation follows Requirement 1.3: 12–128 characters with at
 * least one uppercase letter, one lowercase letter, one digit, and one
 * symbol (any non-alphanumeric printable character).
 */

/** Minimum password length per Requirement 1.3. */
export const MIN_PASSWORD_LENGTH = 12;
/** Maximum password length per Requirement 1.3. */
export const MAX_PASSWORD_LENGTH = 128;
/** Salt length in bytes; design mandates ≥ 16 bytes. */
export const PASSWORD_SALT_BYTES = 16;

/** Argon2id parameters (m=64 MiB, t=3, p=1). */
export const ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
} as const;

/** Stable machine-readable codes for password policy violations. */
export type PasswordPolicyCode =
  | 'password_not_a_string'
  | 'password_too_short'
  | 'password_too_long'
  | 'password_missing_lowercase'
  | 'password_missing_uppercase'
  | 'password_missing_digit'
  | 'password_missing_symbol';

/** Result returned by {@link validatePolicy}. */
export type PasswordPolicyResult =
  | { valid: true }
  | { valid: false; code: PasswordPolicyCode; message: string };

/** Thrown by {@link hash} when the supplied password fails policy. */
export class PasswordPolicyError extends Error {
  public readonly code: PasswordPolicyCode;

  public constructor(code: PasswordPolicyCode, message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
    this.code = code;
  }
}

const LOWERCASE_RE = /[a-z]/;
const UPPERCASE_RE = /[A-Z]/;
const DIGIT_RE = /[0-9]/;
// "Symbol" = any non-alphanumeric character. Whitespace counts as a symbol
// only if it is a printable separator that the user typed; we accept any
// character outside [A-Za-z0-9].
const SYMBOL_RE = /[^A-Za-z0-9]/;

/**
 * Validate a password against the Auth_Service policy (Requirement 1.3).
 *
 * Returns a discriminated result rather than throwing so callers can map
 * specific violations to API error responses without exception handling.
 */
export function validatePolicy(password: unknown): PasswordPolicyResult {
  if (typeof password !== 'string') {
    return {
      valid: false,
      code: 'password_not_a_string',
      message: 'password must be a string',
    };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      valid: false,
      code: 'password_too_short',
      message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      valid: false,
      code: 'password_too_long',
      message: `password must be at most ${MAX_PASSWORD_LENGTH} characters`,
    };
  }
  if (!LOWERCASE_RE.test(password)) {
    return {
      valid: false,
      code: 'password_missing_lowercase',
      message: 'password must contain at least one lowercase letter',
    };
  }
  if (!UPPERCASE_RE.test(password)) {
    return {
      valid: false,
      code: 'password_missing_uppercase',
      message: 'password must contain at least one uppercase letter',
    };
  }
  if (!DIGIT_RE.test(password)) {
    return {
      valid: false,
      code: 'password_missing_digit',
      message: 'password must contain at least one digit',
    };
  }
  if (!SYMBOL_RE.test(password)) {
    return {
      valid: false,
      code: 'password_missing_symbol',
      message: 'password must contain at least one symbol',
    };
  }
  return { valid: true };
}

/**
 * Hash a password with Argon2id using a fresh 16-byte random salt.
 *
 * Throws {@link PasswordPolicyError} when the password fails the policy.
 * The returned string is the standard Argon2 encoded hash (`$argon2id$...`)
 * which carries the salt and parameters so {@link verify} needs only the
 * stored hash plus the candidate password.
 */
export async function hash(password: string): Promise<string> {
  const result = validatePolicy(password);
  if (!result.valid) {
    throw new PasswordPolicyError(result.code, result.message);
  }

  const salt = randomBytes(PASSWORD_SALT_BYTES);
  return argon2.hash(password, {
    ...ARGON2_PARAMS,
    salt,
  });
}

/**
 * Verify a candidate password against a stored Argon2 encoded hash.
 *
 * Returns false on any verification failure (mismatch, malformed hash,
 * unsupported algorithm, etc.) so callers can treat the verification step
 * as a single boolean gate without distinguishing failure causes (which
 * would leak information per Requirement 1.9 / disclosure-safe responses).
 */
export async function verify(
  storedHash: string,
  candidate: string,
): Promise<boolean> {
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    return false;
  }
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return false;
  }
  try {
    return await argon2.verify(storedHash, candidate);
  } catch {
    return false;
  }
}
