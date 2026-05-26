# Requirements Document

## Introduction

This feature transforms the Interview Assistant from a local app where every end user supplies their own AI provider API keys into a productized desktop application sold as one-time **Interview Session Packs** for the Indian market. Provider API keys are removed from the end-user UI and centralized under an admin role. End users authenticate against a backend, purchase a Session Pack via Razorpay, and consume AI operations (text Q&A, screen analysis, audio transcription) inside time-bounded **Interview Sessions** brokered by a server-side AI Proxy that holds the provider keys.

The product offers three packs at a one-time **Welcome Offer** discount applied to each user's first purchase only:

| Pack | Sessions | MRP (₹) | Welcome Offer Price (₹) | Discount |
|------|----------|---------|-------------------------|----------|
| Starter | 5 Interview Sessions | 999 | 499 | 50% off |
| Pro | 15 Interview Sessions | 2,499 | 999 | 60% off |
| Lifetime | Unlimited Interview Sessions | 9,999 | 1,999 | 80% off |

The architecture targets near-zero hosting cost at low user counts (free tiers of Supabase or Cloudflare and Razorpay's pay-per-transaction pricing) while keeping the data model and contracts portable so the same backend can be moved to paid infrastructure without changing the desktop client.

The Electron desktop client (`src/main.js`, `src/preload.js`, `src/renderer/index.html`, `src/renderer/settings.html`, `src/screen-reader.js`) keeps its existing manual / passive / screen-analyzer modes; the change is a settings refactor plus replacement of direct provider HTTPS calls with calls to the Backend API, gated by an active Interview Session.

### Foundational Assumptions

These assumptions drive multiple requirements; correct them and the dependent criteria will be revised:

1. **Interview Session model**: An Interview Session is a 90-minute window during which the End_User has unlimited AI operations across Manual, Passive, and Screen Analyzer modes. One session is decremented from the End_User's Entitlement at session start. The session ends when the End_User explicitly ends it, when 90 minutes elapse, or when the End_User signs out, whichever occurs first. A user may hold at most one active Interview Session at a time.
2. **Welcome Offer scope**: The discounted price applies to a given End_User's first successful pack purchase only. After the first successful purchase, future purchases for that End_User are charged at MRP. The Welcome Offer has a configurable global end date and may be paused by an Admin.
3. **Lifetime entitlement**: A successful Lifetime pack purchase grants unlimited Interview Sessions for the lifetime of the End_User's account and supersedes any remaining session count from prior packs.

## Glossary

- **Desktop_Client**: The Electron application installed on the end user's machine.
- **Backend_API**: The remote HTTPS service that authenticates users, brokers AI calls, manages purchases, and tracks session entitlements.
- **AI_Proxy**: The Backend_API subsystem that forwards requests to upstream AI providers (Gemini, Groq, DeepSeek, Cerebras, Whisper) using server-held provider API keys.
- **Auth_Service**: The Backend_API subsystem responsible for user registration, login, session and refresh tokens, password reset, and email verification.
- **Purchase_Service**: The Backend_API subsystem that manages Pack catalog, Razorpay orders, payment confirmation, and Welcome Offer eligibility.
- **Session_Service**: The Backend_API subsystem that starts, tracks, and ends Interview Sessions and that enforces the single-active-session rule per End_User.
- **Entitlement_Ledger**: The append-only datastore subsystem that records every session entitlement change (purchase grant, session start consumption, lifetime grant, admin adjustment, refund).
- **Usage_Service**: The Backend_API subsystem that records every AI_Operation and links it to the active Interview Session.
- **Admin_Dashboard**: The web UI used by Admin users to manage Packs, provider API keys, Welcome Offer, users, and entitlements.
- **End_User**: An authenticated user with role `user` who consumes Interview Sessions.
- **Admin**: An authenticated user with role `admin` who manages provider keys, Packs, Welcome Offer, and other users.
- **Pack**: A one-time purchase product from the catalog (Starter, Pro, Lifetime) that grants a fixed number of Interview Sessions or unlimited Interview Sessions.
- **Pack_Catalog**: The persisted list of available Packs with MRP, Welcome Offer price, session count or lifetime flag, and active flag.
- **Interview_Session**: A time-bounded 90-minute window of unlimited AI_Operations consumed from the End_User's Entitlement.
- **Entitlement**: A per-user computed value containing remaining session count (a non-negative integer) and a lifetime flag (boolean), derived from the Entitlement_Ledger.
- **Welcome_Offer**: A configurable global discount campaign that applies once per End_User to their first successful pack purchase.
- **AI_Operation**: A single Desktop_Client-initiated AI call brokered by the AI_Proxy (text completion, vision analysis, or audio transcription) within an active Interview Session.
- **Provider_Key**: A secret API key for an upstream AI provider, stored encrypted at rest in the Backend.
- **Session_Token**: A short-lived bearer token (access token) used by the Desktop_Client to authenticate against the Backend_API.
- **Refresh_Token**: A long-lived token used by the Desktop_Client to obtain a new Session_Token without re-prompting the user.
- **Idempotency_Key**: A client-supplied unique identifier used to deduplicate AI_Operation requests on retry.
- **Rate_Limit**: A per-user cap on AI_Operation requests per time window enforced by the Backend_API.
- **Audit_Log**: An append-only record of security-relevant and billing-relevant events.
- **Razorpay_Order**: A Razorpay-issued order resource representing an intent to pay for a Pack, identified by a Razorpay order id.
- **Razorpay_Payment**: A Razorpay-issued payment resource representing a captured payment against a Razorpay_Order, identified by a Razorpay payment id.

## Requirements

### Requirement 1: End-User Authentication

**User Story:** As an End_User, I want to sign up and sign in to the Desktop_Client, so that the Backend_API can identify me and gate my Interview Sessions to my paid Entitlement.

#### Acceptance Criteria

1. WHEN an unauthenticated End_User opens the Desktop_Client, THE Desktop_Client SHALL display a sign-in screen containing an email field, a password field, a sign-in button, and a registration link, and SHALL block access to Manual, Passive, and Screen Analyzer modes until authentication succeeds.
2. WHEN an End_User submits credentials consisting of an email matching RFC 5322 format (maximum 254 characters) and a password (8 to 128 characters) that match a verified account, THE Auth_Service SHALL return a Session_Token with a lifetime of 60 minutes and a Refresh_Token with a lifetime of 30 days within 5 seconds.
3. WHEN an End_User submits a registration request with an email matching RFC 5322 format (maximum 254 characters) that is not already registered and a password of 12 to 128 characters containing at least one uppercase letter, one lowercase letter, one digit, and one symbol, THE Auth_Service SHALL create a user record with role `user`, send an email verification link valid for 24 hours, and return a pending-verification status.
4. WHILE an End_User has not verified their email, THE Backend_API SHALL reject Interview Session start requests and AI_Operation requests with HTTP 403 and the error code `email_not_verified`.
5. IF an End_User submits invalid credentials 5 times within 15 minutes from the same account, THEN THE Auth_Service SHALL temporarily lock the account for 15 minutes, reject further sign-in attempts during the lockout regardless of credential correctness, and return HTTP 429 with a Retry-After value indicating remaining lockout seconds.
6. WHEN a Session_Token expires and the Refresh_Token is still valid and not revoked, THE Desktop_Client SHALL exchange the Refresh_Token for a new Session_Token within 5 seconds without prompting the End_User.
7. WHEN an End_User signs out, THE Desktop_Client SHALL revoke the Refresh_Token via the Auth_Service, end any active Interview Session per Requirement 8, and clear all Session_Tokens and Refresh_Tokens from local storage before returning to the sign-in screen.
8. THE Auth_Service SHALL store passwords using a memory-hard hashing algorithm with a per-user salt of at least 16 bytes and SHALL NOT store, log, or transmit plaintext passwords.
9. IF an End_User submits a registration request with an email that is already registered, THEN THE Auth_Service SHALL reject the request with HTTP 409 and an error indicating the email cannot be used, without disclosing whether the existing account is verified.
10. IF the Refresh_Token is expired, revoked, or rejected by the Auth_Service when the Desktop_Client attempts to refresh, THEN THE Desktop_Client SHALL clear all locally stored tokens and return the End_User to the sign-in screen with a message indicating re-authentication is required.

### Requirement 2: Role-Based Access Control

**User Story:** As an Admin, I want only users with the admin role to manage provider keys, Packs, and the Welcome Offer, so that End_Users cannot view or modify infrastructure secrets or pricing configuration.

#### Acceptance Criteria

1. THE Auth_Service SHALL assign every user exactly one role from the set {`user`, `admin`} at user creation time and SHALL reject any user record that contains zero roles or more than one role.
2. WHEN an authenticated request is received for an Admin endpoint, THE Backend_API SHALL verify that the Session_Token claims include role `admin` before processing the request, where Admin endpoints are defined as all endpoints under the `/admin` path prefix and any endpoint that creates, reads, updates, or deletes Provider_Keys, Packs, the Welcome_Offer, or other users' records.
3. IF a request to an Admin endpoint arrives with no Session_Token, with a Session_Token whose role claim is missing, or with a role claim whose value is not `admin`, THEN THE Backend_API SHALL return HTTP 403 with error code `forbidden_role`, SHALL return an identical response body and identical headers regardless of whether the targeted resource exists, and SHALL NOT modify any persisted state.
4. WHEN a user account is created on a deployment that currently has zero users with role `admin`, THE Auth_Service SHALL assign that user role `admin` and SHALL append an entry to the Audit_Log containing the user id, the assigned role, an ISO 8601 UTC timestamp, and reason code `bootstrap_admin`.
5. WHEN an authenticated Admin submits a role change for another user, THE Auth_Service SHALL apply the change and SHALL append an entry to the Audit_Log containing the acting Admin's user id, the target user id, the previous role, the new role, and an ISO 8601 UTC timestamp, within 1 second of the change being committed.
6. IF a role-change request is submitted by a caller whose Session_Token role claim is not `admin`, OR IF applying the requested role change would result in zero remaining users with role `admin` across the deployment, OR IF the target user id does not correspond to an existing user record, THEN THE Auth_Service SHALL reject the request with HTTP 403 and an error code indicating the role change is not permitted, and SHALL NOT modify any user record or write any role-change entry to the Audit_Log.
7. THE Desktop_Client SHALL hide all provider-key, Pack-management, Welcome_Offer, and user-management UI elements from any session whose role claim is not `admin`, and SHALL re-evaluate visibility within 1 second of the active Session_Token being refreshed or replaced.

### Requirement 3: Removal of End-User API Key Configuration

**User Story:** As an End_User, I want the Desktop_Client to no longer require or accept provider API keys, so that I can use the product without managing third-party credentials.

#### Acceptance Criteria

1. THE Desktop_Client SHALL NOT render input fields, labels, or controls for Groq, Gemini, DeepSeek, or Cerebras provider API keys in any End_User-facing settings view.
2. WHEN the Desktop_Client starts and detects a legacy `~/.interview-assistant-config.json` file, THE Desktop_Client SHALL remove all provider API key fields (Groq, Gemini, DeepSeek, Cerebras) from that file within 5 seconds of startup completion, SHALL preserve all non-key configuration fields unchanged, and SHALL submit a deletion-event record to the Backend_API containing the user id and deletion timestamp.
3. IF the Desktop_Client cannot reach the Backend_API to submit the provider-key deletion event, THEN THE Desktop_Client SHALL retain a local pending-event record, SHALL retry submission on each subsequent successful Backend_API connection until acknowledged, and SHALL still complete removal of the provider API keys from the legacy configuration file.
4. THE Desktop_Client SHALL NOT read provider API keys from local files, environment variables, or in-memory configuration when constructing AI_Operation requests, and SHALL NOT include any provider API key in request headers, query parameters, or request bodies sent to the Backend_API.
5. WHILE the authenticated session has role `admin`, THE Desktop_Client SHALL display a separate Admin section within settings containing a labeled control that opens the Admin_Dashboard URL in the user's default external browser for provider key management.
6. WHEN an End_User opens the settings view, THE Desktop_Client SHALL display only the following fields and controls: account info (email, role, remaining sessions or lifetime indicator), resume context, job context, a model preference selector restricted to models permitted by the End_User's current Pack, a "Buy More Sessions" control, and a sign-out control; and SHALL NOT display provider API key fields, Pack management controls, Welcome_Offer controls, or user management controls.

### Requirement 4: Admin Provider Key Management

**User Story:** As an Admin, I want to set, rotate, and revoke provider API keys from the Admin_Dashboard, so that the AI_Proxy can call upstream providers without exposing keys to End_Users.

#### Acceptance Criteria

1. THE Admin_Dashboard SHALL provide create, read (masked), update, and delete operations for Provider_Keys for the providers Gemini, Groq, DeepSeek, and Cerebras, and SHALL accept Provider_Key values that are between 1 and 512 characters in length and contain no leading or trailing whitespace.
2. WHEN an Admin saves a Provider_Key, THE Backend_API SHALL encrypt the key using AES-256-GCM with a key derived from a server-side master secret before persisting it.
3. WHEN an Admin reads a Provider_Key list, THE Admin_Dashboard SHALL display only the last 4 characters of each key and the creation timestamp, and SHALL display the masked portion as a fixed-length placeholder of 8 characters regardless of original key length.
4. WHEN an Admin rotates a Provider_Key, THE Backend_API SHALL atomically replace the stored ciphertext within a single database transaction and SHALL increment a monotonically increasing key version counter recorded in the Audit_Log together with the acting Admin's user id, the provider name, and the new version number.
5. IF the AI_Proxy cannot retrieve, locate, or decrypt a stored Provider_Key for the provider required by an AI_Operation, THEN THE AI_Proxy SHALL reject the request with HTTP 503 and error code `provider_key_unavailable`, SHALL NOT consume any Interview Session time, and SHALL emit an alert event to the Audit_Log containing the provider name, the failure category (missing, revoked, or decryption_failed), and the timestamp.
6. THE Backend_API SHALL NOT return any plaintext Provider_Key over any API endpoint.
7. THE Backend_API SHALL NOT log plaintext Provider_Keys in application logs, error messages, or HTTP traces.
8. IF an Admin submits a Provider_Key value that is empty, exceeds 512 characters, contains leading or trailing whitespace, or targets a provider not in the set {Gemini, Groq, DeepSeek, Cerebras}, THEN THE Backend_API SHALL reject the operation with HTTP 400 and error code `invalid_provider_key` and SHALL leave any previously stored Provider_Key for that provider unchanged.
9. WHEN an Admin creates or deletes a Provider_Key, THE Backend_API SHALL record an Audit_Log entry containing the acting Admin's user id, the provider name, the action type (`create` or `delete`), and the timestamp, within 5 seconds of the operation completing.

### Requirement 5: Pack Catalog and Welcome Offer

**User Story:** As an End_User, I want to see the available Packs with the Welcome Offer prices applied to my first purchase, so that I can choose a Pack that matches my needs and benefit from the launch discount.

#### Acceptance Criteria

1. THE Purchase_Service SHALL persist a Pack_Catalog containing exactly three Packs identified by the slugs `starter`, `pro`, and `lifetime`, where each Pack record contains: a display name (1 to 50 characters), a description (1 to 500 characters), an MRP in INR paise expressed as a positive integer no greater than 100,000,000, a Welcome Offer price in INR paise expressed as a non-negative integer strictly less than the MRP, a session_count expressed as a positive integer for `starter` and `pro` and a lifetime flag (boolean) for `lifetime`, and a boolean active flag.
2. THE Purchase_Service SHALL initialize the Pack_Catalog with the following defaults on first deployment: `starter` MRP 99900 paise (₹999), Welcome Offer 49900 paise (₹499), session_count 5; `pro` MRP 249900 paise (₹2499), Welcome Offer 99900 paise (₹999), session_count 15; `lifetime` MRP 999900 paise (₹9999), Welcome Offer 199900 paise (₹1999), lifetime flag true.
3. THE Purchase_Service SHALL persist a single Welcome_Offer record containing: an enabled boolean flag, an end timestamp in UTC, and a created_at timestamp; the Welcome_Offer SHALL be initialized as enabled with an end timestamp 90 days after first deployment.
4. WHEN an authenticated End_User requests `GET /packs`, THE Purchase_Service SHALL return the active Packs from the Pack_Catalog and a per-Pack effective price equal to the Welcome Offer price IF the Welcome_Offer is enabled AND the current UTC time is before the Welcome_Offer end timestamp AND the End_User has zero successfully captured Razorpay_Payments in their purchase history, otherwise the effective price SHALL equal the Pack's MRP.
5. WHEN an Admin updates a Pack's display name, description, MRP, Welcome Offer price, session_count, or active flag via the Admin_Dashboard, THE Purchase_Service SHALL validate that MRP and Welcome Offer price are positive integers no greater than 100,000,000 paise, that Welcome Offer price is strictly less than MRP, and that session_count is a positive integer for non-lifetime Packs; and SHALL append an Audit_Log entry containing the acting Admin's user id, the Pack slug, the previous values, the new values, and a UTC timestamp.
6. IF an Admin submits a Pack update that fails the validation in criterion 5, THEN THE Purchase_Service SHALL reject the request with HTTP 400, return an error response identifying the invalid field, and SHALL NOT modify the Pack record.
7. WHEN an Admin updates the Welcome_Offer enabled flag or end timestamp via the Admin_Dashboard, THE Purchase_Service SHALL persist the change and SHALL append an Audit_Log entry containing the acting Admin's user id, the previous values, the new values, and a UTC timestamp.
8. THE Admin_Dashboard SHALL provide a "Pricing & Packs" section accessible only to Admin users that displays all Packs from the Pack_Catalog in a table showing slug, display name, MRP (formatted in ₹), Welcome Offer price (formatted in ₹), computed discount percentage, session_count or lifetime indicator, and active flag, with inline edit controls for each field.
9. WHEN an Admin edits a Pack's MRP or Welcome Offer price in the Admin_Dashboard, THE Admin_Dashboard SHALL display the computed discount percentage in real time as floor((MRP - Welcome Offer price) / MRP * 100) and SHALL prevent form submission if the Welcome Offer price is greater than or equal to the MRP.
10. THE Admin_Dashboard SHALL display the Welcome_Offer configuration (enabled flag, end timestamp) alongside the Pack table, with controls to toggle the enabled flag and to set the end timestamp via a date-time picker, and SHALL show a confirmation dialog before persisting any Welcome_Offer change.
11. THE Desktop_Client SHALL display the Pack list ordered as `starter`, `pro`, `lifetime`, and FOR each Pack whose effective price differs from the MRP, SHALL display the MRP as struck-through text alongside the effective price and a "Welcome Offer" label.

### Requirement 6: Entitlement Ledger and Computed Entitlement

**User Story:** As an End_User, I want my remaining Interview Sessions to update atomically with every purchase and session start, so that I can trust I am only charged for sessions I consume and never over-consume my pack.

#### Acceptance Criteria

1. THE Entitlement_Ledger SHALL store every entitlement change as an append-only entry containing: user id, UTC timestamp with millisecond precision, a non-zero integer session_delta in the range -1,000,000 to 1,000,000, a lifetime_flag_set value from the set {`unchanged`, `set_true`}, a reason code drawn from the enumerated set {`pack_purchase`, `lifetime_grant`, `session_start`, `session_refund`, `admin_adjustment`}, related Razorpay_Payment id (nullable), related Interview_Session id (nullable), acting Admin user id (nullable), and a resulting session_count and resulting lifetime_flag.
2. THE Entitlement for a user SHALL be computed as: lifetime_flag equals true IF any Entitlement_Ledger entry for that user has lifetime_flag_set equal to `set_true`, otherwise false; remaining session_count equals the sum of session_delta across all Entitlement_Ledger entries for that user, clamped to a non-negative integer in the range 0 to 1,000,000.
3. IF a session_start insert would cause the resulting session_count to be negative AND the user's lifetime_flag is false, THEN THE Entitlement_Ledger SHALL reject the insert, return error code `no_sessions_remaining`, and SHALL NOT persist the entry; AND THE Entitlement_Ledger SHALL serialize concurrent inserts for the same user such that no committed sequence of inserts produces a negative session_count at any point.
4. WHEN an Entitlement_Ledger entry for a user is committed, THE Backend_API SHALL serve the updated Entitlement to subsequent `GET /me/entitlement` requests within 1 second of commit.
5. WHEN an Admin grants or revokes sessions manually through the Admin_Dashboard, THE Entitlement_Ledger SHALL record an entry with reason code `admin_adjustment`, the acting Admin's user id, and a session_delta whose absolute value is at most 1,000, and SHALL write a corresponding event to the Audit_Log within 1 second of the ledger commit.
6. IF any request attempts to update, overwrite, or hard-delete an existing Entitlement_Ledger entry, THEN THE Entitlement_Ledger SHALL reject the request with an error indicating the operation is not permitted and SHALL preserve the entry indefinitely.
7. WHILE a user's lifetime_flag is true, THE Backend_API SHALL treat session_start requests as not requiring session_count decrement and SHALL append a `session_start` Entitlement_Ledger entry with session_delta equal to 0.

### Requirement 7: Server-Side AI Proxy

**User Story:** As an End_User, I want my AI requests routed through the Backend_API and gated by an active Interview Session, so that provider API keys never leave the server and my entitlement is enforced consistently.

#### Acceptance Criteria

1. THE AI_Proxy SHALL expose endpoints for text completion, vision (image plus text) completion, and audio transcription that mirror the inputs the Desktop_Client previously sent directly to providers, accepting at most 32,000 characters of input text per request, at most 10 input images per request with each image at most 10 megabytes, and at most one audio file per transcription request of at most 25 megabytes and at most 5 minutes of duration.
2. WHEN the AI_Proxy receives a request, THE AI_Proxy SHALL authenticate the Session_Token, and IF the Session_Token is missing, expired, or invalid, THEN THE AI_Proxy SHALL reject the request with HTTP 401 and error code `unauthenticated` without consulting the Entitlement_Ledger.
3. WHEN the AI_Proxy receives a request with a valid Session_Token, THE AI_Proxy SHALL verify that the End_User has an active Interview_Session per Requirement 8, and IF no active Interview_Session exists, THEN THE AI_Proxy SHALL reject the request with HTTP 402 and error code `no_active_session` without forwarding the request to any upstream provider.
4. WHEN the AI_Proxy accepts a request, THE AI_Proxy SHALL associate the request with the active Interview_Session id and SHALL forward the request to the upstream provider; AI_Operations within an active Interview_Session SHALL NOT consume any additional session count.
5. IF the upstream provider returns an error, or the AI_Proxy does not receive a complete response within 60 seconds for text or vision requests or within 120 seconds for audio transcription requests, THEN THE AI_Proxy SHALL return HTTP 502 with an error indicating an upstream provider failure to the Desktop_Client and SHALL NOT consume or alter the End_User's Entitlement for that request.
6. WHEN a request includes an Idempotency_Key that has been seen for the same user within the previous 24 hours and whose stored request payload hash matches the current request payload hash, THE AI_Proxy SHALL return the original response without forwarding a new request to the upstream provider.
7. IF a request includes an Idempotency_Key that has been seen for the same user within the previous 24 hours but whose stored request payload hash does not match the current request payload hash, THEN THE AI_Proxy SHALL reject the request with HTTP 409 and error code `idempotency_key_conflict`.
8. WHEN the Desktop_Client requests streaming and the AI_Proxy has accepted the request, THE AI_Proxy SHALL stream upstream provider response chunks back to the Desktop_Client in the order received, preserving the existing token-by-token rendering behavior.
9. THE AI_Proxy SHALL NOT include Provider_Keys in any response headers, response bodies, error messages, or logs.

### Requirement 8: Interview Session Lifecycle

**User Story:** As an End_User, I want to start, see, and end Interview Sessions, so that my pack is consumed predictably and I can use unlimited AI operations within an active session.

#### Acceptance Criteria

1. WHEN an authenticated End_User submits a `POST /sessions/start` request, THE Session_Service SHALL verify the End_User has either remaining session_count of at least 1 or lifetime_flag equal to true, AND SHALL verify the End_User has zero currently active Interview_Sessions, AND on success SHALL create an Interview_Session with status `active`, a started_at timestamp in UTC, an expires_at timestamp equal to started_at plus 90 minutes, and a unique session id; AND SHALL append a corresponding Entitlement_Ledger entry per Requirement 6 within a single atomic transaction.
2. IF an End_User submits `POST /sessions/start` but their session_count is 0 AND lifetime_flag is false, THEN THE Session_Service SHALL reject the request with HTTP 402 and error code `no_sessions_remaining`, SHALL NOT create an Interview_Session, and SHALL NOT modify the Entitlement_Ledger.
3. IF an End_User submits `POST /sessions/start` while another Interview_Session for the same End_User has status `active`, THEN THE Session_Service SHALL reject the request with HTTP 409 and error code `session_already_active`, and SHALL return the active session id and expires_at in the error body.
4. WHILE an Interview_Session has status `active` AND the current UTC time is before expires_at, THE Backend_API SHALL accept AI_Proxy requests from the End_User per Requirement 7.
5. WHEN the current UTC time reaches an active Interview_Session's expires_at, THE Session_Service SHALL transition the Interview_Session status to `expired` within 60 seconds and SHALL emit a structured log entry indicating natural expiry.
6. WHEN an End_User submits `POST /sessions/{id}/end`, THE Session_Service SHALL transition the Interview_Session status to `ended` IF the session belongs to the End_User AND its status is `active`, SHALL record an ended_at timestamp, and SHALL NOT refund the consumed session count.
7. THE Backend_API SHALL expose `GET /me/session/active` returning the current active Interview_Session for the authenticated End_User including session id, started_at, expires_at, and remaining seconds, or HTTP 404 with error code `no_active_session` IF no Interview_Session is active.
8. THE Desktop_Client SHALL display a visible countdown of remaining session minutes during an active Interview_Session refreshed at least once every 10 seconds and SHALL show a warning indicator when remaining time is less than 5 minutes.
9. IF an active Interview_Session expires while AI operations are in flight, THEN THE AI_Proxy SHALL allow in-flight upstream requests to complete and SHALL reject any new AI_Operation request submitted after the expiry timestamp with HTTP 402 and error code `no_active_session`.

### Requirement 9: Usage Metering and History

**User Story:** As an End_User, I want to see my recent Interview Sessions and the AI operations within them, so that I can review my usage history.

#### Acceptance Criteria

1. WHEN the AI_Proxy completes an AI_Operation with terminal status (`success` or `failed`), THE Usage_Service SHALL record exactly one Usage entry within 1 second of the terminal event containing user id, Interview_Session id, timestamp in UTC with millisecond precision, operation type, model id, request size in input tokens or input image count, response size in output tokens, status from the set {`success`, `failed`}, and upstream provider HTTP status code.
2. WHEN an authenticated End_User requests `GET /me/usage` with a time range whose span is at most 92 days, THE Usage_Service SHALL return that End_User's Interview_Sessions and the Usage entries within them for the requested range in reverse chronological order, paginated with a default page size of 50 entries, a maximum page size of 200 entries, and a next-page cursor when more entries exist, within 2 seconds for ranges containing up to 10000 entries.
3. IF a `GET /me/usage` request omits the time range, THEN THE Usage_Service SHALL default the range to the most recent 30 days ending at the current UTC time.
4. IF a `GET /me/usage` request specifies a time range whose span exceeds 92 days, whose start is after its end, or whose page size exceeds 200, THEN THE Usage_Service SHALL reject the request with HTTP 400 and an error code indicating an invalid range or page size, and SHALL NOT return any entries.
5. THE Usage_Service SHALL retain every Usage entry and Interview_Session record for at least 365 days from the entry's timestamp and SHALL NOT support hard deletion before that retention period elapses.
6. WHEN an authenticated Admin requests `GET /admin/usage` with a time range whose span is at most 366 days, THE Usage_Service SHALL return totals of Interview_Session count and AI_Operation count grouped by user id, by operation type, and by calendar day in UTC for the requested range, within 5 seconds for ranges containing up to 1000000 entries.
7. IF a non-admin authenticated user calls `GET /admin/usage`, THEN THE Backend_API SHALL return HTTP 403 with error code `forbidden_role` and SHALL NOT return any aggregated data.

### Requirement 10: Razorpay Billing Integration

**User Story:** As an End_User in India, I want to pay for a Pack via Razorpay and have my Entitlement updated automatically on successful payment, so that I can start using Interview Sessions immediately after paying.

#### Acceptance Criteria

1. WHEN an authenticated End_User submits `POST /purchases/checkout` with a Pack slug from the set {`starter`, `pro`, `lifetime`}, THE Purchase_Service SHALL determine the End_User's effective price per Requirement 5, SHALL create a Razorpay_Order via the Razorpay Orders API with amount equal to the effective price in paise, currency `INR`, and a server-generated receipt id, SHALL persist a Purchase record with status `pending` linking the End_User, the Pack slug, the effective price, and the Razorpay order id, AND SHALL return the Razorpay order id, Razorpay key id, amount, currency, and a hosted Razorpay Checkout URL within 5 seconds.
2. IF creation of a Razorpay_Order fails for any reason (network error, Razorpay API error, invalid Pack slug), THEN THE Purchase_Service SHALL return an error response indicating order creation failure, SHALL NOT create a Purchase record, and SHALL NOT modify the Entitlement_Ledger.
3. WHEN the Desktop_Client receives the Razorpay Checkout URL from the Purchase_Service, THE Desktop_Client SHALL open the URL in the End_User's default external browser using the OS shell within 2 seconds.
4. IF the OS shell fails to open the Razorpay Checkout URL, THEN THE Desktop_Client SHALL display an error message indicating the browser could not be launched and SHALL present the checkout URL as copyable text to the End_User along with the order id.
5. WHEN Razorpay sends a webhook to the Backend_API webhook endpoint with the `X-Razorpay-Signature` header, THE Purchase_Service SHALL verify the signature using HMAC-SHA256 with the configured Razorpay webhook secret before processing the event body.
6. IF a Razorpay webhook signature is missing, malformed, or fails verification, THEN THE Purchase_Service SHALL return HTTP 400, SHALL NOT modify any Purchase record or Entitlement_Ledger, and SHALL append an Audit_Log entry containing the source IP, the timestamp, and the failure reason.
7. WHEN the Purchase_Service receives a signature-verified `payment.captured` webhook for a known Razorpay order id whose Purchase record status is `pending`, THE Purchase_Service SHALL within 5 seconds: transition the Purchase status to `completed`, persist the Razorpay_Payment id, and append an Entitlement_Ledger entry with reason code `pack_purchase` granting the Pack's session_count (for `starter` and `pro`) or with reason code `lifetime_grant` setting lifetime_flag_set to `set_true` (for `lifetime`).
8. IF the Purchase_Service receives a signature-verified `payment.failed` webhook for a known Razorpay order id whose Purchase record status is `pending`, THEN THE Purchase_Service SHALL transition the Purchase status to `failed`, SHALL NOT modify the Entitlement_Ledger, and SHALL respond with HTTP 200.
9. THE Purchase_Service SHALL deduplicate Razorpay webhook events by Razorpay event id such that a replayed event for an already-`completed` or already-`failed` Purchase produces no additional Purchase or Entitlement_Ledger state change and responds with HTTP 200.
10. IF a signature-verified Razorpay webhook references a Razorpay order id that does not exist in the Purchase records of the Backend_API, THEN THE Purchase_Service SHALL respond with HTTP 200, SHALL NOT create a new Purchase record, and SHALL record the event as an unmatched webhook for later reconciliation.
11. THE Backend_API SHALL store only the Razorpay order id and Razorpay payment id as references; full payment instrument data including card numbers, UPI handles, expiration dates, and CVV SHALL remain in Razorpay and SHALL NOT be persisted by the Backend_API.
12. WHEN an End_User requests `GET /me/purchases`, THE Purchase_Service SHALL return that End_User's Purchase records in reverse chronological order, including Pack slug, effective price, MRP at time of purchase, status, Razorpay order id, Razorpay payment id (when available), and timestamp.

### Requirement 11: Admin Dashboard

**User Story:** As an Admin, I want a dashboard to manage users, Packs, the Welcome Offer, Provider_Keys, and Entitlements, so that I can operate the product.

#### Acceptance Criteria

1. WHEN an Admin requests the user list, THE Admin_Dashboard SHALL return a paginated result of at most 50 users per page in reverse chronological order of account creation, accepting filters for email (case-insensitive substring up to 254 characters), role (one of `user` or `admin`), Entitlement state (one of `none`, `has_sessions`, `lifetime`), and remaining session_count range specified as a non-negative integer minimum and maximum where minimum is less than or equal to maximum.
2. WHEN an Admin opens a user record, THE Admin_Dashboard SHALL display the user's full Purchase history, the 50 most recent Interview_Sessions in reverse chronological order, the 50 most recent Entitlement_Ledger entries in reverse chronological order, and the current Entitlement (remaining session_count and lifetime_flag) refreshed within 1 second of the latest Entitlement_Ledger entry.
3. WHEN an Admin submits a session grant or revoke action with a non-zero integer session_delta between -1000 and 1000 inclusive (excluding 0) and a non-empty reason note of 1 to 500 characters, THE Admin_Dashboard SHALL apply the change to the target user's Entitlement_Ledger with reason code `admin_adjustment` and SHALL record the acting Admin's user id, the target user id, the session_delta, and the reason note in the Audit_Log.
4. IF an Admin submits a session grant or revoke action with an amount outside the allowed range, a missing or empty reason note, or a revoke amount that would cause the target user's session_count to become negative when their lifetime_flag is false, THEN THE Admin_Dashboard SHALL reject the action, display an error message indicating the specific validation failure, and SHALL NOT modify the Entitlement_Ledger.
5. WHEN an Admin submits a manual lifetime grant or revoke for a target user, THE Admin_Dashboard SHALL append an Entitlement_Ledger entry with reason code `admin_adjustment` and lifetime_flag_set value of `set_true` (for grant) or a follow-up policy entry (for revoke), and SHALL record the action in the Audit_Log with the acting Admin's user id, the target user id, and the previous and new lifetime_flag values.
6. WHEN an Admin creates, updates, or deactivates a Pack, THE Admin_Dashboard SHALL persist the change via the Purchase_Service per Requirement 5 criteria 5–10 and SHALL display a confirmation indicating the action succeeded.
7. IF an Admin attempts to deactivate a Pack that has at least one `pending` Razorpay_Order in flight, THEN THE Admin_Dashboard SHALL reject the deactivation, display an error message indicating the Pack has pending orders and the count, and SHALL NOT modify the Pack record.
8. WHEN an Admin updates the Welcome_Offer enabled flag or end timestamp, THE Admin_Dashboard SHALL persist the change via the Purchase_Service per Requirement 5 criteria 7 and 10 and SHALL display the previous and new values in the confirmation.
9. WHEN an Admin creates, rotates, or revokes a Provider_Key from the Admin_Dashboard, THE Admin_Dashboard SHALL invoke the Backend_API per Requirement 4 and SHALL display only the masked key form (last 4 characters) on success.
10. WHILE the active session is unauthenticated or has a role claim other than `admin`, THE Admin_Dashboard SHALL block access to all dashboard pages and SHALL redirect the browser to the sign-in page within 1 second of the page load attempt.

### Requirement 12: Rate Limiting and Abuse Prevention

**User Story:** As an Admin, I want per-user rate limits on AI operations and session starts, so that a single account cannot drain provider quota or run up costs through automation.

#### Acceptance Criteria

1. THE Backend_API SHALL enforce a default Rate_Limit of 60 AI_Operation requests per rolling 60-second window per user and 1000 AI_Operation requests per rolling 24-hour window per user, evaluated before forwarding the request to the upstream provider.
2. THE Backend_API SHALL enforce a default Rate_Limit of 5 `POST /sessions/start` requests per rolling 60-minute window per user, evaluated before validating Entitlement.
3. IF a request from a user would cause that user's count within the applicable rolling window to exceed the Rate_Limit, THEN THE Backend_API SHALL reject the request with HTTP 429, error code `rate_limited`, and a `Retry-After` header containing an integer between 1 and 86400 seconds equal to the time remaining until the oldest counted request in the window expires, and SHALL NOT consume Entitlement or forward the request to the upstream provider.
4. THE Backend_API SHALL allow an Admin to set per-user Rate_Limit overrides for AI_Operation and session_start, where each override value is a non-negative integer no greater than 100000, where a per-user override takes precedence over the default, and where every override create or update is recorded in the Audit_Log with the acting Admin's user id, the previous value, and the new value.
5. WHEN the Backend_API observes more than 10 distinct Session_Token issuance events for the same account originating from more than 5 distinct IP addresses within a rolling 60-minute window, THE Backend_API SHALL append one Audit_Log entry with reason code `suspicious_login_velocity` containing the account's user id, the count of distinct issuance events, the count of distinct IP addresses, and the detection timestamp, and SHALL NOT append more than one such entry for the same account within any rolling 60-minute window.

### Requirement 13: Desktop Client Tamper Resistance

**User Story:** As an Admin, I want the Desktop_Client to resist trivial bypasses of session metering, so that End_Users cannot replay or forge requests to consume free Interview Sessions.

#### Acceptance Criteria

1. WHEN the Desktop_Client starts for the first time after install, THE Desktop_Client SHALL generate a per-installation client identifier that is a version 4 UUID, persist it in OS-provided secure storage where available and otherwise in a local config file with owner-only read and write permissions, and SHALL submit the identifier in a request header on every Backend_API request for the lifetime of the installation.
2. IF a Backend_API request arrives without a client identifier header or with a value that is not a valid version 4 UUID, THEN THE Backend_API SHALL reject the request with HTTP 400 and error code `missing_client_id` and SHALL NOT process the request.
3. WHEN the Desktop_Client establishes a TLS connection to the Backend_API, THE Desktop_Client SHALL pin the Backend_API leaf certificate or its issuing intermediate to a configured set of SHA-256 public key hashes shipped with the build, and IF none of the presented certificates in the chain match a configured hash, THEN THE Desktop_Client SHALL abort the connection, SHALL NOT send the request payload, and SHALL surface a connection-failure indication to the End_User.
4. THE Desktop_Client SHALL store Refresh_Tokens using the OS-provided secure storage where available (Windows Credential Manager on Windows, macOS Keychain on macOS), and WHERE the OS-provided secure storage is unavailable, THE Desktop_Client SHALL fall back to a local file readable and writable only by the current OS user (POSIX mode 0600 on Unix-like systems, equivalent owner-only ACL on Windows) and SHALL NOT write Refresh_Tokens to any world-readable or group-readable location.
5. IF the Backend_API receives a request bearing a Session_Token whose claimed client identifier differs from the client identifier recorded at the time the Session_Token was issued, THEN THE Backend_API SHALL reject the request with HTTP 401 and error code `client_id_mismatch`, SHALL invalidate both the Session_Token and the associated Refresh_Token, SHALL require the End_User to sign in again, and SHALL record an Audit_Log entry with reason code `client_id_mismatch` containing the user id, the issuing client identifier, and the presenting client identifier.
6. THE Desktop_Client SHALL include a build version header containing the semantic version of the installed build on every Backend_API request, and IF a request arrives without a build version header or with a build version older than the Backend_API's configured minimum supported version, THEN THE Backend_API SHALL reject the request with HTTP 426 and error code `client_upgrade_required` and SHALL NOT consume any Entitlement for the rejected request.

### Requirement 14: Observability

**User Story:** As an Admin, I want consolidated logs and metrics for authentication, purchases, sessions, and AI usage, so that I can detect failures and abuse.

#### Acceptance Criteria

1. WHEN an AI_Operation reaches a terminal state of `success` or `failed`, THE Backend_API SHALL emit a structured log record containing user id, Interview_Session id, operation type, model id, terminal status, latency in milliseconds as a non-negative integer in the range 0 to 600000, upstream provider HTTP status code, and Idempotency_Key, and SHALL NOT include any plaintext Provider_Key or End_User password in the record.
2. WHEN an AI_Operation reaches a terminal state, THE Backend_API SHALL increment a metric counter for AI_Operation count partitioned by operation type, model id, and AI_Operation status from the set {`success`, `failed`}, with the increment observable in metric reads within 60 seconds of the terminal state.
3. WHEN an Interview_Session is created, ended, or expires, THE Backend_API SHALL emit a structured log record and increment a metric counter partitioned by terminal reason from the set {`ended_by_user`, `expired`, `signed_out`}.
4. WHEN one of the events sign-in success, sign-in failure, role change, Pack change, Welcome_Offer change, Provider_Key create, Provider_Key rotate, Provider_Key delete, manual entitlement adjustment, Razorpay payment captured, or Razorpay signature failure occurs, THE Audit_Log SHALL record an entry containing actor user id (or `anonymous` for unauthenticated sign-in failures and webhook events), target user id or target resource id, event type, outcome from the set {`success`, `failure`}, and a timestamp in UTC with millisecond precision.
5. THE Backend_API SHALL retain every Audit_Log entry for at least 24 months from the entry's timestamp and SHALL reject any API request that attempts to delete or modify an existing Audit_Log entry with an error response indicating the operation is not permitted.

### Requirement 15: Cost-Aware Hosting Constraint

**User Story:** As the product owner, I want the Backend_API to run within free or near-free hosting tiers at low user counts, so that I can ship without infrastructure cost.

#### Acceptance Criteria

1. THE Backend_API SHALL be deployable on a single managed Postgres instance at the free tier of a hosting provider (for example Supabase free tier) and a single serverless function platform free tier (for example Cloudflare Workers or Vercel Hobby), using no more than 1 database instance and 1 serverless function deployment, with no paid add-ons enabled by default.
2. THE Backend_API SHALL keep total persistent Postgres storage under 500 megabytes for the first 1000 registered users by storing only metadata records (each row no larger than 64 kilobytes) in Postgres and offloading any blob larger than 1 megabyte (such as transcribed audio files) to object storage with a configurable retention period between 1 and 7 days inclusive, defaulting to 7 days.
3. IF total persistent Postgres storage usage exceeds 450 megabytes, THEN THE Backend_API SHALL reject new blob persistence requests with an error response indicating storage quota exceeded, while preserving all existing stored data without modification.
4. THE Backend_API SHALL operate without any always-on background worker process, and all periodic tasks (Interview_Session expiry sweeps, unmatched-webhook reconciliation) SHALL execute only via scheduled invocations triggered no more frequently than once per 60 minutes.
5. IF a scheduled periodic task invocation fails, THEN THE Backend_API SHALL retain the unprocessed task state for retry on the next scheduled invocation and return an error response to the scheduler indicating task failure, without partial commits to persistent storage.
6. THE Backend_API SHALL expose a configuration switch, readable at startup, that redirects AI_Proxy traffic, persistent storage, and scheduler endpoints from free-tier providers to paid-tier equivalents without requiring source code changes or redeployment of new binaries, and the switch SHALL accept one of two discrete values: `free` or `paid`.

### Requirement 16: Backward Compatibility of Existing Modes

**User Story:** As an existing End_User, I want Manual, Passive, and Screen Analyzer modes to continue working after the upgrade, so that my workflow is preserved.

#### Acceptance Criteria

1. WHILE the End_User has no active Interview_Session, THE Desktop_Client SHALL display a "Start Interview Session" call-to-action in place of the Manual, Passive, and Screen Analyzer mode entry points, and SHALL NOT permit AI_Operation requests until a session is started per Requirement 8.
2. WHEN an authenticated End_User submits a prompt in Manual mode within an active Interview_Session, THE Desktop_Client SHALL send the prompt and the prior conversation history to the AI_Proxy text endpoint and SHALL render the streamed response in the existing answer pane within 2 seconds of receiving the first response chunk.
3. WHEN an authenticated End_User uses Passive mode within an active Interview_Session, THE Desktop_Client SHALL send each captured audio segment of up to 60 seconds in length to the AI_Proxy transcription endpoint and SHALL forward the returned transcript to the AI_Proxy text endpoint.
4. WHEN an authenticated End_User uses Screen Analyzer mode within an active Interview_Session, THE Desktop_Client SHALL send the captured screenshots to the AI_Proxy vision endpoint together with the existing system prompt and SHALL render the streamed answer in the existing answer pane.
5. THE Desktop_Client SHALL preserve the existing resume context and job context fields across application restarts and SHALL include both fields verbatim in the system prompt sent to the AI_Proxy on every AI_Operation request within an active Interview_Session.
6. IF an AI_Operation fails because no Interview_Session is active or because the active Interview_Session has expired, THEN THE Desktop_Client SHALL abort the operation without modifying the existing conversation history, SHALL display a message indicating the session has ended, and SHALL display an actionable control that starts a new Interview_Session (when entitlement allows) or navigates to the Pack purchase flow (when entitlement is exhausted).
7. IF an AI_Operation fails for a reason other than session state, including network failure, AI_Proxy unavailability, or transcription failure, THEN THE Desktop_Client SHALL preserve the existing conversation history unchanged and SHALL display an error message identifying the failed mode and the failure category.
8. IF the AI_Proxy does not return the first response chunk within 30 seconds of an AI_Operation request, THEN THE Desktop_Client SHALL cancel the request, SHALL preserve the existing conversation history unchanged, and SHALL display a timeout error message identifying the affected mode.

## Correctness Properties

The following properties summarize invariants and round-trip behaviors that must hold across the system. They are written here at the requirements level to guide design and testing.

1. **Entitlement Conservation Invariant**: At all times and for every user, remaining session_count equals the sum of session_delta across all Entitlement_Ledger entries for that user, clamped at zero; and lifetime_flag equals true if and only if at least one Entitlement_Ledger entry for that user has lifetime_flag_set equal to `set_true`.
2. **Single Active Session Invariant**: For every End_User, the count of Interview_Sessions with status `active` is at most 1 at any point in time.
3. **Session Start Atomicity**: A successful `POST /sessions/start` either decrements session_count by exactly 1 (when lifetime_flag is false) and creates exactly one `active` Interview_Session, or decrements by 0 (when lifetime_flag is true) and creates exactly one `active` Interview_Session; partial outcomes are not observable.
4. **Welcome Offer Eligibility**: The Welcome Offer effective price is granted to a given End_User on at most one successfully captured Razorpay_Payment.
5. **Idempotency**: For any two AI_Proxy requests submitted by the same user with the same Idempotency_Key within 24 hours, the upstream provider is invoked at most once and the response returned to the second caller equals the response of the first.
6. **Role Monotonic Disclosure**: For every endpoint, the response to an unauthenticated or non-admin caller does not reveal information that would not be visible if the targeted resource did not exist.
7. **Provider Key Confidentiality**: For every API response and log line emitted by the Backend_API, no substring matches the plaintext of any stored Provider_Key.
8. **Razorpay Webhook Replay Safety**: For any Razorpay webhook event id processed more than once, the resulting Purchase and Entitlement_Ledger state is identical to the state after the first processing.
9. **Audit Append-Only**: For every Audit_Log entry written, the entry remains retrievable for at least 24 months and is not modifiable through any Backend_API endpoint.
