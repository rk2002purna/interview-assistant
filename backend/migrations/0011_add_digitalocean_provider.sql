-- Migration 0011: Add 'digitalocean' to provider_keys CHECK constraint
--
-- The original constraint in 0005 only permits:
--   'gemini', 'groq', 'deepseek', 'cerebras'
--
-- This migration widens it to also include 'digitalocean' for
-- DigitalOcean Serverless Inference API key storage.

BEGIN;

ALTER TABLE provider_keys
  DROP CONSTRAINT IF EXISTS provider_keys_provider_check;

ALTER TABLE provider_keys
  ADD CONSTRAINT provider_keys_provider_check
  CHECK (provider IN ('gemini', 'groq', 'deepseek', 'cerebras', 'digitalocean'));

COMMIT;
