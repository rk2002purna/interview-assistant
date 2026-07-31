-- Migration 0015: one-time mid-interview grace extension
--
-- Adds interview_sessions.auto_extended so a session can be granted exactly one
-- automatic +45 minute grace extension when its paid time runs out mid-
-- interview. During the grace window the wallet is allowed to go negative
-- (billed as debt) and reconciled on the user's next top-up.
--
-- Depends on: 0004 (interview_sessions), 0012 (wallet + charged_paise).

BEGIN;

ALTER TABLE interview_sessions
  ADD COLUMN IF NOT EXISTS auto_extended boolean NOT NULL DEFAULT false;

COMMIT;
