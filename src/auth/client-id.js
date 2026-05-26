'use strict';

const crypto = require('crypto');
const secureStore = require('./secure-store');

const CLIENT_ID_KEY = 'client_id';

/** @type {string | null} */
let cachedClientId = null;

/**
 * Validates that a string is a valid v4 UUID.
 * @param {string} value
 * @returns {boolean}
 */
function isValidUUIDv4(value) {
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Regex.test(value);
}

/**
 * Returns the per-installation client identifier (v4 UUID).
 *
 * On first call after install, generates a new UUID and persists it via
 * the secure-store module (which uses Electron's safeStorage when available,
 * or a 0600-permission fallback file otherwise).
 *
 * Subsequent calls return the cached value without disk I/O.
 *
 * This identifier is submitted as the X-Client-Id header on every
 * Backend API request for the lifetime of the installation (Requirement 13.1).
 *
 * @returns {string} The client identifier UUID
 */
function getClientId() {
  if (cachedClientId) {
    return cachedClientId;
  }

  // Try to read an existing persisted client ID
  const existingId = secureStore.getItem(CLIENT_ID_KEY);

  if (existingId && isValidUUIDv4(existingId)) {
    cachedClientId = existingId;
    return cachedClientId;
  }

  // Generate and persist a new v4 UUID
  const newId = crypto.randomUUID();
  secureStore.setItem(CLIENT_ID_KEY, newId);

  cachedClientId = newId;
  return cachedClientId;
}

module.exports = { getClientId };
