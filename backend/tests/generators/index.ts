/**
 * Shared `fast-check` generators (custom `Arbitrary`s) for property tests.
 *
 * This module is intentionally empty in this task and will grow per task
 * as new domains come online. Per the design's testing strategy:
 *
 *   "Generators (custom `Arbitrary`s) are factored into `tests/generators/`
 *    and explicitly seed edge cases (empty strings, max-length strings,
 *    boundary timestamps near windows, lifetime-flag-true users,
 *    concurrent operation interleavings via `fc.scheduler`)."
 *
 * Adding a generator:
 *   1. Create a new file under `tests/generators/` (e.g. `users.ts`).
 *   2. Export the `Arbitrary` from this barrel.
 *   3. Reference it from the property test that drives the relevant
 *      design property.
 *
 * Validates: Requirements 15.1.
 */

export {};
