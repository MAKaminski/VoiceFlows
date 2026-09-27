-- M3 (2026-09-27). Idempotent: applied on every deploy after schema.sql; safe to re-run.
-- Typed prompts are utterances too, so every generation job has an intent → utterance chain.
ALTER TABLE utterances ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'voice';
DO $$ BEGIN
  ALTER TABLE utterances ADD CONSTRAINT utterances_source_check CHECK (source IN ('voice','typed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Versions are monotonic; undo/redo move design_documents.current_version, new work branches from it.
ALTER TABLE design_versions ADD COLUMN IF NOT EXISTS parent_version int;
