-- Migration: Audio blob storage table
-- Stores audio file blobs with a 7-day TTL for transcription requests.
-- Requirement 15.2: offload blobs to object storage with configurable retention (default 7 days).

CREATE TABLE IF NOT EXISTS audio_blobs (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  session_id    uuid NOT NULL REFERENCES interview_sessions(id),
  file_name     text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  data          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);

-- Index for cleanup of expired blobs
CREATE INDEX IF NOT EXISTS idx_audio_blobs_expires_at ON audio_blobs (expires_at);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_audio_blobs_user_session ON audio_blobs (user_id, session_id);
