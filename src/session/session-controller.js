'use strict';

const { EventEmitter } = require('events');

/**
 * Session controller for the Electron Desktop Client.
 *
 * Tracks the active Interview Session lifecycle (start, end, countdown)
 * and emits `session:state-changed` events at most every 10 seconds
 * so the renderer can display a live countdown timer.
 *
 * Requirements: 8.7, 8.8
 *
 * Usage:
 *   const { sessionController } = require('./session/session-controller');
 *   sessionController.init(backendRequest);
 *   await sessionController.start();
 *   sessionController.on('session:state-changed', (state) => { ... });
 */

/** @typedef {{ session_id: string, started_at: string, expires_at: string, remaining_seconds: number, is_trial: boolean }} ActiveSession */
/** @typedef {{ active: boolean, session_id: string|null, started_at: string|null, expires_at: string|null, remaining_seconds: number, warning: boolean, is_trial: boolean }} SessionState */

const TICK_INTERVAL_MS = 10_000; // Emit state at most every 10 seconds
const WARNING_THRESHOLD_SECONDS = 5 * 60; // 5 minutes

class SessionController extends EventEmitter {
  constructor() {
    super();

    /** @type {function|null} */
    this._backendRequest = null;

    /** @type {ActiveSession|null} */
    this._activeSession = null;

    /** @type {ReturnType<typeof setInterval>|null} */
    this._tickTimer = null;
  }

  /**
   * Initializes the session controller with the backend request function.
   *
   * @param {function} backendRequest - The centralized HTTP client function
   *   with signature: backendRequest(method, path, options?) => Promise<{data, status}>
   */
  init(backendRequest) {
    if (typeof backendRequest !== 'function') {
      throw new Error('session-controller: backendRequest must be a function');
    }
    this._backendRequest = backendRequest;
  }

  /**
   * Starts a new Interview Session by calling POST /sessions/start.
   *
   * On success, begins the countdown tick timer that emits
   * `session:state-changed` every 10 seconds.
   *
   * @returns {Promise<{ session_id: string, expires_at: string } | { error: { code: string, message: string } }>}
   */
  async start() {
    this._ensureInitialized();

    const result = await this._backendRequest('POST', '/sessions/start');

    if (result.error) {
      return { error: result.error };
    }

    const { session_id, started_at, expires_at, is_trial } = result.data;

    this._activeSession = {
      session_id,
      started_at,
      expires_at,
      remaining_seconds: this._computeRemainingSeconds(expires_at),
      is_trial: !!is_trial
    };

    this._startTick();
    this._emitState();

    return { session_id, expires_at };
  }

  /**
   * Extends the currently active paid session by calling POST /sessions/:id/extend.
   * Consumes one session credit and adds 90 minutes to the session.
   *
   * @returns {Promise<{ session_id: string, expires_at: string } | { error: { code: string, message: string } }>}
   */
  async extend() {
    this._ensureInitialized();

    if (!this._activeSession) {
      return { error: { code: 'no_active_session', message: 'No active session to extend' } };
    }

    const sessionId = this._activeSession.session_id;
    const result = await this._backendRequest('POST', `/sessions/${sessionId}/extend`);

    if (result.error) {
      return { error: result.error };
    }

    const { session_id, expires_at } = result.data;

    this._activeSession = {
      session_id,
      started_at: this._activeSession.started_at,
      expires_at,
      remaining_seconds: this._computeRemainingSeconds(expires_at),
      is_trial: false // Once extended, it's no longer a trial
    };

    this._emitState();
    return { session_id, expires_at };
  }

  /**
   * Ends the currently active Interview Session by calling POST /sessions/:id/end.
   *
   * Stops the countdown timer and emits a final `session:state-changed` with
   * active=false.
   *
   * @returns {Promise<{ ok: boolean } | { error: { code: string, message: string } }>}
   */
  async end() {
    this._ensureInitialized();

    if (!this._activeSession) {
      return { error: { code: 'no_active_session', message: 'No active session to end' } };
    }

    const sessionId = this._activeSession.session_id;
    const result = await this._backendRequest('POST', `/sessions/${sessionId}/end`);

    if (result.error) {
      return { error: result.error };
    }

    this._clearSession();
    return { ok: true };
  }

  /**
   * Returns the currently active session state by querying the backend
   * via GET /me/session/active.
   *
   * If a session is active on the backend but not tracked locally (e.g. after
   * app restart), the local state is synchronized.
   *
   * @returns {Promise<ActiveSession | null>}
   */
  async getActive() {
    this._ensureInitialized();

    const result = await this._backendRequest('GET', '/me/session/active');

    if (result.error) {
      // 404 means no active session
      if (result.error.code === 'no_active_session') {
        // Sync local state if we thought we had one
        if (this._activeSession) {
          this._clearSession();
        }
        return null;
      }
      // For other errors, return null but don't clear local state
      return null;
    }

    const { session_id, started_at, expires_at, remaining_seconds, is_trial } = result.data;

    // Sync local state with backend
    this._activeSession = {
      session_id,
      started_at,
      expires_at,
      remaining_seconds,
      is_trial: !!is_trial
    };

    // Ensure tick timer is running if we have an active session
    if (!this._tickTimer) {
      this._startTick();
    }

    this._emitState();
    return this._activeSession;
  }

  /**
   * Returns the number of seconds remaining in the active session,
   * computed from the local expires_at timestamp.
   *
   * Returns 0 if no session is active or the session has expired.
   *
   * @returns {number}
   */
  getRemainingSeconds() {
    if (!this._activeSession) {
      return 0;
    }
    return this._computeRemainingSeconds(this._activeSession.expires_at);
  }

  /**
   * Returns the current session state object (for synchronous access by the renderer).
   *
   * @returns {SessionState}
   */
  getState() {
    if (!this._activeSession) {
      return {
        active: false,
        session_id: null,
        started_at: null,
        expires_at: null,
        remaining_seconds: 0,
        warning: false,
        is_trial: false
      };
    }

    const remaining = this._computeRemainingSeconds(this._activeSession.expires_at);
    return {
      active: remaining > 0,
      session_id: this._activeSession.session_id,
      started_at: this._activeSession.started_at,
      expires_at: this._activeSession.expires_at,
      remaining_seconds: remaining,
      warning: remaining > 0 && remaining <= WARNING_THRESHOLD_SECONDS,
      is_trial: this._activeSession.is_trial || false
    };
  }

  /**
   * Stops the tick timer and clears local session state.
   * Called on sign-out or when the session is externally invalidated.
   */
  reset() {
    this._clearSession();
  }

  /**
   * Computes remaining seconds from an ISO 8601 expires_at timestamp.
   *
   * @param {string} expiresAt - ISO 8601 UTC timestamp
   * @returns {number} Remaining seconds, clamped to >= 0
   * @private
   */
  _computeRemainingSeconds(expiresAt) {
    const expiresMs = new Date(expiresAt).getTime();
    const nowMs = Date.now();
    const remainingMs = expiresMs - nowMs;
    return Math.max(0, Math.floor(remainingMs / 1000));
  }

  /**
   * Starts the periodic tick timer that emits session state every 10 seconds.
   * @private
   */
  _startTick() {
    this._stopTick();
    this._tickTimer = setInterval(() => {
      this._onTick();
    }, TICK_INTERVAL_MS);

    // Prevent the timer from keeping the process alive
    if (this._tickTimer && typeof this._tickTimer.unref === 'function') {
      this._tickTimer.unref();
    }
  }

  /**
   * Stops the periodic tick timer.
   * @private
   */
  _stopTick() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  /**
   * Tick handler: recomputes remaining time and emits state.
   * If the session has expired locally, clears the session.
   * @private
   */
  _onTick() {
    if (!this._activeSession) {
      this._stopTick();
      return;
    }

    const remaining = this._computeRemainingSeconds(this._activeSession.expires_at);

    if (remaining <= 0) {
      // Session expired locally — clear and emit final state
      this._clearSession();
      return;
    }

    this._activeSession.remaining_seconds = remaining;
    this._emitState();
  }

  /**
   * Emits the `session:state-changed` event with the current state.
   * @private
   */
  _emitState() {
    this.emit('session:state-changed', this.getState());
  }

  /**
   * Clears the active session, stops the tick timer, and emits a final
   * inactive state event.
   * @private
   */
  _clearSession() {
    this._activeSession = null;
    this._stopTick();
    this._emitState();
  }

  /**
   * Throws if init() has not been called.
   * @private
   */
  _ensureInitialized() {
    if (!this._backendRequest) {
      throw new Error('session-controller: not initialized. Call init(backendRequest) first.');
    }
  }
}

// Export a singleton instance (standard pattern for Electron main-process modules)
const sessionController = new SessionController();

module.exports = { sessionController, SessionController };
