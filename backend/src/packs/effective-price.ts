/**
 * Pack pricing pure function.
 *
 * `effectivePrice` decides, for a single (user, pack, welcome offer, clock)
 * tuple, whether the per-user effective price is the Pack's MRP or the
 * Welcome Offer price. The function is intentionally pure: it performs no
 * I/O and reads no globals so it can be tested directly with property
 * tests (Property 8) and reused from the `GET /packs` route, the
 * `POST /purchases/checkout` price computation, and any future preview
 * surfaces.
 *
 * The eligibility rules (Requirement 5.4):
 *   1. The Welcome_Offer record must be `enabled = true`.
 *   2. The current UTC time must be strictly before `welcome_offer.ends_at`.
 *   3. The End_User must have zero successfully captured Razorpay_Payments
 *      in their purchase history (i.e. zero `purchases` rows with
 *      `status = 'completed'`).
 *
 * If any condition is false, the effective price equals the Pack's MRP.
 *
 * Validates: Requirements 5.4, 5.11.
 */

/** Per-user inputs needed to decide Welcome Offer eligibility. */
export interface EffectivePriceUser {
  /**
   * Count of `purchases` rows for the user with `status = 'completed'`.
   * Must be a non-negative integer; values are clamped at the call site
   * before reaching this function.
   */
  readonly completedPurchasesCount: number;
}

/** Per-Pack pricing inputs. Both prices are INR paise. */
export interface EffectivePricePack {
  /** Maximum retail price in INR paise. Positive integer. */
  readonly mrp_paise: number;
  /**
   * Welcome Offer price in INR paise. Non-negative integer that is
   * strictly less than `mrp_paise` per the schema CHECK constraint.
   */
  readonly welcome_price_paise: number;
}

/** Welcome_Offer singleton inputs needed for eligibility. */
export interface EffectivePriceWelcomeOffer {
  readonly enabled: boolean;
  /** UTC end timestamp; offer is active while `now < ends_at`. */
  readonly ends_at: Date;
}

/**
 * Compute the effective price (in INR paise) for a single Pack/user pair.
 *
 * Pure: no I/O, no globals, no time reads. The caller supplies `now` so
 * tests can drive the clock and so the same function can be reused from
 * the `GET /packs` request handler and the `POST /purchases/checkout`
 * checkout pricing path with a single shared clock value.
 *
 * @param user The End_User's purchase-history summary.
 * @param pack The Pack whose effective price is being computed.
 * @param welcomeOffer The Welcome_Offer singleton state.
 * @param now The current UTC time used to evaluate `ends_at`.
 * @returns The effective price in INR paise.
 */
export function effectivePrice(
  user: EffectivePriceUser,
  pack: EffectivePricePack,
  welcomeOffer: EffectivePriceWelcomeOffer,
  now: Date,
): number {
  const offerActive =
    welcomeOffer.enabled && now.getTime() < welcomeOffer.ends_at.getTime();
  const eligible = offerActive && user.completedPurchasesCount === 0;
  return eligible ? pack.welcome_price_paise : pack.mrp_paise;
}
