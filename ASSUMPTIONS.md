# Assumptions log

| Date | Decision | Reason | How to reverse |
|---|---|---|---|
| 2026-09-26 | Magic-link tokens stored in Redis with 15-min TTL, not Postgres | D10 says single table; tokens are ephemeral | Add `magic_links` table with FK → users |
| 2026-09-26 | `ARCHITECTURE.md` lives at repo root, not `docs/` | Owner's standing rule for all projects | Move file back; update CLAUDE.md links |
| 2026-09-26 | pnpm workspaces monorepo | Simplest workspace tool already installed | Swap to npm workspaces |
| 2026-09-26 | Canvas styling via plain CSS variables (no Tailwind) | Tokens map 1:1 to CSS vars; fewer deps | Add Tailwind and map tokens to theme |
| 2026-09-26 | Schema applied by gateway pre-deploy step (`node dist/migrate.js`), skipped when `users` exists | Railway Postgres is private-network only (no TCP proxy); M5 needs "schema.sql as first migration" | Replace with versioned migrations (e.g. node-pg-migrate) in M5 |
| 2026-09-27 | Live doc held in gateway memory (single replica, min 1); Redis deferred to M5 read-only viewers | Only one writer and one replica until sharing lands | Mirror DocSession.doc to Redis on each op batch |
| 2026-09-27 | Schema changes ship as idempotent `db/migrations/*.sql` run every deploy; `schema.sql` stays the canonical ERD source | Railway Postgres is private; no migration tool yet | Adopt node-pg-migrate with a tracking table |
| 2026-09-27 | Resuming a pre-M3 document with no version rows backfills v0 from `current_doc` | M2 sessions predate versions (bug found in browser check: next version was -Infinity) | Delete legacy sessions instead |
