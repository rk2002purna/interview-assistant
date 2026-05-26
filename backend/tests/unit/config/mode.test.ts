/**
 * Unit tests for the hosting-mode configuration loader.
 *
 * Exercises the public surface (`loadModeConfig`, `isHostingMode`) and the
 * startup-failure semantics required by Requirement 15.6:
 *   - The switch SHALL accept one of two discrete values: `free` or `paid`.
 *   - Any other value (including missing/empty) MUST cause startup to fail
 *     before traffic is served.
 *
 * Property-based coverage of the same behaviour lives in a sibling task
 * (13.2) and is intentionally out of scope here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HOSTING_MODES,
  isHostingMode,
  loadModeConfig,
  resetModeConfigForTesting,
} from '../../../src/config/mode.js';

const ENV_KEYS = ['MODE', 'DATABASE_URL_FREE', 'DATABASE_URL_PAID'] as const;
const FREE_URL = 'postgres://user:password@free-host:5432/ia_free';
const PAID_URL = 'postgres://user:password@paid-host:5432/ia_paid';

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snap[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe('config/mode', () => {
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    original = snapshotEnv();
    clearEnv();
    resetModeConfigForTesting();
  });

  afterEach(() => {
    restoreEnv(original);
    resetModeConfigForTesting();
  });

  describe('loadModeConfig', () => {
    it('returns free-tier connection string when MODE=free', () => {
      process.env['MODE'] = 'free';
      process.env['DATABASE_URL_FREE'] = FREE_URL;
      process.env['DATABASE_URL_PAID'] = PAID_URL;

      const cfg = loadModeConfig();

      expect(cfg.mode).toBe('free');
      expect(cfg.databaseUrl).toBe(FREE_URL);
    });

    it('returns paid-tier connection string when MODE=paid', () => {
      process.env['MODE'] = 'paid';
      process.env['DATABASE_URL_FREE'] = FREE_URL;
      process.env['DATABASE_URL_PAID'] = PAID_URL;

      const cfg = loadModeConfig();

      expect(cfg.mode).toBe('paid');
      expect(cfg.databaseUrl).toBe(PAID_URL);
    });

    it('does not require the unused mode connection string', () => {
      process.env['MODE'] = 'free';
      process.env['DATABASE_URL_FREE'] = FREE_URL;
      // DATABASE_URL_PAID intentionally absent.

      expect(() => loadModeConfig()).not.toThrow();
    });

    it('caches the result across calls', () => {
      process.env['MODE'] = 'free';
      process.env['DATABASE_URL_FREE'] = FREE_URL;

      const first = loadModeConfig();
      // Mutate env after the first read; cache should hide the change.
      process.env['MODE'] = 'paid';
      process.env['DATABASE_URL_PAID'] = PAID_URL;
      const second = loadModeConfig();

      expect(second).toBe(first);
      expect(second.mode).toBe('free');
    });

    it('returns a frozen config object', () => {
      process.env['MODE'] = 'free';
      process.env['DATABASE_URL_FREE'] = FREE_URL;

      const cfg = loadModeConfig();

      expect(Object.isFrozen(cfg)).toBe(true);
    });

    it('throws when MODE is unset', () => {
      process.env['DATABASE_URL_FREE'] = FREE_URL;

      expect(() => loadModeConfig()).toThrow(/MODE is not set/);
    });

    it('throws when MODE is empty', () => {
      process.env['MODE'] = '';
      process.env['DATABASE_URL_FREE'] = FREE_URL;

      expect(() => loadModeConfig()).toThrow(/MODE is not set/);
    });

    it.each([
      'FREE',
      'Free',
      'PAID',
      'production',
      ' free',
      'free ',
      'unknown',
      '0',
      'true',
    ])('throws when MODE=%s', (badMode) => {
      process.env['MODE'] = badMode;
      process.env['DATABASE_URL_FREE'] = FREE_URL;
      process.env['DATABASE_URL_PAID'] = PAID_URL;

      expect(() => loadModeConfig()).toThrow(/MODE must be exactly one of/);
    });

    it('throws when MODE=free but DATABASE_URL_FREE is unset', () => {
      process.env['MODE'] = 'free';
      // DATABASE_URL_FREE intentionally absent.

      expect(() => loadModeConfig()).toThrow(/DATABASE_URL_FREE is not set/);
    });

    it('throws when MODE=free but DATABASE_URL_FREE is empty', () => {
      process.env['MODE'] = 'free';
      process.env['DATABASE_URL_FREE'] = '';

      expect(() => loadModeConfig()).toThrow(/DATABASE_URL_FREE is not set/);
    });

    it('throws when MODE=paid but DATABASE_URL_PAID is unset', () => {
      process.env['MODE'] = 'paid';
      process.env['DATABASE_URL_FREE'] = FREE_URL;
      // DATABASE_URL_PAID intentionally absent.

      expect(() => loadModeConfig()).toThrow(/DATABASE_URL_PAID is not set/);
    });

    it('throws when MODE=paid but DATABASE_URL_PAID is empty', () => {
      process.env['MODE'] = 'paid';
      process.env['DATABASE_URL_PAID'] = '';

      expect(() => loadModeConfig()).toThrow(/DATABASE_URL_PAID is not set/);
    });

    it('does not leak the unused-tier connection string on the result', () => {
      process.env['MODE'] = 'free';
      process.env['DATABASE_URL_FREE'] = FREE_URL;
      process.env['DATABASE_URL_PAID'] = PAID_URL;

      const cfg = loadModeConfig();
      const values = Object.values(cfg);

      expect(values).not.toContain(PAID_URL);
    });
  });

  describe('isHostingMode', () => {
    it('accepts the two discrete values from HOSTING_MODES', () => {
      for (const mode of HOSTING_MODES) {
        expect(isHostingMode(mode)).toBe(true);
      }
    });

    it.each(['', 'FREE', 'Paid', ' free', 'paid ', 'prod', 'staging'])(
      'rejects %s',
      (value) => {
        expect(isHostingMode(value)).toBe(false);
      },
    );
  });
});
