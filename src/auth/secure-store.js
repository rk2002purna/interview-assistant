'use strict';

const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * Secure store wrapper for persisting sensitive data (tokens, client IDs).
 *
 * Uses Electron's safeStorage API (backed by Windows DPAPI / macOS Keychain /
 * libsecret on Linux) when available. Falls back to a JSON file with
 * owner-only permissions (POSIX 0600) under app.getPath('userData').
 *
 * Requirement 13.4: Never writes to a world- or group-readable location.
 */

const STORE_FILENAME = 'secure-store.json';

/**
 * Returns true if Electron's safeStorage encryption is available on this platform.
 */
function isSafeStorageAvailable() {
  try {
    return safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Returns the path to the fallback JSON store file.
 */
function getStorePath() {
  const userDataDir = app.getPath('userData');
  return path.join(userDataDir, STORE_FILENAME);
}

/**
 * Reads the fallback JSON store from disk.
 * Returns an empty object if the file does not exist or is unreadable.
 */
function readFallbackStore() {
  const storePath = getStorePath();
  try {
    if (!fs.existsSync(storePath)) {
      return {};
    }
    const raw = fs.readFileSync(storePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Writes the fallback JSON store to disk with owner-only permissions.
 * On POSIX systems, the file is created with mode 0600.
 * On Windows, the file is written to the user's app data directory which
 * is already restricted to the current user by default.
 */
function writeFallbackStore(data) {
  const storePath = getStorePath();
  const dir = path.dirname(storePath);

  // Ensure the directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const content = JSON.stringify(data, null, 2);

  if (process.platform === 'win32') {
    // On Windows, app.getPath('userData') is under %APPDATA% which is
    // user-scoped by default. Write normally.
    fs.writeFileSync(storePath, content, { encoding: 'utf8' });
  } else {
    // On POSIX (macOS, Linux), enforce mode 0600 (owner read/write only)
    fs.writeFileSync(storePath, content, { encoding: 'utf8', mode: 0o600 });

    // Also chmod in case the file already existed with different permissions
    fs.chmodSync(storePath, 0o600);
  }
}

/**
 * Stores a value securely.
 *
 * When safeStorage is available, the value is encrypted and stored as a
 * base64-encoded ciphertext in the fallback JSON file (keyed by name).
 * When safeStorage is unavailable, the plaintext value is stored directly
 * in the permission-restricted JSON file.
 *
 * @param {string} key - The key name to store under.
 * @param {string} value - The plaintext value to store.
 */
function setItem(key, value) {
  if (typeof key !== 'string' || !key) {
    throw new Error('secure-store: key must be a non-empty string');
  }
  if (typeof value !== 'string') {
    throw new Error('secure-store: value must be a string');
  }

  const store = readFallbackStore();

  if (isSafeStorageAvailable()) {
    // Encrypt the value using OS-level encryption
    const encrypted = safeStorage.encryptString(value);
    store[key] = {
      encrypted: true,
      data: encrypted.toString('base64')
    };
  } else {
    // Fallback: store plaintext in the permission-restricted file
    store[key] = {
      encrypted: false,
      data: value
    };
  }

  writeFallbackStore(store);
}

/**
 * Retrieves a value from secure storage.
 *
 * @param {string} key - The key name to retrieve.
 * @returns {string|null} The decrypted/plaintext value, or null if not found.
 */
function getItem(key) {
  if (typeof key !== 'string' || !key) {
    throw new Error('secure-store: key must be a non-empty string');
  }

  const store = readFallbackStore();
  const entry = store[key];

  if (!entry || !entry.data) {
    return null;
  }

  if (entry.encrypted) {
    if (!isSafeStorageAvailable()) {
      // Cannot decrypt without safeStorage — treat as missing
      return null;
    }
    try {
      const buffer = Buffer.from(entry.data, 'base64');
      return safeStorage.decryptString(buffer);
    } catch {
      // Decryption failed (e.g., OS keychain changed) — treat as missing
      return null;
    }
  }

  // Plaintext fallback entry
  return entry.data;
}

/**
 * Removes a value from secure storage.
 *
 * @param {string} key - The key name to remove.
 */
function removeItem(key) {
  if (typeof key !== 'string' || !key) {
    throw new Error('secure-store: key must be a non-empty string');
  }

  const store = readFallbackStore();

  if (Object.prototype.hasOwnProperty.call(store, key)) {
    delete store[key];
    writeFallbackStore(store);
  }
}

/**
 * Checks whether a key exists in secure storage.
 *
 * @param {string} key - The key name to check.
 * @returns {boolean} True if the key exists.
 */
function hasItem(key) {
  if (typeof key !== 'string' || !key) {
    return false;
  }

  const store = readFallbackStore();
  return Object.prototype.hasOwnProperty.call(store, key);
}

/**
 * Clears all entries from secure storage.
 */
function clear() {
  writeFallbackStore({});
}

module.exports = {
  setItem,
  getItem,
  removeItem,
  hasItem,
  clear,
  // Exposed for testing
  isSafeStorageAvailable,
  getStorePath
};
