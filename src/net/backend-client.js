'use strict';

const { app } = require('electron');
const { getClientId } = require('../auth/client-id');

/**
 * Backend HTTP client for the Desktop Client.
 *
 * Centralizes all outbound requests to the Backend API. Every request
 * automatically includes:
 *   - Authorization: Bearer <access_token>
 *   - X-Client-Id: <per-installation UUID>
 *   - X-Build-Version: <semantic version from package.json>
 *   - Idempotency-Key: <caller-supplied, when present>
 *
 * Never includes any provider API key in headers, query params, or body.
 *
 * Handles 401 responses by attempting a single token refresh via the
 * auth controller, then retrying the original request once.
 *
 * Surfaces structured errors as { code, message, retry_after }.
 *
 * Requirements: 3.4, 13.1, 13.6
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Base URL for the Backend API. Read from environment or defaults to localhost
 * for development. In production builds this should be set via the packaged
 * environment or a build-time constant.
 */
const BACKEND_BASE_URL =
  process.env.INTERVIEW_ASSISTANT_BACKEND_URL || 'http://localhost:8787';

// ---------------------------------------------------------------------------
// Auth controller interface (wired later by task 15.10)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} AuthController
 * @property {() => string|null} getAccessToken - Returns the current access token or null
 * @property {() => Promise<string|null>} refreshAccessToken - Attempts to refresh and returns new token or null on failure
 */

/** @type {AuthController|null} */
let _authController = null;

/**
 * Registers the auth controller instance. Called once during app initialization
 * after the auth controller is constructed (task 15.10).
 *
 * The controller must implement:
 *   - getAccessToken(): string|null
 *   - refreshAccessToken(): Promise<string|null>
 *
 * Alternatively, if the controller implements refresh() → Promise<boolean>
 * (as the AuthController class does), this function wraps it automatically.
 *
 * @param {AuthController|object} controller
 */
function setAuthController(controller) {
  if (!controller || typeof controller.getAccessToken !== 'function') {
    throw new Error('backend-client: auth controller must implement getAccessToken()');
  }

  // Support both interface styles:
  // 1. { getAccessToken, refreshAccessToken } — direct interface
  // 2. { getAccessToken, refresh } — AuthController class style
  if (typeof controller.refreshAccessToken === 'function') {
    _authController = controller;
  } else if (typeof controller.refresh === 'function') {
    _authController = {
      getAccessToken: () => controller.getAccessToken(),
      refreshAccessToken: async () => {
        const success = await controller.refresh();
        return success ? controller.getAccessToken() : null;
      }
    };
  } else {
    throw new Error('backend-client: auth controller must implement refreshAccessToken() or refresh()');
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the build version string from Electron's app metadata.
 * Falls back to '0.0.0' if unavailable (e.g. during tests).
 */
function getBuildVersion() {
  try {
    return app.getVersion() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Builds the standard headers attached to every backend request.
 * Never includes any provider API key.
 *
 * @param {object} options
 * @param {string|null} options.accessToken
 * @param {string} [options.idempotencyKey]
 * @param {string} [options.contentType]
 * @returns {Record<string, string>}
 */
function buildHeaders({ accessToken, idempotencyKey, contentType }) {
  const headers = {
    'X-Client-Id': getClientId(),
    'X-Build-Version': getBuildVersion()
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  return headers;
}

/**
 * Parses a backend error response into a structured error object.
 *
 * @param {Response} response - The fetch Response object
 * @returns {Promise<{code: string, message: string, retry_after?: number}>}
 */
async function parseErrorResponse(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const error = body && body.error ? body.error : {};

  const result = {
    code: error.code || `http_${response.status}`,
    message: error.message || response.statusText || 'Unknown error'
  };

  // Extract Retry-After from header (seconds) or body
  const retryAfterHeader = response.headers.get('Retry-After');
  if (retryAfterHeader) {
    const parsed = parseInt(retryAfterHeader, 10);
    if (!isNaN(parsed) && parsed > 0) {
      result.retry_after = parsed;
    }
  } else if (typeof error.retry_after === 'number' && error.retry_after > 0) {
    result.retry_after = error.retry_after;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BackendRequestOptions
 * @property {string} method - HTTP method (GET, POST, PATCH, DELETE, etc.)
 * @property {string} path - URL path relative to the backend base (e.g. '/ai/text')
 * @property {object|string|null} [body] - Request body (object will be JSON-serialized)
 * @property {string} [idempotencyKey] - Optional idempotency key (UUID)
 * @property {string} [contentType] - Content-Type override (defaults to 'application/json' when body is an object)
 * @property {boolean} [stream] - If true, returns the raw Response for streaming consumption
 * @property {AbortSignal} [signal] - Optional AbortSignal for cancellation
 * @property {Record<string, string>} [extraHeaders] - Additional headers (must not contain provider keys)
 */

/**
 * @typedef {object} BackendResponse
 * @property {boolean} ok - True if the response status is 2xx
 * @property {number} status - HTTP status code
 * @property {any} data - Parsed JSON response body (null for stream responses)
 * @property {Response} [raw] - Raw Response object (only when stream: true)
 * @property {{code: string, message: string, retry_after?: number}} [error] - Structured error (only when ok is false)
 */

/**
 * Sends a request to the Backend API with all required headers attached.
 *
 * On 401 responses, attempts a single token refresh and retries the request.
 * Never includes any provider API key in the outbound request.
 *
 * @param {BackendRequestOptions} options
 * @returns {Promise<BackendResponse>}
 */
async function backendRequest(options) {
  const { method, path, body, idempotencyKey, contentType, stream, signal, extraHeaders } = options;

  const url = `${BACKEND_BASE_URL}${path}`;

  // Determine content type
  let resolvedContentType = contentType;
  if (!resolvedContentType && body && typeof body === 'object') {
    resolvedContentType = 'application/json';
  }

  // Get current access token
  const accessToken = _authController ? _authController.getAccessToken() : null;

  // Build headers
  const headers = buildHeaders({
    accessToken,
    idempotencyKey,
    contentType: resolvedContentType
  });

  // Merge extra headers (never allow provider key headers)
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers[key] = value;
    }
  }

  // Serialize body
  let serializedBody = null;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') {
      serializedBody = body;
    } else {
      serializedBody = JSON.stringify(body);
    }
  }

  // First attempt
  let response = await doFetch(url, method, headers, serializedBody, signal);

  // Handle 401 → refresh → retry once
  if (response.status === 401 && _authController) {
    const newToken = await _authController.refreshAccessToken();
    if (newToken) {
      // Update the Authorization header with the fresh token
      headers['Authorization'] = `Bearer ${newToken}`;
      // Retry the request once
      response = await doFetch(url, method, headers, serializedBody, signal);
    }
  }

  // Build result
  if (response.ok) {
    if (stream) {
      return { ok: true, status: response.status, data: null, raw: response };
    }
    let data = null;
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: true, status: response.status, data };
  }

  // Error path — parse structured error
  const error = await parseErrorResponse(response);
  return { ok: false, status: response.status, data: null, error };
}

/**
 * Performs the actual fetch call. Isolated for testability.
 *
 * @param {string} url
 * @param {string} method
 * @param {Record<string, string>} headers
 * @param {string|null} body
 * @param {AbortSignal} [signal]
 * @returns {Promise<Response>}
 */
async function doFetch(url, method, headers, body, signal) {
  const fetchOptions = {
    method,
    headers,
    signal: signal || undefined
  };

  if (body !== null) {
    fetchOptions.body = body;
  }

  return fetch(url, fetchOptions);
}

/**
 * Convenience: GET request to the backend.
 * @param {string} path
 * @param {Partial<BackendRequestOptions>} [options]
 * @returns {Promise<BackendResponse>}
 */
function get(path, options = {}) {
  return backendRequest({ ...options, method: 'GET', path });
}

/**
 * Convenience: POST request to the backend.
 * @param {string} path
 * @param {object|string|null} body
 * @param {Partial<BackendRequestOptions>} [options]
 * @returns {Promise<BackendResponse>}
 */
function post(path, body, options = {}) {
  return backendRequest({ ...options, method: 'POST', path, body });
}

/**
 * Convenience: PATCH request to the backend.
 * @param {string} path
 * @param {object|string|null} body
 * @param {Partial<BackendRequestOptions>} [options]
 * @returns {Promise<BackendResponse>}
 */
function patch(path, body, options = {}) {
  return backendRequest({ ...options, method: 'PATCH', path, body });
}

/**
 * Convenience: DELETE request to the backend.
 * @param {string} path
 * @param {Partial<BackendRequestOptions>} [options]
 * @returns {Promise<BackendResponse>}
 */
function del(path, options = {}) {
  return backendRequest({ ...options, method: 'DELETE', path });
}

/**
 * Returns the configured backend base URL (useful for diagnostics).
 * @returns {string}
 */
function getBaseUrl() {
  return BACKEND_BASE_URL;
}

module.exports = {
  backendRequest,
  setAuthController,
  get,
  post,
  patch,
  del,
  getBaseUrl,
  // Exported for testing
  buildHeaders,
  getBuildVersion,
  parseErrorResponse,
  BACKEND_BASE_URL
};
