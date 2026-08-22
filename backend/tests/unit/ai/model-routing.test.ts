import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import {
  readRoutingConfig,
  textCandidates,
  visionCandidates,
  routingSlug,
  DEFAULT_ROUTING,
  type RoutingConfig,
} from '../../../src/ai/model-routing.js';

/** Minimal fake pool whose query() returns the provided rows. */
function poolReturning(rows: Array<{ value: string }>): Pool {
  return {
    query: async () => ({ rows }),
  } as unknown as Pool;
}

function poolThatThrows(): Pool {
  return {
    query: async () => {
      throw new Error('db down');
    },
  } as unknown as Pool;
}

describe('readRoutingConfig', () => {
  it('returns defaults when no config row exists', async () => {
    const cfg = await readRoutingConfig(poolReturning([]));
    expect(cfg).toEqual(DEFAULT_ROUTING);
  });

  it('parses a stored config and leaves fallback null when absent', async () => {
    const cfg = await readRoutingConfig(
      poolReturning([
        { value: JSON.stringify({ textPrimary: { provider: 'Cerebras', model: 'gpt-oss-120b' } }) },
      ]),
    );
    // provider is normalized to lower-case
    expect(cfg.textPrimary).toEqual({ provider: 'cerebras', model: 'gpt-oss-120b' });
    expect(cfg.textFallback).toBeNull();
    // missing sections fall back to the defaults
    expect(cfg.visionPrimary).toEqual(DEFAULT_ROUTING.visionPrimary);
  });

  it('falls back to defaults on malformed JSON', async () => {
    const cfg = await readRoutingConfig(poolReturning([{ value: 'not-json' }]));
    expect(cfg).toEqual(DEFAULT_ROUTING);
  });

  it('never throws on a DB error', async () => {
    const cfg = await readRoutingConfig(poolThatThrows());
    expect(cfg).toEqual(DEFAULT_ROUTING);
  });
});

describe('textCandidates', () => {
  it('orders primary → fallback → known-good defaults, appended as a safety net', () => {
    const cfg: RoutingConfig = {
      textPrimary: { provider: 'cerebras', model: 'gpt-oss-120b' },
      textFallback: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      visionPrimary: DEFAULT_ROUTING.visionPrimary,
      visionFallback: DEFAULT_ROUTING.visionFallback,
    };
    const cands = textCandidates(cfg);
    expect(cands[0]).toEqual({ provider: 'cerebras', model: 'gpt-oss-120b' });
    expect(cands[1]).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
    // Safety-net defaults are always reachable last.
    expect(cands.some((c) => c.provider === 'groq' && c.model === 'openai/gpt-oss-120b')).toBe(true);
    expect(cands.some((c) => c.provider === 'groq' && c.model === 'openai/gpt-oss-20b')).toBe(true);
  });

  it('filters out unknown providers but keeps the working defaults', () => {
    const cfg: RoutingConfig = {
      textPrimary: { provider: 'notaprovider', model: 'x' },
      textFallback: null,
      visionPrimary: DEFAULT_ROUTING.visionPrimary,
      visionFallback: DEFAULT_ROUTING.visionFallback,
    };
    const cands = textCandidates(cfg);
    expect(cands.every((c) => c.provider !== 'notaprovider')).toBe(true);
    expect(cands.length).toBeGreaterThan(0);
  });

  it('dedupes when the admin selection equals the default', () => {
    const cfg: RoutingConfig = {
      textPrimary: { provider: 'groq', model: 'openai/gpt-oss-120b' },
      textFallback: { provider: 'groq', model: 'openai/gpt-oss-20b' },
      visionPrimary: DEFAULT_ROUTING.visionPrimary,
      visionFallback: DEFAULT_ROUTING.visionFallback,
    };
    const slugs = textCandidates(cfg).map(routingSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toEqual(['groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b']);
  });
});

describe('visionCandidates', () => {
  it('includes the configured primary and appends the default vision fallback', () => {
    const cfg: RoutingConfig = {
      textPrimary: DEFAULT_ROUTING.textPrimary,
      textFallback: DEFAULT_ROUTING.textFallback,
      visionPrimary: { provider: 'gemini', model: 'gemini-flash-latest' },
      visionFallback: null,
    };
    const cands = visionCandidates(cfg);
    expect(cands[0]).toEqual({ provider: 'gemini', model: 'gemini-flash-latest' });
    expect(
      cands.some(
        (c) => c.provider === 'groq' && c.model === 'meta-llama/llama-4-scout-17b-16e-instruct',
      ),
    ).toBe(true);
  });
});
