import 'dotenv/config';
import { serve } from '@hono/node-server';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { loadModeConfig } from './config/mode.js';
import { buildResendEmailSenders } from './auth/resend-email-sender.js';
import { createRazorpayClient } from './billing/razorpay-client.js';

/**
 * Existing migration files may include their own outer BEGIN/COMMIT wrapper.
 * The runner owns the transaction so schema changes and bookkeeping can commit
 * together; remove only a wrapper anchored outside comments and whitespace.
 */
function unwrapMigrationTransaction(sql: string, file: string): string {
  const outerBegin = /^((?:\s|--[^\n]*(?:\n|$))*)BEGIN\s*;/i;
  const outerCommit = /COMMIT\s*;\s*$/i;
  const hasOuterBegin = outerBegin.test(sql);
  const hasOuterCommit = outerCommit.test(sql);

  if (hasOuterBegin !== hasOuterCommit) {
    throw new Error(`migration ${file} has an incomplete transaction wrapper`);
  }
  if (!hasOuterBegin) return sql;

  return sql.replace(outerBegin, '$1').replace(outerCommit, '');
}

/**
 * Run pending migrations under one session-level advisory lock. Each SQL file
 * and its tracking row commit atomically, preventing concurrent instances or a
 * crash between schema changes and migration bookkeeping from corrupting state.
 */
async function runMigrations(pool: Pool): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(__dirname, '..', 'migrations'),
    join(__dirname, 'migrations'),
  ];

  let migrationsDir: string | undefined;
  for (const candidate of candidates) {
    try {
      await readdir(candidate);
      migrationsDir = candidate;
      break;
    } catch {
      // Not present; try the next supported deployment layout.
    }
  }
  if (!migrationsDir) {
    throw new Error(
      `migrations directory not found. Looked in: ${candidates.join(', ')}`,
    );
  }

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const client = await pool.connect();

  try {
    // Stable application-specific key; released automatically if the session
    // disconnects unexpectedly.
    await client.query('SELECT pg_advisory_lock($1::bigint)', [1431326287]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS applied_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const existing = await client.query(
        'SELECT 1 FROM applied_migrations WHERE name = $1',
        [file],
      );
      if (existing.rows.length > 0) continue;

      const sql = unwrapMigrationTransaction(
        await readFile(join(migrationsDir, file), 'utf8'),
        file,
      );
      console.log(`[migrations] applying ${file}…`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO applied_migrations (name) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      console.log(`[migrations] applied  ${file}`);
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1::bigint)', [1431326287])
      .catch(() => undefined);
    client.release();
  }
}
const port = Number.parseInt(process.env.PORT ?? '8787', 10);

// Resolve hosting mode and select the appropriate database URL.
const { mode, databaseUrl } = loadModeConfig();

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined,
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
  ...(razorpayKeySecret ? { razorpayKeySecret } : {}),
  ...(process.env.RAZORPAY_WEBHOOK_SECRET ? { razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET } : {}),
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
