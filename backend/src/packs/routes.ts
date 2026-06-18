import { Hono } from 'hono';
import type { Pool } from 'pg';
import { JwtError, verifyAccess } from '../auth/jwt.js';
import {
  effectivePrice,
  type EffectivePricePack,
  type EffectivePriceWelcomeOffer,
} from './effective-price.js';

/**
 * Pack_Catalog HTTP routes.
 *
 * Currently exposes the end-user `GET /packs` endpoint per Requirement 5.4.
 * Admin pack management (`/admin/packs`) is mounted by a separate router in
 * a later task and shares only the pure pricing helper from this module.
 *
 * The full middleware chain (`src/http/middleware.ts`) is being implemented
 * in task 3.5; until that lands this router does its own minimal bearer-
 * token check so the route is usable end-to-end. The check is deliberately
 * narrow (Authorization header → `verifyAccess`); once the middleware is
 * mounted globally the inline check will be removed in favour of reading
 * the verified claims from the request context.
 */

/** Order in which packs are returned (Requirement 5.11). */
export const PACK_ORDER = ['starter', 'pro', 'lifetime'] as const;
type PackSlug = (typeof PACK_ORDER)[number];

export interface PacksRouterDeps {
  /**
   * Postgres pool used for the read-only catalog queries. The router uses
   * a single checked-out client so the three reads see a consistent view
   * of `packs`, `welcome_offer`, and `purchases`.
   */
  readonly pool: Pool;
  /** Clock injection for tests; defaults to wall-clock UTC. */
  readonly now?: () => Date;
}

interface PackRow {
  slug: string;
  display_name: string;
  description: string;
  mrp_paise: string | number;
  welcome_price_paise: string | number;
  session_count: number | null;
  is_lifetime: boolean;
}

interface WelcomeOfferRow {
  enabled: boolean;
  ends_at: Date | string;
}

interface CompletedCountRow {
  count: string | number;
}

/** Wire-format pack returned by `GET /packs`. */
export interface PackResponse {
  slug: string;
  display_name: string;
  description: string;
  mrp_paise: number;
  welcome_price_paise: number;
  effective_price_paise: number;
  session_count: number | null;
  is_lifetime: boolean;
  welcome_offer_applied: boolean;
}

/**
 * Build a Hono sub-app exposing pack catalog routes. The returned router
 * is intended to be mounted at the root of the main app.
 */
export function buildPacksRouter(deps: PacksRouterDeps): Hono {
  const router = new Hono();
  const clock = deps.now ?? ((): Date => new Date());

  router.get('/packs', async (c) => {
    const claims = await authenticate(c.req.header('Authorization'));
    if ('errorBody' in claims) {
      return c.json(claims.errorBody, claims.status);
    }

    const client = await deps.pool.connect();
    try {
      const packsResult = await client.query<PackRow>(
        `SELECT slug,
                display_name,
                description,
                mrp_paise,
                welcome_price_paise,
                session_count,
                is_lifetime
           FROM packs
          WHERE active = true`,
      );

      const offerResult = await client.query<WelcomeOfferRow>(
        `SELECT enabled, ends_at FROM welcome_offer WHERE id = 1`,
      );

      const completedResult = await client.query<CompletedCountRow>(
        `SELECT COUNT(*) AS count
           FROM purchases
          WHERE user_id = $1
            AND status = 'completed'`,
        [claims.sub],
      );

      const welcomeOfferRow = offerResult.rows[0];
      const welcomeOffer: EffectivePriceWelcomeOffer = welcomeOfferRow
        ? {
            enabled: welcomeOfferRow.enabled,
            ends_at: toDate(welcomeOfferRow.ends_at),
          }
        : { enabled: false, ends_at: new Date(0) };

      const completedRow = completedResult.rows[0];
      const completedPurchasesCount = completedRow
        ? Number(completedRow.count)
        : 0;
      const user = { completedPurchasesCount };

      const now = clock();

      const ordered = [...packsResult.rows].sort(
        (a, b) => packOrderIndex(a.slug) - packOrderIndex(b.slug),
      );

      const packs: PackResponse[] = ordered.map((row) => {
        const mrp = Number(row.mrp_paise);
        const welcome = Number(row.welcome_price_paise);
        const pack: EffectivePricePack = {
          mrp_paise: mrp,
          welcome_price_paise: welcome,
        };
        const eff = effectivePrice(user, pack, welcomeOffer, now);
        return {
          slug: row.slug,
          display_name: row.display_name,
          description: row.description,
          mrp_paise: mrp,
          welcome_price_paise: welcome,
          effective_price_paise: eff,
          session_count: row.session_count,
          is_lifetime: row.is_lifetime,
          welcome_offer_applied: eff < mrp,
        };
      });

      return c.json({ packs });
    } finally {
      client.release();
    }
  });

  return router;
}

interface AuthSuccess {
  sub: string;
  role: 'user' | 'admin';
  client_id: string;
}

interface AuthFailure {
  status: 401;
  errorBody: { error: { code: string; message: string } };
}

async function authenticate(
  authorization: string | undefined,
): Promise<AuthSuccess | AuthFailure> {
  if (!authorization) {
    return {
      status: 401,
      errorBody: {
        error: { code: 'unauthenticated', message: 'missing Authorization header' },
      },
    };
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) {
    return {
      status: 401,
      errorBody: {
        error: { code: 'unauthenticated', message: 'malformed Authorization header' },
      },
    };
  }
  try {
    const claims = await verifyAccess(match[1]!);
    return { sub: claims.sub, role: claims.role, client_id: claims.client_id };
  } catch (err) {
    const code = err instanceof JwtError ? err.code : 'unauthenticated';
    const message = err instanceof Error ? err.message : 'invalid token';
    return { status: 401, errorBody: { error: { code, message } } };
  }
}

function packOrderIndex(slug: string): number {
  const idx = (PACK_ORDER as readonly string[]).indexOf(slug);
  return idx === -1 ? PACK_ORDER.length : idx;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
