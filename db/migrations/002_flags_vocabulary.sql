-- M5b (2026-09-27), ADR 0012. Idempotent: runs on every deploy, after schema.sql on a fresh database.
CREATE TABLE IF NOT EXISTS feature_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL,
  description text NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feature_events (
  id bigserial PRIMARY KEY,
  feature_key text NOT NULL REFERENCES feature_flags(key),
  session_id uuid REFERENCES sessions(id),
  action text NOT NULL CHECK (action IN ('exposed','used','blocked')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feature_events_feature_key_created_at_idx ON feature_events (feature_key, created_at);
-- Vocabulary is scoped to a document until accounts exist (plan-critic: every visitor is the anonymous user).
CREATE TABLE IF NOT EXISTS vocabulary_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES design_documents(id),
  kind text NOT NULL CHECK (kind IN ('architecture','erd','sequence')),
  phrase text NOT NULL,
  node jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  UNIQUE (document_id, kind, phrase)
);
