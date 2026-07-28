/**
 * Razorpay webhook signature verification.
 *
 * Implements HMAC-SHA256 verification of incoming webhook payloads using
 * the configured RAZORPAY_WEBHOOK_SECRET. Uses timing-safe comparison to
 * prevent timing side-channel attacks.
 *
 * Requirements: 10.5, 10.6
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Razorpay webhook signature against the raw request body.
 *
 * Computes HMAC-SHA256 of `rawBody` using `secret` and compares the
 * resulting hex digest to the provided `signature` using a constant-time
 * comparison to prevent timing attacks.
 *
 * @param rawBody  - The raw request body (string or Buffer).
 * @param signature - The value of the `X-Razorpay-Signature` header.
 * @param secret   - The Razorpay webhook secret.
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) {
    return false;
  }

  const expectedDigest = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Both are hex strings; they must be the same length for timingSafeEqual.
  // A valid HMAC-SHA256 hex digest is always 64 characters.
  if (signature.length !== expectedDigest.length) {
    return false;
  }

  const sigBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedDigest, 'utf8');

  return timingSafeEqual(sigBuffer, expectedBuffer);
}

/**
 * Read the Razorpay webhook secret from the environment.
 *
 * @throws {Error} if `RAZORPAY_WEBHOOK_SECRET` is not set or is empty.
 */
export function getWebhookSecret(): string {
  const secret = process.env['RAZORPAY_WEBHOOK_SECRET'];
  if (!secret) {
    throw new Error(
      'RAZORPAY_WEBHOOK_SECRET environment variable is not set or is empty.',
    );
  }
  return secret;
}

/**
 * Verify a Razorpay Standard Checkout payment signature.
 *
 * After a successful payment the browser returns `razorpay_order_id`,
 * `razorpay_payment_id`, and `razorpay_signature`. The signature is
 * HMAC-SHA256 of `"{order_id}|{payment_id}"` keyed with the Razorpay
 * KEY_SECRET. This confirms the payment result was not tampered with
 * before the wallet is credited.
 *
 * @param orderId    - razorpay_order_id returned by checkout.
 * @param paymentId  - razorpay_payment_id returned by checkout.
 * @param signature  - razorpay_signature returned by checkout.
 * @param keySecret  - The Razorpay KEY_SECRET (server-only).
 * @returns `true` if the signature is valid, `false` otherwise.
 */
export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean {
  if (!orderId || !paymentId || !signature || !keySecret) {
    return false;
  }

  const expectedDigest = createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  if (signature.length !== expectedDigest.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(signature, 'utf8'),
    Buffer.from(expectedDigest, 'utf8'),
  );
}
