# Backend

TypeScript backend for the credits and subscription system. Runs on a single
serverless function platform fronting a single managed Postgres instance, per
Requirement 15.

## Layout

- `src/app.ts` builds and returns the Hono app instance (no listen). This is
  what tests mount with `supertest`.
- `src/server.ts` is a thin Node platform entry that binds `app.fetch` to a
  socket. Workers / Vercel adapters can be added alongside it.
- `tests/unit`, `tests/integration`, `tests/e2e` map to the matching scripts
  in `package.json`.

## Scripts

- `npm run test:unit` — fast in-process tests (vitest + fast-check).
- `npm run test:integration` — tests that touch real Postgres
  (testcontainers) and external services via `nock`.
- `npm run test:e2e` — full HTTP surface tests via `supertest` against the
  built Hono app.

## Environment

Copy `.env.example` to `.env` and fill in the values. `MODE` must be exactly
`free` or `paid`; any other value fails fast at startup (Requirement 15.6).
