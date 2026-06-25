import 'dotenv/config';
import { serve } from '@hono/node-server';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { loadModeConfig } from './config/mode.js';
import { StorageQuotaGate, createPgDatabaseSampler } from './storage/quota-gate.js';
import { buildResendEmailSenders } from './auth/resend-email-sender.js';
import { createRazorpayClient } from './billing/razorpay-client.js';

/**
 * Run all pending SQL migrations from the /migrations folder.
 * Uses a simple applied_migrations table to track which have run.
 * Idempotent — safe to call on every startup.
 */
async function runMigrations(pool: Pool): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // dist/server.js lives in backend/dist/, migrations live in backend/migrations/,
  // so resolve one level up. We check a couple of candidate locations so a
  // different deploy layout (e.g. migrations copied into dist/) still works.
  const candidates = [
    join(__dirname, '..', 'migrations'), // backend/migrations  (standard layout)
    join(__dirname, 'migrations'),       // dist/migrations      (bundled layout)
  ];

  // Ensure tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Pick the first existing migrations directory. Fail loudly if none is
  // found so the deploy breaks early instead of silently skipping schema work.
  let migrationsDir: string | undefined;
  for (const candidate of candidates) {
    try {
      await readdir(candidate);
      migrationsDir = candidate;
      break;
    } catch {
      // not present; try next
    }
  }
  if (!migrationsDir) {
    throw new Error(
      `migrations directory not found. Looked in: ${candidates.join(', ')}`,
    );
  }

  const files = (await readdir(migrationsDir))
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const existing = await pool.query(
      'SELECT 1 FROM applied_migrations WHERE name = $1',
      [file],
    );
    if (existing.rows.length > 0) continue; // already applied

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    console.log(`[migrations] applying ${file}…`);
    await pool.query(sql);
    await pool.query(
      'INSERT INTO applied_migrations (name) VALUES ($1)',
      [file],
    );
    console.log(`[migrations] applied  ${file}`);
  }
}
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

// Run pending migrations then start the server
runMigrations(pool)
  .then(() => {
    serve({ fetch: app.fetch, port }, (info) => {
      // eslint-disable-next-line no-console
      console.log(`backend listening on http://localhost:${info.port} (mode=${mode})`);
    });
  })
  .catch((err) => {
    console.error('[migrations] FATAL: migration failed, aborting startup', err);
    process.exit(1);
  });
