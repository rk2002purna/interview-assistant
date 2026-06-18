/**
 * Hosting mode configuration loader.
 *
 * Implements the design's decision that the hosting mode switch
 * `MODE = free | paid` is read at startup and selects the Postgres connection
 * string up front, so no code path has to branch at request time. The two
 * accepted values mirror Requirement 15.6 exactly:
 *
 *   "the switch SHALL accept one of two discrete values: `free` or `paid`"
 *
 * Any other value (including missing or empty) MUST cause startup to fail
 * before traffic is served. The loader throws a descriptive `Error`
 * describing the misconfiguration and identifying the offending env var; the
 * platform entry (`src/server.ts`) propagates the throw, which exits the
 * Node process with a non-zero status before `serve()` opens a port.
 *
 * The loader is deliberately side-effect-free apart from a small in-process
 * cache, so it can be exercised in tests by mutating `process.env` and
 * calling {@link resetModeConfigForTesting}.
 *
 * Requirements: 15.6.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The two discrete hosting modes accepted by the backend.
 *
 * Kept as a string literal union (not a TS enum) so the runtime values match
 * exactly what is written in the environment and in `.env.example`, with no
 * extra reverse-mapping object emitted by the compiler.
 */
export type HostingMode = 'free' | 'paid';

/**
 * The set of hosting modes, exposed for runtime validation and tests.
 */
export const HOSTING_MODES: readonly HostingMode[] = ['free', 'paid'] as const;

/**
 * Resolved hosting-mode configuration returned by {@link loadModeConfig}.
 *
 * `databaseUrl` is the connection string already selected for the active
 * `mode`, so callers do not have to repeat the branching logic. The original
 * `databaseUrlFree` / `databaseUrlPaid` values are intentionally not exposed
 * to keep the design's "selects connection strings; no code path branches at
 * request time" invariant local to this module.
 */
export interface ModeConfig {
  /** Active hosting mode, exactly one of `'free'` or `'paid'`. */
  readonly mode: HostingMode;
  /** Postgres connection string corresponding to {@link mode}. */
  readonly databaseUrl: string;
}

// ---------------------------------------------------------------------------
// Environment variable names
// ---------------------------------------------------------------------------

const ENV_MODE = 'MODE';
const ENV_DATABASE_URL_FREE = 'DATABASE_URL_FREE';
const ENV_DATABASE_URL_PAID = 'DATABASE_URL_PAID';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Cached resolved config. Populated lazily on first call so tests can set
 * env vars after import, and reset between tests via
 * {@link resetModeConfigForTesting}.
 */
let cachedConfig: ModeConfig | null = null;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Read and validate the hosting mode configuration from `process.env`.
 *
 * Throws a descriptive {@link Error} (synchronously, on first call) if any
 * of the following hold:
 *   - `MODE` is unset or empty.
 *   - `MODE` is set to anything other than `"free"` or `"paid"` (case
 *     sensitive, no surrounding whitespace tolerated).
 *   - The `DATABASE_URL_*` environment variable matching the active mode is
 *     unset or empty.
 *
 * The check intentionally does *not* require the unused mode's connection
 * string to be present, so a deployment in `MODE=free` does not need a
 * paid-tier Postgres URL on hand and vice versa.
 *
 * @returns The cached, frozen {@link ModeConfig} for the lifetime of the
 *   process (or until {@link resetModeConfigForTesting} is called).
 */
export function loadModeConfig(): ModeConfig {
  if (cachedConfig !== null) {
    return cachedConfig;
  }

  const rawMode = process.env[ENV_MODE];

  if (rawMode === undefined || rawMode === '') {
    throw new Error(
      `${ENV_MODE} is not set. Provide one of: ${HOSTING_MODES.join(', ')}.`,
    );
  }

  if (!isHostingMode(rawMode)) {
    throw new Error(
      `${ENV_MODE} must be exactly one of ${HOSTING_MODES.map((m) => `"${m}"`).join(
        ' or ',
      )} (got ${JSON.stringify(rawMode)}).`,
    );
  }

  const mode: HostingMode = rawMode;
  const databaseUrlVar =
    mode === 'free' ? ENV_DATABASE_URL_FREE : ENV_DATABASE_URL_PAID;
  const databaseUrl = process.env[databaseUrlVar];

  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error(
      `${databaseUrlVar} is not set. ${ENV_MODE}=${mode} requires a ` +
        'Postgres connection string for the selected hosting mode.',
    );
  }

  cachedConfig = Object.freeze({ mode, databaseUrl });
  return cachedConfig;
}

/**
 * Type guard that narrows an unknown string to {@link HostingMode}.
 *
 * Exported because callers occasionally need to validate values that did not
 * come from `process.env` (e.g. admin tooling, tests, or future task 13.2's
 * property test which generates arbitrary strings).
 */
export function isHostingMode(value: string): value is HostingMode {
  // Narrow via membership in HOSTING_MODES to avoid hard-coding the list twice.
  return (HOSTING_MODES as readonly string[]).includes(value);
}

/**
 * Test-only helper. Clears the in-process cache so a subsequent
 * {@link loadModeConfig} call re-reads `process.env`.
 *
 * Production code must not call this. It is exported to support unit tests
 * that mutate environment variables between cases.
 */
export function resetModeConfigForTesting(): void {
  cachedConfig = null;
}
