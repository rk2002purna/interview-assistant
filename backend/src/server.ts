import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { loadModeConfig } from './config/mode.js';
import { StorageQuotaGate, createPgDatabaseSampler } from './storage/quota-gate.js';
import { buildResendEmailSenders } from './auth/resend-email-sender.js';
import { createRazorpayClient } from './billing/razorpay-client.js';

/**
 * Thin Node platform entry. Cloudflare Workers and Vercel adapters can be
 * added alongside this file without changing `buildApp`.
 */
const port = Number.parseInt(process.env.PORT ?? '8787', 10);

// Resolve hosting mode and select the appropriate database URL.
const { mode, databaseUrl } = loadModeConfig();

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

// Storage quota gate for blob persistence (R15.3)
const storageGate = new StorageQuotaGate({
  sampler: createPgDatabaseSampler(pool),
});

// Resend email senders (free tier: 100 emails/day). When RESEND_API_KEY is
// not set, the auth routes fall back to logging stubs — registration and
// password reset still work, but no emails are delivered.
const resendApiKey = process.env.RESEND_API_KEY;
const webAppBaseUrl = process.env.WEB_APP_BASE_URL;
const emailSenders = resendApiKey
  ? buildResendEmailSenders({
      apiKey: resendApiKey,
      from: process.env.EMAIL_FROM ?? 'UpNod <noreply@upnod.com>',
      ...(webAppBaseUrl ? { webAppBaseUrl } : {}),
    })
  : undefined;

// Razorpay client for checkout routes. When key_id and key_secret are both
// set, the checkout endpoint (POST /purchases/checkout) is mounted and users
// can purchase session packs. Webhook routes (POST /webhooks/razorpay) are
// mounted separately when RAZORPAY_WEBHOOK_SECRET is set.
const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
const razorpayClient =
  razorpayKeyId && razorpayKeySecret
    ? createRazorpayClient({ keyId: razorpayKeyId, keySecret: razorpayKeySecret })
    : undefined;

const app = buildApp({
  pool,
  ...(razorpayClient ? { razorpayClient } : {}),
  ...(razorpayKeyId ? { razorpayKeyId } : {}),
  ...(process.env.RAZORPAY_WEBHOOK_SECRET ? { razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET } : {}),
  storageGate,
  ...(emailSenders ? { sendVerificationEmail: emailSenders.sendVerificationEmail } : {}),
  ...(emailSenders ? { sendPasswordResetEmail: emailSenders.sendPasswordResetEmail } : {}),
});

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`backend listening on http://localhost:${info.port} (mode=${mode})`);
});
