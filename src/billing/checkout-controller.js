'use strict';

const { shell, app } = require('electron');
const { backendRequest } = require('../net/backend-client');
const { EventEmitter } = require('events');

/**
 * Checkout controller for the Desktop Client billing flow.
 *
 * Responsibilities:
 * - Calls POST /purchases/checkout to create a Razorpay order
 * - Opens the checkout URL in the user's default external browser
 * - On shell.openExternal failure, surfaces the URL and order ID for manual copy
 * - Polls GET /me/entitlement on app focus to detect payment completion
 *
 * Requirements: 10.3, 10.4
 */

const ENTITLEMENT_POLL_DEBOUNCE_MS = 3000;

class CheckoutController extends EventEmitter {
  constructor() {
    super();

    /** @type {string|null} Current pending order ID (while checkout is in progress) */
    this._pendingOrderId = null;

    /** @type {boolean} Whether we are currently polling entitlement */
    this._polling = false;

    /** @type {number|null} Timestamp of last entitlement poll */
    this._lastPollAt = null;

    /** @type {function|null} Bound focus handler for cleanup */
    this._focusHandler = null;
  }

  /**
   * Initiates a checkout flow for the given pack.
   *
   * Calls POST /purchases/checkout, then opens the returned checkout URL
   * in the user's default browser. If the browser cannot be opened, emits
   * a 'checkout:open-failed' event with the URL and order ID so the UI
   * can present them as copyable text.
   *
   * On success, starts listening for app focus events to poll entitlement.
   *
   * @param {string} packSlug - One of 'starter', 'pro', 'lifetime'
   * @returns {Promise<{ success: boolean, orderId?: string, checkoutUrl?: string, error?: object }>}
   */
  async checkout(packSlug) {
    if (!packSlug || typeof packSlug !== 'string') {
      return { success: false, error: { code: 'invalid_pack', message: 'Pack slug is required' } };
    }

    let response;
    try {
      response = await backendRequest('POST', '/purchases/checkout', {
        body: { pack_slug: packSlug }
      });
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'checkout_request_failed',
          message: err.message || 'Failed to create checkout order'
        }
      };
    }

    // Handle backend error responses
    if (response.error) {
      return { success: false, error: response.error };
    }

    const { order_id, checkout_url } = response;

    if (!checkout_url || !order_id) {
      return {
        success: false,
        error: { code: 'invalid_response', message: 'Backend returned incomplete checkout data' }
      };
    }

    // Store the pending order for entitlement polling
    this._pendingOrderId = order_id;

    // Attempt to open the checkout URL in the default browser (R10.3)
    let opened = false;
    try {
      await shell.openExternal(checkout_url);
      opened = true;
    } catch (err) {
      // R10.4: If the OS shell fails to open the URL, emit event with
      // copyable URL and order ID for the UI to display
      opened = false;
    }

    if (!opened) {
      this.emit('checkout:open-failed', {
        checkoutUrl: checkout_url,
        orderId: order_id,
        message: 'Could not open browser. Please copy the URL below to complete payment.'
      });
    }

    // Start polling entitlement on app focus
    this._startFocusPolling();

    return {
      success: true,
      orderId: order_id,
      checkoutUrl: checkout_url
    };
  }

  /**
   * Polls the entitlement endpoint once and emits the result.
   * Debounces to avoid excessive requests when the app gains focus rapidly.
   *
   * @returns {Promise<object|null>} The entitlement data or null on failure
   */
  async pollEntitlement() {
    const now = Date.now();

    // Debounce: skip if polled recently
    if (this._lastPollAt && (now - this._lastPollAt) < ENTITLEMENT_POLL_DEBOUNCE_MS) {
      return null;
    }

    this._lastPollAt = now;

    try {
      const entitlement = await backendRequest('GET', '/me/entitlement');

      if (entitlement && !entitlement.error) {
        this.emit('entitlement:updated', entitlement);

        // If we have a pending order and entitlement changed, the payment
        // likely completed via webhook. Clear the pending state.
        if (this._pendingOrderId) {
          this._pendingOrderId = null;
          this._stopFocusPolling();
          this.emit('checkout:completed', entitlement);
        }

        return entitlement;
      }
    } catch (err) {
      // Polling failures are non-fatal — will retry on next focus
    }

    return null;
  }

  /**
   * Returns the current pending order ID, if a checkout is in progress.
   * @returns {string|null}
   */
  getPendingOrderId() {
    return this._pendingOrderId;
  }

  /**
   * Cancels the current checkout polling (e.g., on sign-out or manual cancel).
   */
  cancelCheckout() {
    this._pendingOrderId = null;
    this._stopFocusPolling();
  }

  /**
   * Starts listening for app/window focus events to trigger entitlement polling.
   * This detects when the user returns from the external browser after payment.
   * @private
   */
  _startFocusPolling() {
    if (this._focusHandler) {
      // Already listening
      return;
    }

    this._focusHandler = () => {
      if (this._pendingOrderId) {
        this.pollEntitlement();
      }
    };

    // Listen on the app 'browser-window-focus' event which fires when any
    // BrowserWindow gains focus (covers returning from external browser)
    app.on('browser-window-focus', this._focusHandler);
  }

  /**
   * Stops listening for focus events.
   * @private
   */
  _stopFocusPolling() {
    if (this._focusHandler) {
      app.removeListener('browser-window-focus', this._focusHandler);
      this._focusHandler = null;
    }
  }

  /**
   * Cleans up all listeners. Call on app quit or controller disposal.
   */
  dispose() {
    this._stopFocusPolling();
    this.removeAllListeners();
    this._pendingOrderId = null;
    this._lastPollAt = null;
  }
}

// Singleton instance
const checkoutController = new CheckoutController();

module.exports = { CheckoutController, checkoutController };
