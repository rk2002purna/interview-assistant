'use strict';

const { EventEmitter } = require('events');
const secureStore = require('./secure-store');
const { getClientId } = require('./client-id');

/**
 * Auth Controller — owns the access/refresh token lifecycle for the
 * Electron Desktop Client.
 *
 * Responsibilities:
 * - Stores and retrieves access and refresh tokens via secure-store
 * - Proactively refreshes the access token at 80% of its TTL
 * - On refresh failure, clears local state and emits `auth:logged-out`
 * - Provides getAccessToken() for other modules to attach to requests
 *
 * Requirements: 1.6, 1.7, 1.10
 */

const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';
const TOKEN_EXPIRY_KEY = 'token_expiry'; // ISO timestamp when access token expires
const TOKEN_ISSUED_KEY = 'token_issued'; // ISO timestamp when access token was issued

/**
 * @typedef {Object} AuthState
 * @property {string|null} accessToken
 * @property {string|null} refreshToken
 * @property {number|null} expiresAt - Unix timestamp (ms) when access token expires
 * @property {number|null} issuedAt - Unix timestamp (ms) when access token was issued
 */

class AuthController extends EventEmitter {
  constructor() {
    super();

    /** @type {string|null} */
    this._accessToken = null;

    /** @type {string|null} */
    this._refreshToken = null;

    /** @type {number|null} Unix ms when access token expires */
    this._expiresAt = null;

    /** @type {number|null} Unix ms when access token was issued */
    this._issuedAt = null;

    /** @type {NodeJS.Timeout|null} */
    this._refreshTimer = null;

    /** @type {boolean} */
    this._refreshInProgress = false;

    /** @type {((path: string, options: object) => Promise<any>)|null} */
    this._httpClient = null;
  }

  /**
   * Injects the HTTP client function used to call the backend API.
   * This avoids a circular dependency with backend-client.js.
   *
   * The function signature should be:
   *   (path: string, options: { method, body, skipAuth }) => Promise<{ ok, status, data }>
   *
   * @param {Function} httpClient
   */
  setHttpClient(httpClient) {
    this._httpClient = httpClient;
  }

  /**
   * Initializes the controller by loading persisted tokens from secure storage.
   * Should be called once at app startup after Electron's app 'ready' event.
   */
  initialize() {
    this._accessToken = secureStore.getItem(ACCESS_TOKEN_KEY);
    this._refreshToken = secureStore.getItem(REFRESH_TOKEN_KEY);

    const expiryStr = secureStore.getItem(TOKEN_EXPIRY_KEY);
    const issuedStr = secureStore.getItem(TOKEN_ISSUED_KEY);

    this._expiresAt = expiryStr ? parseInt(expiryStr, 10) : null;
    this._issuedAt = issuedStr ? parseInt(issuedStr, 10) : null;

    // If we have tokens, schedule proactive refresh
    if (this._accessToken && this._refreshToken && this._expiresAt) {
      this._scheduleProactiveRefresh();
    }
  }

  /**
   * Returns true if the user is currently authenticated (has tokens).
   * @returns {boolean}
   */
  isAuthenticated() {
    return !!(this._accessToken && this._refreshToken);
  }

  /**
   * Returns the current access token, or null if not authenticated.
   * Callers should use this to attach the Bearer token to requests.
   * @returns {string|null}
   */
  getAccessToken() {
    return this._accessToken;
  }

  /**
   * Returns the current refresh token, or null if not authenticated.
   * @returns {string|null}
   */
  getRefreshToken() {
    return this._refreshToken;
  }

  /**
   * Called after a successful login. Persists tokens and schedules refresh.
   *
   * @param {Object} params
   * @param {string} params.accessToken - The JWT access token
   * @param {string} params.refreshToken - The opaque refresh token
   * @param {number} params.expiresIn - Token lifetime in seconds (e.g. 3600 for 60 min)
   */
  handleLoginSuccess({ accessToken, refreshToken, expiresIn }) {
    const now = Date.now();
    const expiresAt = now + expiresIn * 1000;

    this._accessToken = accessToken;
    this._refreshToken = refreshToken;
    this._expiresAt = expiresAt;
    this._issuedAt = now;

    // Persist to secure storage
    secureStore.setItem(ACCESS_TOKEN_KEY, accessToken);
    secureStore.setItem(REFRESH_TOKEN_KEY, refreshToken);
    secureStore.setItem(TOKEN_EXPIRY_KEY, String(expiresAt));
    secureStore.setItem(TOKEN_ISSUED_KEY, String(now));

    this._scheduleProactiveRefresh();

    this.emit('auth:logged-in');
  }

  /**
   * Performs a logout: revokes the refresh token on the backend, ends any
   * active session, then clears all local auth state.
   *
   * Requirement 1.7: Revoke refresh token, end active session, clear tokens.
   *
   * @returns {Promise<void>}
   */
  async logout() {
    // Attempt to revoke the refresh token on the backend
    if (this._httpClient && this._refreshToken) {
      try {
        await this._httpClient('/auth/logout', {
          method: 'POST',
          body: { refresh_token: this._refreshToken },
          skipAuth: false
        });
      } catch {
        // Best-effort: even if revocation fails, we clear local state
      }
    }

    this._clearState();
    this.emit('auth:logged-out', { reason: 'user_logout' });
  }

  /**
   * Attempts to refresh the access token using the stored refresh token.
   * Called proactively at 80% TTL or reactively on 401 responses.
   *
   * Requirement 1.6: Exchange refresh token for new access token within 5s.
   * Requirement 1.10: On failure, clear state and emit auth:logged-out.
   *
   * @returns {Promise<boolean>} True if refresh succeeded, false otherwise.
   */
  async refresh() {
    if (this._refreshInProgress) {
      // Avoid concurrent refresh attempts
      return this._waitForRefresh();
    }

    if (!this._refreshToken) {
      this._clearState();
      this.emit('auth:logged-out', { reason: 'no_refresh_token' });
      return false;
    }

    this._refreshInProgress = true;

    try {
      if (!this._httpClient) {
        throw new Error('HTTP client not configured');
      }

      const clientId = getClientId();

      const response = await this._httpClient('/auth/refresh', {
        method: 'POST',
        body: {
          refresh_token: this._refreshToken,
          client_id: clientId
        },
        skipAuth: true // Don't attach the expired access token
      });

      if (response.ok && response.data) {
        const { access_token, expires_in } = response.data;
        const now = Date.now();
        const expiresAt = now + expires_in * 1000;

        this._accessToken = access_token;
        this._expiresAt = expiresAt;
        this._issuedAt = now;

        // Persist updated access token and timing
        secureStore.setItem(ACCESS_TOKEN_KEY, access_token);
        secureStore.setItem(TOKEN_EXPIRY_KEY, String(expiresAt));
        secureStore.setItem(TOKEN_ISSUED_KEY, String(now));

        this._scheduleProactiveRefresh();
        this.emit('auth:token-refreshed');

        return true;
      }

      // Refresh was rejected (expired, revoked, or client_id mismatch)
      // Requirement 1.10: clear state and return to sign-in
      this._clearState();
      this.emit('auth:logged-out', { reason: 'refresh_rejected' });
      return false;
    } catch {
      // Network error or other failure during refresh
      // Requirement 1.10: clear state and emit logged-out
      this._clearState();
      this.emit('auth:logged-out', { reason: 'refresh_failed' });
      return false;
    } finally {
      this._refreshInProgress = false;
      this.emit('auth:refresh-settled');
    }
  }

  /**
   * Returns the number of milliseconds until the access token expires.
   * Returns 0 if no token or already expired.
   * @returns {number}
   */
  getTimeUntilExpiry() {
    if (!this._expiresAt) return 0;
    const remaining = this._expiresAt - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * Returns true if the access token is expired or will expire within
   * the given grace period (in milliseconds).
   * @param {number} [graceMs=0]
   * @returns {boolean}
   */
  isTokenExpired(graceMs = 0) {
    if (!this._expiresAt) return true;
    return Date.now() + graceMs >= this._expiresAt;
  }

  /**
   * Cleans up timers. Call when the app is shutting down.
   */
  destroy() {
    this._cancelRefreshTimer();
    this.removeAllListeners();
  }

  // ─── Private Methods ───────────────────────────────────────────────

  /**
   * Schedules a proactive token refresh at 80% of the token's TTL.
   * This ensures the token is refreshed well before expiry, avoiding
   * interruptions for the user.
   */
  _scheduleProactiveRefresh() {
    this._cancelRefreshTimer();

    if (!this._expiresAt || !this._issuedAt) return;

    const ttl = this._expiresAt - this._issuedAt;
    const refreshAt = this._issuedAt + Math.floor(ttl * 0.8);
    const delay = refreshAt - Date.now();

    if (delay <= 0) {
      // Already past 80% TTL — refresh immediately
      this.refresh();
      return;
    }

    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.refresh();
    }, delay);

    // Prevent the timer from keeping the process alive
    if (this._refreshTimer && typeof this._refreshTimer.unref === 'function') {
      this._refreshTimer.unref();
    }
  }

  /**
   * Cancels any pending proactive refresh timer.
   */
  _cancelRefreshTimer() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  /**
   * Clears all in-memory and persisted auth state.
   */
  _clearState() {
    this._cancelRefreshTimer();

    this._accessToken = null;
    this._refreshToken = null;
    this._expiresAt = null;
    this._issuedAt = null;

    secureStore.removeItem(ACCESS_TOKEN_KEY);
    secureStore.removeItem(REFRESH_TOKEN_KEY);
    secureStore.removeItem(TOKEN_EXPIRY_KEY);
    secureStore.removeItem(TOKEN_ISSUED_KEY);
  }

  /**
   * Waits for an in-progress refresh to settle, then returns whether
   * the controller is still authenticated.
   * @returns {Promise<boolean>}
   */
  _waitForRefresh() {
    return new Promise((resolve) => {
      const onSettled = () => {
        this.removeListener('auth:refresh-settled', onSettled);
        resolve(this.isAuthenticated());
      };
      this.once('auth:refresh-settled', onSettled);
    });
  }
}

// Export a singleton instance for use across the Electron main process
const authController = new AuthController();

module.exports = authController;
module.exports.AuthController = AuthController;
