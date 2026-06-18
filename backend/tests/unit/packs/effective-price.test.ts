import { describe, expect, it } from 'vitest';
import { effectivePrice } from '../../../src/packs/effective-price.js';

/**
 * Unit tests for the pure pricing function.
 *
 * Validates: Requirements 5.4, 5.11.
 *
 * Property-test coverage of the same rule (Property 8) lives alongside
 * this file in task 5.2; the cases below are focused boundary examples
 * that directly mirror the eligibility decision table.
 */

const STARTER = { mrp_paise: 99900, welcome_price_paise: 49900 } as const;
const PRO = { mrp_paise: 249900, welcome_price_paise: 99900 } as const;

const before = new Date('2025-01-01T00:00:00Z');
const after = new Date('2025-12-31T00:00:00Z');
const endsAt = new Date('2025-06-01T00:00:00Z');

describe('effectivePrice', () => {
  it('returns welcome price when offer is enabled, in-window, and user has zero completed purchases', () => {
    const price = effectivePrice(
      { completedPurchasesCount: 0 },
      STARTER,
      { enabled: true, ends_at: endsAt },
      before,
    );
    expect(price).toBe(STARTER.welcome_price_paise);
  });

  it('returns MRP when the welcome offer is disabled', () => {
    const price = effectivePrice(
      { completedPurchasesCount: 0 },
      STARTER,
      { enabled: false, ends_at: endsAt },
      before,
    );
    expect(price).toBe(STARTER.mrp_paise);
  });

  it('returns MRP after the welcome offer ends_at', () => {
    const price = effectivePrice(
      { completedPurchasesCount: 0 },
      PRO,
      { enabled: true, ends_at: endsAt },
      after,
    );
    expect(price).toBe(PRO.mrp_paise);
  });

  it('returns MRP when the user already has a completed purchase', () => {
    const price = effectivePrice(
      { completedPurchasesCount: 1 },
      PRO,
      { enabled: true, ends_at: endsAt },
      before,
    );
    expect(price).toBe(PRO.mrp_paise);
  });

  it('treats now == ends_at as out-of-window (strict less-than)', () => {
    const price = effectivePrice(
      { completedPurchasesCount: 0 },
      STARTER,
      { enabled: true, ends_at: endsAt },
      endsAt,
    );
    expect(price).toBe(STARTER.mrp_paise);
  });

  it('is pure: identical inputs produce identical outputs and reading does not mutate them', () => {
    const user = { completedPurchasesCount: 0 };
    const pack = { ...STARTER };
    const offer = { enabled: true, ends_at: new Date(endsAt.getTime()) };
    const now = new Date(before.getTime());

    const a = effectivePrice(user, pack, offer, now);
    const b = effectivePrice(user, pack, offer, now);

    expect(a).toBe(b);
    expect(user).toEqual({ completedPurchasesCount: 0 });
    expect(pack).toEqual(STARTER);
    expect(offer.enabled).toBe(true);
    expect(offer.ends_at.getTime()).toBe(endsAt.getTime());
  });
});
