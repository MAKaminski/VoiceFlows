-- ADR 0017 (2026-09-27). Idempotent: Jev decisions are logged as intents with path 'jev'.
ALTER TABLE intents DROP CONSTRAINT IF EXISTS intents_path_check;
ALTER TABLE intents ADD CONSTRAINT intents_path_check CHECK (path IN ('lexicon','haiku','sonnet','fused','jev'));
