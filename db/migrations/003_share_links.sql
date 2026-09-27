-- M5d (2026-09-27), ADR 0013. Idempotent: runs on every deploy, after schema.sql on a fresh database.
-- Share links are `exports` rows with format 'url' (the export kind reserved for this), pinned to the
-- version on screen. The token (128-bit random) is the only credential; revoking sets revoked_at.
ALTER TABLE exports ADD COLUMN IF NOT EXISTS token text;
ALTER TABLE exports ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS exports_token_key ON exports (token);
