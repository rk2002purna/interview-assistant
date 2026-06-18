import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Pool } from 'pg';
import { buildAdminAuditLogRouter } from './admin/audit-log-routes.js';
import { buildAdminPacksRouter } from './admin/packs-routes.js';
import { buildAdminProviderKeysRouter } from './admin/provider-keys-routes.js';
import { buildAdminRateLimitsRouter } from './admin/rate-limits-routes.js';
import { buildModelRoutingRouter } from './admin/model-routing-routes.js';
import { buildAdminUsersRouter } from './admin/users-routes.js';
import { buildAdminWelcomeOfferRouter } from './admin/welcome-offer-routes.js';
import { buildAuthRefreshRouter } from './auth/refresh-routes.js';
import { buildAuthLoginRouter } from './auth/login-routes.js';
import { buildAuthRegisterRouter } from './auth/register-routes.js';
import { buildPasswordResetRouter } from './auth/password-reset-routes.js';
import { buildCheckoutRouter } from './billing/checkout-routes.js';
import { buildWebhookRouter } from './billing/webhook-routes.js';
import type { RazorpayClient } from './billing/razorpay-client.js';
import { buildEntitlementRouter } from './entitlement/routes.js';
import { buildPacksRouter } from './packs/routes.js';
import { buildSessionsRouter } from './sessions/routes.js';
import { buildUsageRouter } from './usage/routes.js';
import { buildAiTextRouter } from './ai/text-route.js';
import { buildAudioRouter } from './ai/audio-routes.js';
import type { TranscribeFn } from './ai/audio-routes.js';
import { buildVisionRouter } from './ai/vision-routes.js';
import type { StorageQuotaGate } from './storage/quota-gate.js';
import type { VerificationEmailSender } from './auth/register-routes.js';
import type { PasswordResetEmailSender } from './auth/password-reset-routes.js';

// Re-export scheduled task handlers for platform invocation.
export { runSessionExpirySweep } from './sessions/expiry-sweep.js';
export { runWebhookReconciliation } from './billing/webhook-reconciliation.js';

/**
 * Dependencies that subsystem routers need to read or write persisted
 * state. The fields are optional because not every test or hosting
 * adapter needs every subsystem mounted at once; callers wire only what
 * they need.
 */
export interface BuildAppDeps {
  /** Postgres pool used by routers that read or write persisted state. */
  readonly pool?: Pool;
  /** Clock injection used by routers and tests. Defaults to wall clock. */
  readonly now?: () => Date;
  /** Razorpay client for the checkout route (DI for testability). */
  readonly razorpayClient?: RazorpayClient;
  /** Razorpay key_id returned to clients for frontend checkout. */
  readonly razorpayKeyId?: string;
  /** Razorpay webhook secret for signature verification. */
  readonly razorpayWebhookSecret?: string;
  /** Storage quota gate for blob persistence (R15.3). */
  readonly storageGate?: StorageQuotaGate;
  /** Whisper transcription function (DI for testability). */
  readonly transcribe?: TranscribeFn;
  /** Verification email sender (Resend, stub, or test double). */
  readonly sendVerificationEmail?: VerificationEmailSender;
  /** Password reset email sender (Resend, stub, or test double). */
  readonly sendPasswordResetEmail?: PasswordResetEmailSender;
}

/**
 * Build and return the Hono app instance.
 *
 * This module deliberately does not call `listen` so it can be exercised
 * directly with `supertest` and other in-process HTTP clients. The thin
 * platform entry (`src/server.ts` for Node, or a Workers/Vercel adapter)
 * is responsible for binding the app to a network socket.
 *
 * Subsystem routers (auth, pack catalog, sessions, AI proxy, usage,
 * admin) are mounted when their required dependencies are supplied. This
 * allows tests to instantiate a minimal app without provisioning the
 * entire backend.
 */
export function buildApp(deps: BuildAppDeps = {}): Hono {
  const app = new Hono();

  // CORS — allow requests from web app and admin dashboard
  app.use('*', cors({
    origin: (origin) => {
      // Allow any origin in development, or specific domains in production
      const allowed = [
        'http://localhost:5173',
        'http://localhost:3000',
        process.env.WEB_APP_URL,
        process.env.ADMIN_DASHBOARD_URL,
      ].filter(Boolean) as string[];
      if (!origin || allowed.some(u => origin.startsWith(u))) return origin;
      // Also allow any Vercel preview deployments
      if (origin.includes('.vercel.app')) return origin;
      return allowed[0] ?? '*';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Client-Id', 'X-Build-Version', 'Idempotency-Key'],
    credentials: true,
    maxAge: 86400,
  }));

  // Liveness probe used by hosting platforms and tests.
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Global error handler — surfaces unhandled errors as JSON
  app.onError((err, c) => {
    console.error('Unhandled error:', err);
    return c.json(
      { error: { code: 'internal_error', message: err.message || 'Internal Server Error' } },
      500,
    );
  });

  // Pack_Catalog routes (`GET /packs` per Requirement 5.4).
  if (deps.pool) {
    const packsRouter = buildPacksRouter({
      pool: deps.pool,
      ...(deps.now ? { now: deps.now } : {}),
    });
    app.route('/', packsRouter);

    // Admin Welcome_Offer routes (R5.7, R5.10, R11.8).
    const adminWelcomeOfferRouter = buildAdminWelcomeOfferRouter({
      pool: deps.pool,
    });
    app.route('/', adminWelcomeOfferRouter);

    // Admin Pack_Catalog routes (R5.5, R5.6, R11.6).
    const adminPacksRouter = buildAdminPacksRouter({
      pool: deps.pool,
    });
    app.route('/', adminPacksRouter);

    // Admin Provider_Key routes (R4.1, R4.3, R4.4, R4.8, R4.9, R11.9).
    const adminProviderKeysRouter = buildAdminProviderKeysRouter({
      pool: deps.pool,
    });
    app.route('/', adminProviderKeysRouter);

    // Admin Users routes (R2.5, R2.6).
    const adminUsersRouter = buildAdminUsersRouter({
      pool: deps.pool,
    });
    app.route('/', adminUsersRouter);

    // Admin Rate Limit Overrides routes (R12.4).
    const adminRateLimitsRouter = buildAdminRateLimitsRouter({
      pool: deps.pool,
    });
    app.route('/', adminRateLimitsRouter);

    // Model Routing config (admin write + public read for desktop clients).
    const modelRoutingRouter = buildModelRoutingRouter({
      pool: deps.pool,
    });
    app.route('/', modelRoutingRouter);

    // Admin Audit Log routes (R14.4).
    const adminAuditLogRouter = buildAdminAuditLogRouter({
      pool: deps.pool,
    });
    app.route('/', adminAuditLogRouter);

    // Auth registration routes (R1.3, R1.4, R1.9).
    const authRegisterRouter = buildAuthRegisterRouter({
      pool: deps.pool,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sendVerificationEmail ? { sendVerificationEmail: deps.sendVerificationEmail } : {}),
    });
    app.route('/', authRegisterRouter);

    // Auth password reset routes (R1.3).
    const passwordResetRouter = buildPasswordResetRouter({
      pool: deps.pool,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sendPasswordResetEmail ? { sendPasswordResetEmail: deps.sendPasswordResetEmail } : {}),
    });
    app.route('/', passwordResetRouter);

    // Auth login routes (R1.2, R1.5).
    const authLoginRouter = buildAuthLoginRouter({
      pool: deps.pool,
      ...(deps.now ? { now: deps.now } : {}),
    });
    app.route('/', authLoginRouter);

    // Auth refresh and logout routes (R1.6, R1.7, R1.10, R13.5).
    const authRefreshRouter = buildAuthRefreshRouter({
      pool: deps.pool,
      ...(deps.now ? { now: deps.now } : {}),
    });
    app.route('/', authRefreshRouter);

    // Entitlement routes (R6.4: GET /me/entitlement).
    const entitlementRouter = buildEntitlementRouter({
      pool: deps.pool,
    });
    app.route('/', entitlementRouter);

    // Session routes (R8.1, R8.2, R8.3: POST /sessions/start).
    const sessionsRouter = buildSessionsRouter({
      pool: deps.pool,
      ...(deps.now ? { now: deps.now } : {}),
    });
    app.route('/', sessionsRouter);

    // Purchase checkout routes (R10.1, R10.2: POST /purchases/checkout).
    if (deps.razorpayClient && deps.razorpayKeyId) {
      const checkoutRouter = buildCheckoutRouter({
        pool: deps.pool,
        razorpayClient: deps.razorpayClient,
        razorpayKeyId: deps.razorpayKeyId,
        ...(deps.now ? { now: deps.now } : {}),
      });
      app.route('/', checkoutRouter);
    }

    // Razorpay webhook routes (R10.7, R10.8, R10.9, R10.10: POST /webhooks/razorpay).
    if (deps.razorpayWebhookSecret) {
      const webhookRouter = buildWebhookRouter({
        pool: deps.pool,
        webhookSecret: deps.razorpayWebhookSecret,
      });
      app.route('/', webhookRouter);
    }

    // Usage routes (R9.2, R9.3, R9.4: GET /me/usage).
    const usageRouter = buildUsageRouter({
      pool: deps.pool,
      ...(deps.now ? { now: deps.now } : {}),
    });
    app.route('/', usageRouter);

    // AI Text route (R7.1, R7.4, R7.5, R7.8, R9.1: POST /ai/text).
    const aiTextRouter = buildAiTextRouter({
      pool: deps.pool,
      ...(deps.now ? { now: deps.now } : {}),
    });
    app.route('/', aiTextRouter);

    // AI Vision route (R7.1, R7.4, R7.5: POST /ai/vision).
    const visionRouter = buildVisionRouter({
      pool: deps.pool,
      ...(deps.now ? { now: deps.now } : {}),
    });
    app.route('/', visionRouter);

    // AI Audio route (R7.1, R7.4, R7.5, R15.2: POST /ai/audio).
    if (deps.storageGate) {
      const audioRouter = buildAudioRouter({
        pool: deps.pool,
        storageGate: deps.storageGate,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.transcribe ? { transcribe: deps.transcribe } : {}),
      });
      app.route('/', audioRouter);
    }
  }

  return app;
}

export type App = ReturnType<typeof buildApp>;
