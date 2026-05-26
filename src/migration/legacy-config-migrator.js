'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Legacy API key field names that must be stripped from the config file.
 * These keys are no longer needed because AI operations are now proxied
 * through the Backend API which holds provider keys server-side.
 */
const LEGACY_KEY_FIELDS = [
  'groqApiKey',
  'geminiApiKey',
  'deepseekApiKey',
  'cerebrasApiKey'
];

const CONFIG_FILENAME = '.interview-assistant-config.json';
const PENDING_EVENT_FILENAME = '.interview-assistant-pending-deletion-event.json';

/**
 * Returns the path to the legacy config file.
 */
function getConfigPath() {
  return path.join(os.homedir(), CONFIG_FILENAME);
}

/**
 * Returns the path to the pending deletion event file.
 */
function getPendingEventPath() {
  return path.join(os.homedir(), PENDING_EVENT_FILENAME);
}

/**
 * Migrates the legacy config file by removing provider API key fields.
 * Preserves all other key/value pairs byte-for-byte by reading the raw JSON,
 * parsing it, removing only the legacy key fields, and re-serializing with
 * the same formatting (2-space indent as used by the save-config handler).
 *
 * @returns {{ migrated: boolean, keysRemoved: string[] }} Result of migration
 */
function migrateConfig() {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return { migrated: false, keysRemoved: [] };
  }

  let rawContent;
  try {
    rawContent = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    // If we can't read the file, skip migration silently
    return { migrated: false, keysRemoved: [] };
  }

  let config;
  try {
    config = JSON.parse(rawContent);
  } catch (err) {
    // If the file isn't valid JSON, skip migration
    return { migrated: false, keysRemoved: [] };
  }

  // Check which legacy key fields are present
  const keysRemoved = [];
  for (const key of LEGACY_KEY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      keysRemoved.push(key);
      delete config[key];
    }
  }

  if (keysRemoved.length === 0) {
    // No legacy keys found, nothing to migrate
    return { migrated: false, keysRemoved: [] };
  }

  // Rewrite the config file without the legacy key fields.
  // Use 2-space indent to match the existing save-config handler format.
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    // If we can't write, return partial result — keys were not actually removed
    return { migrated: false, keysRemoved: [] };
  }

  return { migrated: true, keysRemoved };
}

/**
 * Queues a deletion-event record to be sent to the Backend API on first
 * successful connection. The event contains the deletion timestamp.
 * If a pending event already exists, it is not overwritten.
 *
 * @param {string|null} userId - The authenticated user's ID (null if not yet known)
 */
function queueDeletionEvent(userId) {
  const pendingPath = getPendingEventPath();

  // Don't overwrite an existing pending event
  if (fs.existsSync(pendingPath)) {
    return;
  }

  const event = {
    type: 'legacy_keys_deleted',
    userId: userId || null,
    deletedAt: new Date().toISOString(),
    submitted: false
  };

  try {
    fs.writeFileSync(pendingPath, JSON.stringify(event, null, 2), 'utf8');
  } catch (err) {
    // Best-effort — if we can't write the pending event, the migration
    // still completes (R3.3: removal happens regardless of backend reachability)
  }
}

/**
 * Reads the pending deletion event, if one exists.
 *
 * @returns {object|null} The pending event object, or null if none exists
 */
function getPendingDeletionEvent() {
  const pendingPath = getPendingEventPath();

  if (!fs.existsSync(pendingPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(pendingPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Marks the pending deletion event as submitted and removes the file.
 * Called after the Backend API acknowledges the deletion event.
 */
function clearPendingDeletionEvent() {
  const pendingPath = getPendingEventPath();

  try {
    if (fs.existsSync(pendingPath)) {
      fs.unlinkSync(pendingPath);
    }
  } catch (err) {
    // Best-effort cleanup
  }
}

/**
 * Attempts to submit the pending deletion event to the Backend API.
 * This should be called on each successful backend connection until
 * the event is acknowledged.
 *
 * @param {function} sendToBackend - Async function that sends the event to the backend.
 *   Should accept the event object and return true if acknowledged, false otherwise.
 * @returns {Promise<boolean>} Whether the event was successfully submitted
 */
async function submitPendingDeletionEvent(sendToBackend) {
  const event = getPendingDeletionEvent();
  if (!event) {
    return true; // Nothing to submit
  }

  try {
    const acknowledged = await sendToBackend(event);
    if (acknowledged) {
      clearPendingDeletionEvent();
      return true;
    }
  } catch (err) {
    // R3.3: Retry on next connection — don't throw
  }

  return false;
}

/**
 * Main entry point: runs the full legacy config migration on startup.
 * Strips provider API key fields from the config and queues a deletion
 * event for the backend.
 *
 * @param {string|null} userId - The authenticated user's ID (null if not yet known)
 * @returns {{ migrated: boolean, keysRemoved: string[] }}
 */
function runMigration(userId) {
  const result = migrateConfig();

  if (result.migrated) {
    queueDeletionEvent(userId);
  }

  return result;
}

module.exports = {
  LEGACY_KEY_FIELDS,
  getConfigPath,
  getPendingEventPath,
  migrateConfig,
  queueDeletionEvent,
  getPendingDeletionEvent,
  clearPendingDeletionEvent,
  submitPendingDeletionEvent,
  runMigration
};
