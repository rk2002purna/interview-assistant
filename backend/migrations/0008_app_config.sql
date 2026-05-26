-- Migration 0008: app_config key-value store
-- Used for global configuration like model routing that admins control.

CREATE TABLE IF NOT EXISTS app_config (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
