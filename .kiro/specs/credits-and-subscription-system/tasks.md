# Implementation Plan: Credits and Subscription System

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Overview

The implementation is split into three deployables: a TypeScript serverless **Backend API** (Hono on Cloudflare Workers / Vercel + Supabase Postgres), a **Desktop Client** (modifications to the existing Electron app under `src/`), and a browser-based **Admin Dashboard**. The plan starts with backend foundations (DB schema, encryption, middleware) then layers domain services (auth, packs, ledger, sessions, AI proxy, billing, usage, rate-limits, admin), then refits the Electron client to route through the backend, and finally implements the admin dashboard. Property tests are placed adjacent to the code they validate; each references its design property by number.

## Tasks

- [x] 1. Set up backend project skeleton
  - [x] 1.1 Initialize TypeScript backend project with Hono, drizzle-orm (or kysely), pg, vitest, fast-check, supertest, nock, argon2, jose (JWT), and zod under `backend/`
    - Configure `tsconfig.json`, `package.json` scripts (`test:unit`, `test:integration`, `test:e2e`), `.env.example` with `MODE`, `DATABASE_URL_FREE`, `DATABASE_URL_PAID`, `MASTER_ENCRYPTION_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `JWT_SECRET`, `MIN_BUILD_VERSION`
    - Add a `src/app.ts` that builds and returns the Hono app instance (no listen) for supertest, plus a thin platform entry
    - _Requirements: 15.1, 15.6_

  - [x] 1.2 Set up Postgres test infrastructure
    - Add `testcontainers` Postgres helper for concurrency tests
    - Add `pg-mem` helper for fast in-memory property tests where adequate
    - Add a shared `tests/generators/` module (empty, will grow per task)
    - _Requirements: 15.1_

- [x] 2. Define database schema and migrations
  - [x] 2.1 Write migration for `users`, `refresh_tokens`, `email_verifications`, `password_resets`
    - Include CHECK constraints on role, email format, password_hash non-null
    - Add bootstrap-admin AFTER INSERT trigger that promotes the first user when admin count is zero and writes an `audit_log` row with reason `bootstrap_admin`
    - _Requirements: 1.3, 1.8, 2.1, 2.4_

  - [x] 2.2 Write migration for `packs` and `welcome_offer` (singleton)
    - Include CHECK constraints on price ranges, lifetime XOR session_count, welcome_price < mrp
    - Seed `starter`, `pro`, `lifetime` packs with default values from Requirement 5.2
    - Seed welcome_offer row enabled with ends_at = now() + 90 days
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 2.3 Write migration for `purchases` and `razorpay_events`
    - UNIQUE on `razorpay_order_id` and `razorpay_payment_id`
    - PK on `event_id` for webhook dedupe; `unmatched` boolean column
    - _Requirements: 10.1, 10.9, 10.10_

  - [x] 2.4 Write migration for `entitlement_ledger` and `interview_sessions`
    - Include CHECK constraints from the design (session_delta range, lifetime_flag_set enum, reason enum, resulting_session_count >= 0)
    - Create partial unique index `one_active_session_per_user ON interview_sessions(user_id) WHERE status='active'`
    - REVOKE UPDATE, DELETE on `entitlement_ledger` from the application role
    - _Requirements: 6.1, 6.6, 8.3_

  - [x] 2.5 Write migration for `provider_keys`, `usage`, `idempotency_cache`
    - `usage` indexes on `(user_id, ts DESC)` and `(ts)`
    - `idempotency_cache` PK on `(user_id, idempotency_key)` with `expires_at` index
    - REVOKE UPDATE, DELETE on `usage` (within retention window enforced in app)
    - _Requirements: 4.2, 7.6, 9.1, 9.5_

  - [x] 2.6 Write migration for `rate_events`, `rate_limit_overrides`, `audit_log`
    - `rate_events` PK on `(user_id, ts, kind)` with index on `(user_id, kind, ts DESC)`
    - REVOKE UPDATE, DELETE on `audit_log`
    - _Requirements: 12.1, 12.4, 14.4, 14.5_

  - [x]* 2.7 Write property test for append-only ledger and audit
    - **Property 13: Append-Only Ledger and Audit**
    - **Validates: Requirements 6.6, 9.5, 14.5**
    - Generate arbitrary insert sequences, then attempt UPDATE/DELETE; assert all are rejected and original rows preserved

- [x] 3. Implement cross-cutting infrastructure
  - [x] 3.1 Implement encryption module (`src/crypto/aes-gcm.ts`)
    - HKDF-SHA256 from `MASTER_ENCRYPTION_KEY` to per-record subkey
    - `encrypt(plaintext) -> {ciphertext, nonce, authTag}` and `decrypt(...)`; nonces are 12 random bytes per call
    - _Requirements: 4.2, 4.4_

  - [x]* 3.2 Write property test for provider key encryption round-trip
    - **Property 11: Provider Key Encryption Round-Trip and Version Monotonicity**
    - **Validates: Requirements 4.2, 4.4**
    - Generate plaintext keys + rotate sequences; assert decrypt equals original, distinct nonces produce distinct ciphertexts, version strictly increasing

  - [x] 3.3 Implement structured logger (`src/log/logger.ts`) and audit log writer (`src/log/audit.ts`)
    - Logger redacts known secret keys (provider_key, password, refresh_token)
    - `writeAudit(tx, {actor, target, eventType, outcome, reasonCode, metadata})` runs in a caller-supplied transaction
    - _Requirements: 4.7, 14.1, 14.4_

  - [x] 3.4 Implement JWT helpers (`src/auth/jwt.ts`)
    - HS256 signing with `JWT_SECRET`; claims: `sub`, `role`, `client_id`, `iat`, `exp`, `jti`
    - `verifyAccess(token) -> {sub, role, client_id}` or throws typed errors
    - _Requirements: 1.2_

  - [x] 3.5 Implement HTTP middleware chain (`src/http/middleware.ts`)
    - Order: client-id check → build-version check → JWT verify (when not public) → role gate (when admin) → rate limit
    - Returns the uniform error envelope `{error: {code, message, details}}` per design
    - _Requirements: 2.2, 2.3, 12.3, 13.1, 13.2, 13.5, 13.6_

  - [x]* 3.6 Write property test for client identity gate
    - **Property 22: Client Identity Gate**
    - **Validates: Requirements 13.1, 13.2, 13.5, 13.6**
    - Generate arbitrary `(X-Client-Id, X-Build-Version, token.client_id)` triples; assert correct HTTP code, no state change, audit row on mismatch

  - [x]* 3.7 Write property test for role-gate indistinguishability
    - **Property 14: Role-Gate Indistinguishability**
    - **Validates: Requirements 2.2, 2.3, 9.7**
    - Parameterize over admin route table × {existing, missing} resource id; assert byte-identical 403 response and zero state changes

- [x] 4. Implement Auth_Service
  - [x] 4.1 Implement password hashing module (`src/auth/password.ts`)
    - Argon2id (m=64MB, t=3, p=1), per-user salt ≥ 16 bytes
    - `validatePolicy(pw)` (12–128 chars + character classes), `hash(pw)`, `verify(hash, pw)`
    - _Requirements: 1.3, 1.8_

  - [x]* 4.2 Write property test for password validation and hash round-trip
    - **Property 16: Password Validation and Hash Round-Trip**
    - **Validates: Requirements 1.3, 1.8**

  - [x] 4.3 Implement `POST /auth/register`, `POST /auth/verify-email`, `POST /auth/resend-verification`
    - Returns 200 (or equivalent) for duplicate emails to avoid disclosure
    - Verification token: 32-byte URL-safe, 24-hour TTL
    - _Requirements: 1.3, 1.4, 1.9_

  - [x]* 4.4 Write property test for duplicate-registration response equality
    - **Property 18: Duplicate-Registration Response Equality**
    - **Validates: Requirements 1.9**

  - [x] 4.5 Implement `POST /auth/login` with lockout state machine
    - 5 invalid attempts in 15 min ⇒ 15-min lockout, 429 with `Retry-After`
    - Issue access (60 min) + refresh (30 days) tokens; bind refresh token row to `client_id`
    - _Requirements: 1.2, 1.5_

  - [x]* 4.6 Write property test for sign-in lockout window
    - **Property 17: Sign-In Lockout Window**
    - **Validates: Requirements 1.5**

  - [x] 4.7 Implement `POST /auth/refresh` and `POST /auth/logout`
    - Refresh rejects if revoked, expired, or `client_id` mismatch (and revokes both tokens, writes audit row)
    - Logout revokes the refresh token row
    - _Requirements: 1.6, 1.7, 1.10, 13.5_

  - [x] 4.8 Implement `POST /auth/password-reset/request` and `POST /auth/password-reset/confirm`
    - Always returns 200 on request; token TTL 60 min; uses `password_resets` table
    - _Requirements: 1.3_

  - [x] 4.9 Implement role change endpoint `PATCH /admin/users/:id/role` with at-least-one-admin guard
    - Single transaction: lock + count admin rows + apply + audit
    - _Requirements: 2.5, 2.6_

  - [x]* 4.10 Write property test for at-least-one-admin invariant
    - **Property 15: At-Least-One-Admin Invariant**
    - **Validates: Requirements 2.6**

- [x] 5. Implement Pack_Catalog and Welcome_Offer
  - [x] 5.1 Implement `effectivePrice(user, pack, welcomeOffer, now)` pure function and `GET /packs`
    - Considers welcome_offer.enabled, ends_at, and user's completed-purchases count
    - _Requirements: 5.4, 5.11_

  - [x]* 5.2 Write property test for welcome offer eligibility
    - **Property 8: Welcome Offer Eligibility**
    - **Validates: Requirements 5.4**

  - [x] 5.3 Implement `GET /admin/packs` and `PATCH /admin/packs/:slug` with validation
    - Validate `welcome_price < mrp`, ranges, lifetime XOR session_count
    - Write audit row with previous/new values
    - _Requirements: 5.5, 5.6, 11.6_

  - [x]* 5.4 Write property test for pack & welcome offer update invariants
    - **Property 9: Pack & Welcome Offer Update Invariants**
    - **Validates: Requirements 5.1, 5.5, 5.6, 5.9**

  - [x] 5.5 Implement `GET /admin/welcome-offer` and `PATCH /admin/welcome-offer`
    - Audit row on every change with previous/new values
    - _Requirements: 5.7, 5.10, 11.8_

- [x] 6. Implement Entitlement_Ledger
  - [x] 6.1 Implement `appendLedgerEntry(tx, {userId, sessionDelta, lifetimeFlagSet, reason, ...})`
    - Acquires `pg_advisory_xact_lock(user_id)`; computes `resulting_session_count` and `resulting_lifetime_flag` from prior rows; rejects when result would go negative (unless lifetime)
    - _Requirements: 6.1, 6.2, 6.3, 6.7_

  - [x]* 6.2 Write property test for entitlement conservation
    - **Property 1: Entitlement Conservation**
    - **Validates: Requirements 6.1, 6.2, 6.7**

  - [x] 6.3 Implement `GET /me/entitlement` reading the latest ledger row's `resulting_*` columns
    - Within 1 second of commit per Requirement 6.4
    - _Requirements: 6.4_

  - [x] 6.4 Implement admin manual entitlement adjustment endpoint `POST /admin/users/:id/entitlement-adjust`
    - Validate `session_delta ∈ [-1000, 1000] \ {0}`; require non-empty 1–500 char reason note
    - Single transaction: ledger insert + audit insert
    - _Requirements: 6.5, 11.3, 11.4, 11.5_

  - [x]* 6.5 Write property test for manual entitlement adjustment bounds
    - **Property 27: Manual Entitlement Adjustment Bounds**
    - **Validates: Requirements 6.5, 11.3, 11.4, 11.5**

- [x] 7. Implement Session_Service
  - [x] 7.1 Implement `POST /sessions/start`
    - Single transaction: advisory lock → entitlement check → ledger insert (`session_start`, delta -1 or 0 for lifetime) → `interview_sessions` insert (status=`active`, expires_at=started_at+90min)
    - On `session_already_active`, return 409 with `{active_session_id, expires_at}`
    - _Requirements: 8.1, 8.2, 8.3_

  - [x]* 7.2 Write property test for atomic session start with non-negative balance
    - **Property 2: Atomic Session Start with Non-Negative Balance**
    - **Validates: Requirements 6.3, 8.1, 8.2**
    - Use `fc.scheduler` for logical interleaving; use testcontainers for real Postgres concurrency

  - [x]* 7.3 Write property test for single active session per user
    - **Property 3: Single Active Session per User**
    - **Validates: Requirements 8.3**

  - [x] 7.4 Implement `POST /sessions/:id/end`
    - Verifies caller owns session and status is `active`; writes `ended_at` and `ended_reason='ended_by_user'`; no refund
    - _Requirements: 8.6_

  - [x]* 7.5 Write property test for end-session authorization
    - **Property 31: End-Session Authorization**
    - **Validates: Requirements 8.6**

  - [x] 7.6 Implement `GET /me/session/active`
    - Returns `{session_id, started_at, expires_at, remaining_seconds}` or 404 `no_active_session`
    - _Requirements: 8.7_

  - [x] 7.7 Implement scheduled session expiry sweep handler `runSessionExpirySweep()`
    - Idempotent: transitions any `active` rows past `expires_at` to `expired`; emits structured logs
    - Wired into the platform's scheduled-invocation manifest
    - _Requirements: 8.5, 15.4, 15.5_

  - [x]* 7.8 Write property test for scheduled task atomicity
    - **Property 36: Scheduled Task Atomicity**
    - **Validates: Requirements 15.5**
    - Inject failures mid-execution; assert state equals pre-task state and next invocation completes the work

- [x] 8. Implement Razorpay billing integration
  - [x] 8.1 Implement `POST /purchases/checkout`
    - Computes effective price; calls Razorpay Orders API; persists `purchases` row with status=`pending`; returns `{order_id, key_id, amount, currency, checkout_url}`
    - _Requirements: 10.1, 10.2_

  - [x] 8.2 Implement webhook signature verification (`src/billing/razorpay-signature.ts`)
    - HMAC-SHA256 over raw body using `RAZORPAY_WEBHOOK_SECRET`
    - _Requirements: 10.5, 10.6_

  - [x]* 8.3 Write property test for Razorpay webhook signature gate
    - **Property 7: Razorpay Webhook Signature Gate**
    - **Validates: Requirements 10.5, 10.6**

  - [x] 8.4 Implement `POST /webhooks/razorpay` handler
    - Single transaction: signature verify → dedupe by `event_id` → branch on `payment.captured` / `payment.failed` → update purchase + append ledger entry (pack_purchase / lifetime_grant) → mark event processed
    - Returns 200 for replays, unknown order ids (set `unmatched=true`), and successful processing; returns 400 only for signature failures
    - _Requirements: 10.7, 10.8, 10.9, 10.10_

  - [x]* 8.5 Write property test for Razorpay webhook replay safety
    - **Property 6: Razorpay Webhook Replay Safety**
    - **Validates: Requirements 10.9**

  - [x] 8.6 Implement `GET /me/purchases`
    - Reverse-chronological list of caller's purchases with all required fields
    - _Requirements: 10.12_

  - [x] 8.7 Implement scheduled unmatched-webhook reconciliation handler
    - Re-reads `unmatched` events; if a matching purchase row appears, processes it; otherwise leaves for next run
    - _Requirements: 10.10, 15.4, 15.5_

- [x] 9. Implement AI_Proxy
  - [x] 9.1 Implement provider key resolver (`src/ai/keys.ts`)
    - Looks up `provider_keys`, decrypts via the encryption module; returns 503 `provider_key_unavailable` and emits audit row on failure
    - Never logs plaintext keys
    - _Requirements: 4.5, 4.6, 4.7, 7.9_

  - [x] 9.2 Implement provider key admin endpoints `/admin/provider-keys`
    - CRUD with input validation (1–512 chars, no leading/trailing whitespace, provider ∈ {gemini, groq, deepseek, cerebras})
    - Read returns last 4 chars + 8-char fixed mask + `created_at`; rotate increments `version`
    - _Requirements: 4.1, 4.3, 4.4, 4.8, 4.9, 11.9_

  - [x]* 9.3 Write property test for provider key input validation
    - **Property 12: Provider Key Input Validation**
    - **Validates: Requirements 4.1, 4.8**

  - [x]* 9.4 Write property test for provider key confidentiality
    - **Property 10: Provider Key Confidentiality**
    - **Validates: Requirements 4.6, 4.7, 7.9, 11.9, 14.1**
    - Drive arbitrary admin actions and AI ops; scan response bodies, headers, and emitted log records (collected via test sink) for any plaintext key substring

  - [x] 9.5 Implement idempotency cache module (`src/ai/idempotency.ts`)
    - Lookup-then-insert with `INSERT ... ON CONFLICT DO NOTHING RETURNING xmax = 0`; SHA-256 of canonical request payload
    - 24-hour TTL with hourly cleanup task
    - _Requirements: 7.6, 7.7_

  - [x]* 9.6 Write property test for AI idempotency
    - **Property 5: AI Idempotency**
    - **Validates: Requirements 7.6, 7.7**

  - [x] 9.7 Implement `POST /ai/text` (SSE streaming)
    - Validate body (≤ 32k chars); resolve provider by `model` slug; forward with server-held key; stream chunks downstream
    - 60-second AbortController timeout; on error/timeout return 502 `upstream_provider_error`
    - On terminal status, write `usage` row (success or failed)
    - _Requirements: 7.1, 7.4, 7.5, 7.8, 9.1_

  - [x] 9.8 Implement `POST /ai/vision` (SSE streaming)
    - Validate ≤ 10 images, each ≤ 10 MB; same flow as text; 60-second timeout
    - _Requirements: 7.1, 7.4, 7.5_

  - [x] 9.9 Implement `POST /ai/audio` (multipart)
    - Validate ≤ 25 MB and ≤ 5 min; offload blob to object storage with 7-day TTL; route to Whisper; 120-second timeout
    - _Requirements: 7.1, 7.4, 7.5, 15.2_

  - [x]* 9.10 Write property test for AI operation never debits entitlement
    - **Property 4: AI Operation Never Debits Entitlement**
    - **Validates: Requirements 4.5, 7.2, 7.3, 7.4, 7.5, 8.4, 8.9, 12.3**

- [x] 10. Implement Usage_Service
  - [x] 10.1 Implement `GET /me/usage` with cursor pagination
    - Default 30 days, max 92, default page 50, max page 200; reverse-chronological
    - Reject invalid range/page with HTTP 400 `invalid_range_or_page_size`
    - _Requirements: 9.2, 9.3, 9.4_

  - [x]* 10.2 Write property test for usage pagination correctness
    - **Property 29: Usage Pagination Correctness**
    - **Validates: Requirements 9.2**

  - [x] 10.3 Implement `GET /admin/usage`
    - GROUP BY user_id, operation_type, calendar_day_utc; range ≤ 366 days
    - _Requirements: 9.6, 9.7_

  - [x]* 10.4 Write property test for admin usage aggregation correctness
    - **Property 30: Admin Usage Aggregation Correctness**
    - **Validates: Requirements 9.6**

- [x] 11. Implement rate limiting and abuse detection
  - [x] 11.1 Implement `RateLimitStore` interface and Postgres-backed implementation
    - Rolling-window count via `rate_events` with `(user_id, kind, ts)` index; insert-then-count
    - `Retry-After` computed from oldest counted event
    - Defaults: AI 60/min and 1000/day, session_start 5/hour
    - _Requirements: 12.1, 12.2, 12.3_

  - [x]* 11.2 Write property test for rolling-window rate limit
    - **Property 19: Rolling-Window Rate Limit**
    - **Validates: Requirements 12.1, 12.2, 12.3**

  - [x] 11.3 Implement per-user rate limit overrides at `PATCH /admin/rate-limits/:user_id`
    - Validates 0 ≤ value ≤ 100000; takes precedence over defaults at lookup time; writes audit row with previous/new values
    - _Requirements: 12.4_

  - [x]* 11.4 Write property test for rate-limit override application
    - **Property 20: Rate-Limit Override Application**
    - **Validates: Requirements 12.4**

  - [x] 11.5 Implement suspicious-login-velocity detector inside `/auth/login` success path
    - On token issue, record `login_success` rate event with IP; query distinct IPs in last 60 min; emit at most one `suspicious_login_velocity` audit row per account per rolling hour
    - _Requirements: 12.5_

  - [x]* 11.6 Write property test for suspicious login velocity audit cap
    - **Property 21: Suspicious Login Velocity Audit Cap**
    - **Validates: Requirements 12.5**

- [x] 12. Implement remaining admin endpoints
  - [x] 12.1 Implement `GET /admin/users` (paginated with filters) and `GET /admin/users/:id` (purchase history, sessions, ledger, current entitlement)
    - _Requirements: 11.1, 11.2_

  - [x] 12.2 Implement pack deactivation guard inside `PATCH /admin/packs/:slug`
    - Reject deactivation when ≥ 1 `pending` purchases exist; surface count in error `details.pending_orders_count`
    - _Requirements: 11.7_

  - [x]* 12.3 Write property test for pack deactivation gate
    - **Property 28: Pack Deactivation Gate**
    - **Validates: Requirements 11.7**

  - [x] 12.4 Implement `GET /admin/audit-log` with cursor pagination
    - _Requirements: 14.4_

- [x] 13. Implement hosting mode switch and storage gate
  - [x] 13.1 Implement `MODE` config loader (`src/config/mode.ts`)
    - Reads `MODE ∈ {free, paid}` at startup; selects connection strings; any other value causes startup failure before serving traffic
    - _Requirements: 15.6_

  - [x]* 13.2 Write property test for hosting mode switch
    - **Property 34: Hosting Mode Switch**
    - **Validates: Requirements 15.6**

  - [x] 13.3 Implement storage usage gate for blob persistence
    - Periodically samples Postgres storage; rejects new blob writes with HTTP 507 `storage_quota_exceeded` when usage ≥ 450 MB; never modifies existing data
    - _Requirements: 15.3_

  - [x]* 13.4 Write property test for storage threshold gates blob acceptance
    - **Property 35: Storage Threshold Gates Blob Acceptance**
    - **Validates: Requirements 15.3**

- [x] 14. Backend checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Refit the Electron Desktop Client
  - [x] 15.1 Implement client identifier module (`src/auth/client-id.js`)
    - Generates v4 UUID on first run; persists via `safeStorage`; returns it from `getClientId()`
    - _Requirements: 13.1_

  - [x] 15.2 Implement secure-store wrapper (`src/auth/secure-store.js`)
    - Uses Electron `safeStorage` where available; falls back to a `0600` JSON file under `app.getPath('userData')`
    - Never writes to a world- or group-readable location
    - _Requirements: 13.4_

  - [x]* 15.3 Write property test for refresh token storage locality
    - **Property 24: Refresh Token Storage Locality**
    - **Validates: Requirements 13.4**

  - [x] 15.4 Implement legacy config migrator (`src/migration/legacy-config-migrator.js`)
    - Strips `groqApiKey`, `geminiApiKey`, `deepseekApiKey`, `cerebrasApiKey` from `~/.interview-assistant-config.json`; preserves all other key/value pairs byte-for-byte; queues a deletion-event for first connection
    - _Requirements: 3.2, 3.3_

  - [x]* 15.5 Write property test for legacy config migration round-trip
    - **Property 25: Legacy Config Migration Round-Trip**
    - **Validates: Requirements 3.2**

  - [x] 15.6 Implement certificate pinner (`src/net/cert-pinner.js`)
    - Installs `session.setCertificateVerifyProc`; computes SPKI SHA-256 of leaf and intermediate certs and matches against build-time pin set
    - On no match: abort connection before any payload is written and surface a connection-failure indication
    - _Requirements: 13.3_

  - [x]* 15.7 Write property test for certificate pin match
    - **Property 23: Certificate Pin Match**
    - **Validates: Requirements 13.3**

  - [x] 15.8 Implement backend HTTP client (`src/net/backend-client.js`)
    - Always attaches `Authorization`, `X-Client-Id`, `X-Build-Version`, and (when supplied) `Idempotency-Key`; never includes any provider API key
    - Handles 401 → refresh → retry-once; surfaces `{code, message, retry_after}`
    - _Requirements: 3.4, 13.1, 13.6_

  - [x]* 15.9 Write property test for no provider key in desktop outbound traffic
    - **Property 26: No Provider Key in Desktop Outbound Traffic**
    - **Validates: Requirements 3.4**
    - Drive login, mode use, settings save, purchase actions; assert no captured outbound request contains any provider key

  - [x] 15.10 Implement auth controller (`src/auth/auth-controller.js`)
    - Owns access/refresh token lifecycle; proactive refresh at 80% TTL; on refresh failure clears local state and emits `auth:logged-out`
    - _Requirements: 1.6, 1.7, 1.10_

  - [x] 15.11 Implement session controller (`src/session/session-controller.js`)
    - `start()`, `end()`, `getActive()`, `getRemainingSeconds()`; emits `session:state-changed` at most every 10 s with countdown
    - _Requirements: 8.7, 8.8_

  - [x] 15.12 Implement checkout controller (`src/billing/checkout-controller.js`)
    - Calls `POST /purchases/checkout`; opens checkout URL via `shell.openExternal`; on failure presents copyable URL + order id; polls entitlement on app focus
    - _Requirements: 10.3, 10.4_

  - [x] 15.13 Refactor `src/main.js` IPC handlers (`call-ai-stream`, `call-gemini-api`, `call-deepseek-api`, `call-ai-api`, `transcribe-audio`)
    - Replace direct provider HTTPS calls with `backendRequest` calls to `/ai/text`, `/ai/vision`, `/ai/audio`
    - Preserve channel names and the `ai-stream-chunk` IPC event so renderer behavior is unchanged
    - Strip every provider API key read from local config / env
    - _Requirements: 3.4, 7.1, 7.4, 7.8, 16.2, 16.3, 16.4_

  - [x] 15.14 Update `src/preload.js` to expose `interviewAssistantApi`
    - `auth`, `entitlement`, `session`, `purchase`, `ai`, `config` namespaces per design
    - Keep legacy `ipcRenderer` exposure for one release cycle
    - _Requirements: 3.4_

  - [x] 15.15 Update `src/renderer/settings.html`
    - Remove all provider API key inputs (Groq, Gemini, DeepSeek, Cerebras)
    - Add account info card (email, role, remaining sessions / lifetime badge), "Buy More Sessions", sign-out, conditional "Open Admin Dashboard" link
    - Preserve resume context, job context, model preference selector
    - _Requirements: 3.1, 3.5, 3.6_

  - [x] 15.16 Update `src/renderer/index.html`
    - Add session badge with countdown timer (refresh ≥ every 10 s, warning when < 5 min)
    - Show "Start Interview Session" CTA replacing mode tabs when no session is active
    - Show "End Session" button while active; render packs in order `starter, pro, lifetime` with strike-through MRP for welcome-discounted prices
    - On 402 errors preserve conversation history; on 30-second first-chunk timeout cancel and preserve history
    - _Requirements: 5.11, 8.8, 16.1, 16.6, 16.7, 16.8_

  - [x]* 15.17 Write property test for system prompt context inclusion
    - **Property 32: System Prompt Context Inclusion**
    - **Validates: Requirements 16.5**

  - [x]* 15.18 Write property test for AI failure preserves conversation history
    - **Property 33: AI Failure Preserves Conversation History**
    - **Validates: Requirements 16.7**

  - [x]* 15.19 Write property test for pack rendering order and discount display
    - **Property 37: Pack Rendering Order and Discount Display**
    - **Validates: Requirements 5.11**

- [x] 16. Desktop client checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Implement Admin Dashboard (browser app)
  - [x] 17.1 Initialize admin dashboard project (`admin-dashboard/`) with React + Vite + TypeScript
    - Shared API client targeting the Backend API; admin-only JWT handling
    - _Requirements: 11.10_

  - [x] 17.2 Implement sign-in page that calls `/auth/login` and gates non-admin role claims with redirect
    - _Requirements: 11.10_

  - [x] 17.3 Implement Users list and detail pages (filters, ledger, sessions, current entitlement, grant/revoke + lifetime modals)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 17.4 Implement Pricing & Packs page with inline edit, real-time discount %, validation that blocks submission when welcome ≥ MRP
    - _Requirements: 5.8, 5.9, 11.6, 11.7_

  - [x] 17.5 Implement Welcome Offer page with toggle, datetime picker, and confirmation dialog
    - _Requirements: 5.10, 11.8_

  - [x] 17.6 Implement Provider Keys page (masked list, create / rotate / delete) calling `/admin/provider-keys`
    - _Requirements: 4.1, 4.3, 11.9_

  - [x] 17.7 Implement Audit Log page (read-only paginated)
    - _Requirements: 14.4_

  - [x] 17.8 Implement Rate Limit Overrides page (per-user numeric inputs)
    - _Requirements: 12.4_

- [x] 18. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP.
- Each task references the specific requirement clauses it implements for traceability.
- Property tests are placed adjacent to the code they validate; each cites its property number from the design's Correctness Properties section and the requirement clauses it covers.
- Checkpoints (sections 14, 16, 18) ensure incremental validation between major surface boundaries (backend, desktop client, admin dashboard).
- The implementation language is TypeScript for the backend and admin dashboard, and JavaScript (preserving the existing Electron stack) for the desktop client. No language clarification is required because the design specifies these stacks explicitly.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6"] },
    { "id": 2, "tasks": ["2.7", "3.1", "3.3", "3.4"] },
    { "id": 3, "tasks": ["3.2", "3.5", "4.1", "5.1", "13.1"] },
    { "id": 4, "tasks": ["3.6", "3.7", "4.2", "4.3", "4.5", "4.7", "4.8", "4.9", "5.2", "5.3", "5.5", "6.1", "9.1", "9.2", "11.1", "13.2", "13.3"] },
    { "id": 5, "tasks": ["4.4", "4.6", "4.10", "5.4", "6.2", "6.3", "6.4", "7.1", "7.4", "7.6", "7.7", "8.1", "8.2", "9.5", "10.1", "10.3", "11.3", "11.5", "12.1", "12.2", "12.4", "13.4", "9.3", "9.4"] },
    { "id": 6, "tasks": ["6.5", "7.2", "7.3", "7.5", "7.8", "8.3", "8.4", "8.6", "8.7", "9.6", "9.7", "9.8", "9.9", "10.2", "10.4", "11.2", "11.4", "11.6", "12.3"] },
    { "id": 7, "tasks": ["8.5", "9.10"] },
    { "id": 8, "tasks": ["15.1", "15.2", "15.4", "15.6"] },
    { "id": 9, "tasks": ["15.3", "15.5", "15.7", "15.8", "15.10", "15.11", "15.12"] },
    { "id": 10, "tasks": ["15.9", "15.13", "15.14"] },
    { "id": 11, "tasks": ["15.15", "15.16"] },
    { "id": 12, "tasks": ["15.17", "15.18", "15.19", "17.1"] },
    { "id": 13, "tasks": ["17.2"] },
    { "id": 14, "tasks": ["17.3", "17.4", "17.5", "17.6", "17.7", "17.8"] }
  ]
}
```
