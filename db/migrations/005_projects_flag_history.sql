-- M8 (2026-09-28), ADR 0020. Idempotent: runs on every deploy.
-- Project library: a saved project is listed in the shared workspace; archived ones are hidden (reversible).
ALTER TABLE design_documents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE design_documents ADD COLUMN IF NOT EXISTS saved_at timestamptz;
ALTER TABLE design_documents ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE design_documents ADD COLUMN IF NOT EXISTS view_counts jsonb;
CREATE INDEX IF NOT EXISTS design_documents_library_idx ON design_documents (updated_at DESC) WHERE saved_at IS NOT NULL;
-- Flag history: every change, who (admin / seed) and when. actor = a short hash of the admin's IP, never the IP.
CREATE TABLE IF NOT EXISTS feature_flag_changes (
  id bigserial PRIMARY KEY,
  feature_key text NOT NULL REFERENCES feature_flags(key),
  enabled boolean NOT NULL,
  source text NOT NULL CHECK (source IN ('admin','seed')),
  actor text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feature_flag_changes_feature_key_changed_at_idx ON feature_flag_changes (feature_key, changed_at DESC);
