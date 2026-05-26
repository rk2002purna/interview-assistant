/**
 * Unit tests for Razorpay webhook signature verification.
 *
 * Validates: Requirements 10.5, 10.6
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  getWebhookSecret,
  verifyWebhookSignature,
} from '../../../src/billing/razorpay-signature.js';

const TEST_SECRET = 'whsec_test_secret_key_12345';

/** Helper: compute a valid HMAC-SHA256 hex signature for a given body. */
function computeSignature(body: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('billing/razorpay-signature', () => {
  describe('verifyWebhookSignature', () => {
    it('returns true for a valid signature', () => {
      const body = JSON.stringify({ event: 'payment.captured', payload: {} });
      const signature = computeSignature(body, TEST_SECRET);

      expect(verifyWebhookSignature(body, signature, TEST_SECRET)).toBe(true);
    });

    it('returns true for a valid signature with Buffer body', () => {
      const body = Buffer.from('{"event":"payment.captured"}');
      const signature = computeSignature(body, TEST_SECRET);

      expect(verifyWebhookSignature(body, signature, TEST_SECRET)).toBe(true);
    });

    it('returns false for an invalid signature', () => {
      const body = '{"event":"payment.captured"}';
      const signature = computeSignature(body, TEST_SECRET);
      // Tamper with the signature (flip a character).
      const tampered = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');

      expect(verifyWebhookSignature(body, tampered, TEST_SECRET)).toBe(false);
    });

    it('returns false when signature is computed with a different secret', () => {
      const body = '{"event":"payment.captured"}';
      const wrongSecret = 'wrong_secret';
      const signature = computeSignature(body, wrongSecret);

      expect(verifyWebhookSignature(body, signature, TEST_SECRET)).toBe(false);
    });

    it('returns false for an empty signature', () => {
      const body = '{"event":"payment.captured"}';

      expect(verifyWebhookSignature(body, '', TEST_SECRET)).toBe(false);
    });

    it('returns false for an empty secret', () => {
      const body = '{"event":"payment.captured"}';
      const signature = computeSignature(body, TEST_SECRET);

      expect(verifyWebhookSignature(body, signature, '')).toBe(false);
    });

    it('returns true for an empty body with correct signature', () => {
      const body = '';
      const signature = computeSignature(body, TEST_SECRET);

      expect(verifyWebhookSignature(body, signature, TEST_SECRET)).toBe(true);
    });

    it('returns false when signature has wrong length (not 64 hex chars)', () => {
      const body = '{"event":"payment.captured"}';
      // A truncated signature that is not 64 characters.
      const shortSignature = 'abcdef1234567890';

      expect(verifyWebhookSignature(body, shortSignature, TEST_SECRET)).toBe(false);
    });

    it('handles body with special characters correctly', () => {
      const body = '{"amount":49900,"currency":"INR","notes":{"emoji":"🎉"}}';
      const signature = computeSignature(body, TEST_SECRET);

      expect(verifyWebhookSignature(body, signature, TEST_SECRET)).toBe(true);
    });

    it('uses timing-safe comparison (signature length mismatch returns false without throwing)', () => {
      const body = '{"event":"payment.captured"}';
      // A signature that is too long — timingSafeEqual would throw if buffers
      // have different lengths, so we guard against that.
      const longSignature = 'a'.repeat(128);

      expect(verifyWebhookSignature(body, longSignature, TEST_SECRET)).toBe(false);
    });
  });

  describe('getWebhookSecret', () => {
    const ORIGINAL = process.env['RAZORPAY_WEBHOOK_SECRET'];

    beforeEach(() => {
      delete process.env['RAZORPAY_WEBHOOK_SECRET'];
    });

    afterEach(() => {
      if (ORIGINAL === undefined) {
        delete process.env['RAZORPAY_WEBHOOK_SECRET'];
      } else {
        process.env['RAZORPAY_WEBHOOK_SECRET'] = ORIGINAL;
      }
    });

    it('returns the secret when RAZORPAY_WEBHOOK_SECRET is set', () => {
      process.env['RAZORPAY_WEBHOOK_SECRET'] = TEST_SECRET;

      expect(getWebhookSecret()).toBe(TEST_SECRET);
    });

    it('throws when RAZORPAY_WEBHOOK_SECRET is not set', () => {
      expect(() => getWebhookSecret()).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
    });

    it('throws when RAZORPAY_WEBHOOK_SECRET is empty string', () => {
      process.env['RAZORPAY_WEBHOOK_SECRET'] = '';

      expect(() => getWebhookSecret()).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
    });
  });
});
