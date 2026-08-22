/**
 * Server-side AI model routing.
 *
 * The admin dashboard writes a `model_routing` row into `app_config`
 * (see `admin/model-routing-routes.ts`). This module is the single place
 * the AI proxy reads that config so that the backend — not the desktop
 * client — decides which provider/model handles each request. Making the
 * server authoritative means:
 *
 *   - Model changes in the admin dashboard apply to every client instantly,
 *     with no desktop app release (same pattern the STT config already uses).
 *   - A decommissioned or misconfigured client-side model can be corrected
 *     centrally.
 *   - Primary → fallback is enforced consistently for text and vision.
 *
 * Each routing entry is `{ provider, model }` where `provider` selects the
 * upstream endpoint + API key and `model` is the bare provider model id
 * (e.g. provider `groq`, model `openai/gpt-oss-120b`).
 */

import type { Pool } from 'pg';

export interface RoutingEntry {
  readonly provider: string;
  readonly model: string;
}

export interface RoutingConfig {
  readonly textPrimary: RoutingEntry;
  readonly textFallback: RoutingEntry | null;
  readonly visionPrimary: RoutingEntry;
  readonly visionFallback: RoutingEntry | null;
}

/**
 * Safe defaults used when no config row exists or a field is malformed.
 *
 * Text defaults to Groq's `openai/gpt-oss-120b` (accurate + fast) with
 * `openai/gpt-oss-20b` as the fast fallback — the models Groq now points
 * production traffic to after retiring the Llama 3.x versatile/instant
 * models. These are chosen because the Groq key is the one most likely to
 * be configured (it also powers Whisper STT).
 */
export const DEFAULT_ROUTING: RoutingConfig = {
  textPrimary: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  textFallback: { provider: 'groq', model: 'openai/gpt-oss-20b' },
  visionPrimary: { provider: 'gemini', model: 'gemini-flash-latest' },
  visionFallback: { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
};

/**
 * OpenAI-compatible chat-completions endpoints per provider. A provider not
 * present here cannot be used as a routing target (it is skipped).
 */
export const PROVIDER_ENDPOINTS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};

const APP_CONFIG_KEY = 'model_routing';

function normalizeEntry(value: unknown): RoutingEntry | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const provider = typeof o.provider === 'string' ? o.provider.toLowerCase().trim() : '';
  const model = typeof o.model === 'string' ? o.model.trim() : '';
  if (!provider || !model) return null;
  return { provider, model };
}

/**
 * Read the routing config from `app_config`. Never throws: a missing row,
 * malformed JSON, or a DB error all fall back to {@link DEFAULT_ROUTING}
 * so the proxy always has something usable.
 */
export async function readRoutingConfig(pool: Pool): Promise<RoutingConfig> {
  try {
    const result = await pool.query<{ value: string }>(
      `SELECT value FROM app_config WHERE key = $1 LIMIT 1`,
      [APP_CONFIG_KEY],
    );
    const row = result.rows[0];
    if (!row) return DEFAULT_ROUTING;
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    return {
      textPrimary: normalizeEntry(parsed.textPrimary) ?? DEFAULT_ROUTING.textPrimary,
      textFallback: normalizeEntry(parsed.textFallback),
      visionPrimary: normalizeEntry(parsed.visionPrimary) ?? DEFAULT_ROUTING.visionPrimary,
      visionFallback: normalizeEntry(parsed.visionFallback),
    };
  } catch {
    return DEFAULT_ROUTING;
  }
}

function orderedCandidates(entries: ReadonlyArray<RoutingEntry | null>): RoutingEntry[] {
  const out: RoutingEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry) continue;
    if (!(entry.provider in PROVIDER_ENDPOINTS)) continue; // unknown provider: skip
    const key = `${entry.provider}/${entry.model}`;
    if (seen.has(key)) continue; // dedupe identical primary/fallback
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * Ordered text candidates: admin primary → admin fallback → known-good
 * defaults as a terminal safety net. The defaults are appended (and deduped)
 * so that even a stale/misconfigured admin config still resolves to a working
 * Groq model instead of failing the request outright.
 */
export function textCandidates(cfg: RoutingConfig): RoutingEntry[] {
  return orderedCandidates([
    cfg.textPrimary,
    cfg.textFallback,
    DEFAULT_ROUTING.textPrimary,
    DEFAULT_ROUTING.textFallback,
  ]);
}

/**
 * Ordered vision candidates: admin primary → admin fallback → known-good
 * default as a terminal safety net.
 */
export function visionCandidates(cfg: RoutingConfig): RoutingEntry[] {
  return orderedCandidates([
    cfg.visionPrimary,
    cfg.visionFallback,
    DEFAULT_ROUTING.visionPrimary,
    DEFAULT_ROUTING.visionFallback,
  ]);
}

/** `provider/model` slug used for usage rows and log fields. */
export function routingSlug(entry: RoutingEntry): string {
  return `${entry.provider}/${entry.model}`;
}
