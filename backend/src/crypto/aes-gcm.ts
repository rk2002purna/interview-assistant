/**
 * AES-256-GCM envelope encryption with HKDF-SHA256 subkey derivation.
 *
 * Implements the design's "Provider keys encrypted with AES-256-GCM using a
 * key derived (HKDF-SHA256) from a server-held master secret" decision and
 * matches the column shape in migration 0005 (`provider_keys`):
 *
 *   - `ciphertext` : raw AES-256-GCM ciphertext (no auth tag appended)
 *   - `nonce`     : 12 random bytes per call
 *   - `auth_tag`  : 16-byte GCM authentication tag
 *
 * The master key is read from the `MASTER_ENCRYPTION_KEY` environment
 * variable as base64-encoded 32 bytes (256 bits). HKDF derives a per-record
 * subkey from the master, with a caller-supplied `info` parameter binding
 * the subkey to a record context (e.g. `provider:gemini`). Nonces are
 * sampled fresh from `crypto.randomBytes` on every encryption, so the
 * GCM (key, nonce) uniqueness invariant is preserved even when many records
 * share an `info` value.
 *
 * The module deliberately uses only Node's built-in `crypto` and exposes a
 * small, side-effect-free API so it can be unit tested without a database.
 *
 * Requirements: 4.2, 4.4.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * AES-256-GCM key length in bytes. AES-256 requires a 32-byte key.
 */
const SUBKEY_LENGTH_BYTES = 32;

/**
 * GCM nonce length in bytes. NIST SP 800-38D recommends 12 bytes; this also
 * matches the `octet_length(nonce) = 12` CHECK constraint in migration 0005.
 */
const NONCE_LENGTH_BYTES = 12;

/**
 * GCM authentication tag length in bytes. 16 bytes is the maximum and matches
 * the `octet_length(auth_tag) = 16` CHECK constraint in migration 0005.
 */
const AUTH_TAG_LENGTH_BYTES = 16;

/**
 * The required length, in bytes, of the decoded master encryption key.
 */
const MASTER_KEY_LENGTH_BYTES = 32;

/**
 * Fixed application-domain salt for HKDF. Using a non-empty, namespaced salt
 * binds derivation to this application and prevents accidental cross-domain
 * subkey collisions if the master key were ever reused. It is intentionally
 * a constant (rather than per-record randomness) because per-record salt has
 * no storage column in `provider_keys`; per-record uniqueness is provided by
 * the caller-supplied `info` parameter and the random GCM nonce.
 */
const HKDF_SALT = Buffer.from(
  'interview-assistant.credits-and-subscription-system.v1',
  'utf8',
);

/**
 * Default `info` value used when the caller does not pass one. Concrete
 * call sites (e.g. provider key storage) should always pass an explicit,
 * record-scoped `info` value; the default exists so the module is safe to
 * exercise in isolation by tests.
 */
const DEFAULT_INFO = Buffer.from('default', 'utf8');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The persisted shape of an AES-256-GCM ciphertext envelope. Mirrors the
 * `ciphertext` / `nonce` / `auth_tag` columns of `provider_keys`.
 */
export interface EncryptionEnvelope {
  /** Raw AES-256-GCM ciphertext. Length equals plaintext length. */
  ciphertext: Buffer;
  /** 12 random bytes generated per call. */
  nonce: Buffer;
  /** 16-byte GCM authentication tag. */
  authTag: Buffer;
}

// ---------------------------------------------------------------------------
// Master key loading
// ---------------------------------------------------------------------------

/**
 * Cached decoded master key. Populated lazily on first use so that tests can
 * set `MASTER_ENCRYPTION_KEY` after import, and reset between tests via
 * {@link resetMasterKeyForTesting}.
 */
let cachedMasterKey: Buffer | null = null;

/**
 * Decode and validate the master key from the environment.
 *
 * Throws a descriptive error rather than returning a degraded value because
 * a misconfigured master key is a deployment bug that must surface loudly.
 */
function loadMasterKey(): Buffer {
  if (cachedMasterKey !== null) {
    return cachedMasterKey;
  }

  const raw = process.env['MASTER_ENCRYPTION_KEY'];
  if (raw === undefined || raw === '') {
    throw new Error(
      'MASTER_ENCRYPTION_KEY is not set. Provide a base64-encoded 32-byte key.',
    );
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('MASTER_ENCRYPTION_KEY is not valid base64.');
  }

  // Buffer.from never throws on invalid base64; it silently drops bad bytes.
  // Verify by re-encoding and comparing length.
  if (decoded.length !== MASTER_KEY_LENGTH_BYTES) {
    throw new Error(
      `MASTER_ENCRYPTION_KEY must decode to exactly ${MASTER_KEY_LENGTH_BYTES} ` +
        `bytes (got ${decoded.length}).`,
    );
  }

  cachedMasterKey = decoded;
  return cachedMasterKey;
}

/**
 * Clear the cached master key. Intended for tests that need to swap the
 * `MASTER_ENCRYPTION_KEY` between cases. Not exported on the production
 * surface in any other form.
 */
export function resetMasterKeyForTesting(): void {
  cachedMasterKey = null;
}

// ---------------------------------------------------------------------------
// Subkey derivation
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte AES-256 subkey from the master key using HKDF-SHA256.
 *
 * The same `info` value always produces the same subkey for a given master
 * key. Per-call uniqueness is provided by the random GCM nonce, not by the
 * subkey, so callers may safely reuse `info` across many encryptions for
 * the same logical record.
 */
function deriveSubkey(info: Buffer): Buffer {
  const master = loadMasterKey();
  // `hkdfSync` returns an ArrayBuffer; wrap it in a Node Buffer for ergonomic
  // use with the cipher APIs below.
  const derived = hkdfSync(
    'sha256',
    master,
    HKDF_SALT,
    info,
    SUBKEY_LENGTH_BYTES,
  );
  return Buffer.from(derived);
}

/**
 * Normalize the caller-supplied `info` argument to a Buffer. Accepting both
 * `string` and `Buffer` keeps call sites tidy ("provider:gemini") without
 * sacrificing the ability to pass arbitrary binary context.
 */
function toInfoBuffer(info: Buffer | string | undefined): Buffer {
  if (info === undefined) {
    return DEFAULT_INFO;
  }
  if (typeof info === 'string') {
    return Buffer.from(info, 'utf8');
  }
  return info;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt `plaintext` under an HKDF-derived subkey using AES-256-GCM.
 *
 * @param plaintext A string (encoded as UTF-8) or raw bytes.
 * @param info      Optional record-scoping context for subkey derivation.
 *                  Concrete call sites should pass a stable, record-unique
 *                  string (e.g. `provider:gemini`).
 * @returns         A persistence-ready envelope. The fields map directly to
 *                  the `ciphertext`, `nonce`, and `auth_tag` columns of
 *                  `provider_keys`.
 *
 * Each call samples a fresh 12-byte nonce from the OS CSPRNG, satisfying
 * GCM's nonce-uniqueness requirement under a fixed (subkey, nonce) pair.
 */
export function encrypt(
  plaintext: string | Buffer,
  info?: Buffer | string,
): EncryptionEnvelope {
  const subkey = deriveSubkey(toInfoBuffer(info));
  const nonce = randomBytes(NONCE_LENGTH_BYTES);

  const cipher = createCipheriv('aes-256-gcm', subkey, nonce, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });

  const plaintextBuf =
    typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;

  const ciphertext = Buffer.concat([
    cipher.update(plaintextBuf),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Defensive sanity checks: the constants above guarantee these lengths,
  // but verifying here keeps any future cipher misconfiguration from
  // silently producing rows that violate the migration's CHECK constraints.
  if (nonce.length !== NONCE_LENGTH_BYTES) {
    throw new Error(`GCM nonce length must be ${NONCE_LENGTH_BYTES} bytes.`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error(
      `GCM auth tag length must be ${AUTH_TAG_LENGTH_BYTES} bytes.`,
    );
  }

  return { ciphertext, nonce, authTag };
}

/**
 * Decrypt an {@link EncryptionEnvelope} produced by {@link encrypt}.
 *
 * The same `info` value used at encryption time must be supplied; otherwise
 * subkey derivation produces a different key and the GCM authentication
 * tag check fails, raising an error.
 *
 * @returns The original plaintext as a Buffer. Callers that need a string
 *          can call `.toString('utf8')` themselves.
 *
 * @throws  Error when the envelope fails authentication (tampered ciphertext,
 *          wrong `info`, wrong master key, or truncated/extended buffers).
 */
export function decrypt(
  envelope: EncryptionEnvelope,
  info?: Buffer | string,
): Buffer {
  if (envelope.nonce.length !== NONCE_LENGTH_BYTES) {
    throw new Error(`Invalid envelope: nonce must be ${NONCE_LENGTH_BYTES} bytes.`);
  }
  if (envelope.authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error(
      `Invalid envelope: authTag must be ${AUTH_TAG_LENGTH_BYTES} bytes.`,
    );
  }

  const subkey = deriveSubkey(toInfoBuffer(info));

  const decipher = createDecipheriv('aes-256-gcm', subkey, envelope.nonce, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  decipher.setAuthTag(envelope.authTag);

  // `decipher.final()` raises if the auth tag does not validate, which is
  // the single source of truth for "this envelope is genuine and intact".
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
}
