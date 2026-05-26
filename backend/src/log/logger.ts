/**
 * Structured JSON logger for the Backend API.
 *
 * Emits one line of JSON per record on the configured sink (stdout by
 * default). All log records carry a `level`, a `message`, an ISO 8601
 * UTC timestamp with millisecond precision, and any caller-supplied
 * fields. Records are deeply scrubbed for known secret keys before
 * serialization so plaintext provider keys, passwords, and refresh
 * tokens cannot reach observability backends.
 *
 * Design references:
 *   - Requirement 4.7  (no plaintext Provider_Key in application logs)
 *   - Requirement 14.1 (structured AI_Operation log records, no
 *     plaintext Provider_Key or End_User password)
 *   - Property 10 / Property 26 (Provider Key Confidentiality across
 *     every log line)
 *
 * The redaction set is defined as known *key names* rather than value
 * pattern matching: pattern matching produces too many false positives
 * and false negatives, while structured logging always passes secrets
 * through a known-name field. Callers MUST place secrets behind a
 * recognized key (for example `provider_key`, `password`,
 * `refresh_token`) rather than interpolating them into a `message`
 * string. Higher-level helpers in `src/auth/*` and `src/ai/*` enforce
 * this convention.
 */

/* eslint-disable no-console */

/**
 * Severity of a log record. Mirrors the standard syslog-ish ladder used
 * by most observability backends. Values are ordered so callers can
 * cheaply implement minimum-level filtering.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Shape of an emitted record. The exact JSON written to the sink is the
 * `JSON.stringify` of an object of this shape (after redaction), with
 * one trailing newline.
 */
export interface LogRecord {
  level: LogLevel;
  message: string;
  /** ISO 8601 UTC with millisecond precision, e.g. `2024-01-02T03:04:05.678Z`. */
  timestamp: string;
  /** Caller-supplied structured fields, redacted in place. */
  [key: string]: unknown;
}

/**
 * A logger sink consumes a finished record. The default sink writes
 * `JSON.stringify(record) + "\n"` to `process.stdout`. Tests can pass
 * an array-backed sink to capture and assert on records directly.
 */
export interface LoggerSink {
  write(record: LogRecord): void;
}

/**
 * Options for constructing a logger. The sink defaults to stdout. The
 * minimum level defaults to `info`; production deployments can lower
 * this to `debug` via `LOG_LEVEL` without code changes (the loader
 * lives in higher-level wiring, not here).
 */
export interface LoggerOptions {
  readonly sink?: LoggerSink;
  readonly minLevel?: LogLevel;
  readonly bindings?: Readonly<Record<string, unknown>>;
  /**
   * Additional key names whose values should be replaced with the
   * redaction sentinel before serialization. The defaults
   * (`provider_key`, `password`, `refresh_token`, plus camelCase /
   * variant forms) are always included; callers can extend the list
   * but cannot disable a default entry.
   */
  readonly extraRedactKeys?: readonly string[];
  /** Clock injection point for tests. Defaults to `Date.now`. */
  readonly clock?: () => Date;
}

/**
 * Sentinel value substituted for any redacted field. Distinct enough to
 * be obvious in dashboards yet stable enough to assert on in tests.
 */
export const REDACTED = '[REDACTED]';

/**
 * Default key names that always have their values redacted, regardless
 * of caller configuration. Names are matched case-insensitively so
 * `Authorization`, `authorization`, and `AUTHORIZATION` all redact.
 *
 * Spec drives this list directly:
 *   - `provider_key` (Requirements 4.6, 4.7, 7.9, 11.9, 14.1)
 *   - `password` (Requirement 1.8)
 *   - `refresh_token` (Requirement 13.4)
 *
 * Camel-case and adjacent forms (`api_key`, `apiKey`, `authorization`,
 * `cookie`) are included as a defense-in-depth measure: structured
 * fields that look like secrets are very likely secrets.
 */
const DEFAULT_REDACTED_KEYS: readonly string[] = [
  'provider_key',
  'providerKey',
  'password',
  'password_hash',
  'passwordHash',
  'refresh_token',
  'refreshToken',
  'access_token',
  'accessToken',
  'api_key',
  'apiKey',
  'authorization',
  'cookie',
  'set-cookie',
  'set_cookie',
  'setCookie',
  'razorpay_key_secret',
  'razorpayKeySecret',
  'razorpay_webhook_secret',
  'razorpayWebhookSecret',
];

function buildRedactSet(extra: readonly string[] = []): ReadonlySet<string> {
  const set = new Set<string>();
  for (const k of DEFAULT_REDACTED_KEYS) set.add(k.toLowerCase());
  for (const k of extra) set.add(k.toLowerCase());
  return set;
}

/**
 * Default sink: write one JSON line to stdout per record. Errors during
 * serialization are caught and reported via `console.error` to avoid
 * crashing request handlers when an unexpected non-serializable value
 * sneaks into the bindings.
 */
function defaultSink(): LoggerSink {
  return {
    write(record: LogRecord): void {
      try {
        process.stdout.write(`${JSON.stringify(record)}\n`);
      } catch (err) {
        console.error('logger.serialize_failed', err);
      }
    },
  };
}

/**
 * Recursively walk an arbitrary value and replace the contents of any
 * field whose key (case-insensitive) appears in `keys` with `REDACTED`.
 * Cycles are tolerated: a `WeakSet` of visited objects ensures the walk
 * terminates even on self-referential structures.
 *
 * Strings, numbers, booleans, `null`, and `undefined` are returned as
 * is. Dates and other primitive-like objects are passed through (their
 * keys are not inspected). Buffers and typed arrays are passed through
 * untouched; callers should not place them in log fields.
 */
export function redact(input: unknown, keys: ReadonlySet<string>): unknown {
  const seen = new WeakSet<object>();

  const walk = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    if (value instanceof Date) return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item) => walk(item));
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keys.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  };

  return walk(input);
}

/**
 * Structured JSON logger.
 *
 * A logger is cheap to construct and cheaper to clone via {@link Logger.child}.
 * Each request handler should derive a child with request-scoped bindings
 * (`request_id`, `user_id`, etc.) so the bindings flow into every record
 * without per-call repetition.
 */
export class Logger {
  readonly #sink: LoggerSink;
  readonly #minLevel: LogLevel;
  readonly #bindings: Readonly<Record<string, unknown>>;
  readonly #redactKeys: ReadonlySet<string>;
  readonly #clock: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.#sink = options.sink ?? defaultSink();
    this.#minLevel = options.minLevel ?? 'info';
    this.#bindings = options.bindings ?? {};
    this.#redactKeys = buildRedactSet(options.extraRedactKeys);
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * Return a logger that emits with `bindings` merged into every record.
   * Bindings on the parent take precedence over ones on the child only
   * if the child does not provide the same key; otherwise the child's
   * value wins. Redaction set, sink, level, and clock are inherited.
   */
  child(bindings: Readonly<Record<string, unknown>>): Logger {
    return new Logger({
      sink: this.#sink,
      minLevel: this.#minLevel,
      bindings: { ...this.#bindings, ...bindings },
      extraRedactKeys: Array.from(this.#redactKeys),
      clock: this.#clock,
    });
  }

  debug(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#emit('debug', message, fields);
  }

  info(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#emit('info', message, fields);
  }

  warn(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#emit('warn', message, fields);
  }

  error(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#emit('error', message, fields);
  }

  #emit(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#minLevel]) return;

    const merged: Record<string, unknown> = {
      ...this.#bindings,
      ...(fields ?? {}),
    };

    const redacted = redact(merged, this.#redactKeys) as Record<string, unknown>;

    const record: LogRecord = {
      level,
      message,
      timestamp: this.#clock().toISOString(),
      ...redacted,
    };

    this.#sink.write(record);
  }
}

/**
 * Convenience: build an array-backed sink for tests.
 *
 * Returns the sink and a shared array reference; callers push records
 * by writing to the logger and then assert against the array.
 */
export function createMemorySink(): { sink: LoggerSink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    sink: {
      write(record: LogRecord): void {
        records.push(record);
      },
    },
  };
}
