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

- 2026-09-27 · **Vocabulary is per document, not per user** — every visitor is the anonymous user until magic-link auth, so per-user words would be shared by all. Reverse: add `user_id` to `vocabulary_terms` once accounts exist and backfill from the document owner.
- 2026-09-27 · **Flags are global and assume one gateway replica** — a flip updates this process's cache and broadcasts to its sockets. Reverse: reload flags on a 5 s TTL (or Redis pub/sub) before scaling out.
- 2026-09-27 · **`diagram_metrics` ships as an off flag with nothing behind it** — so the admin screen lists the roadmap item; it records no usage until built.
- 2026-09-27 · **`documentId` in localStorage is a bearer credential for its document** — accepted until accounts (ADR 0014). Reverse: bind documents to users and require the session cookie.
- 2026-09-28 · **PGlite is a gateway devDependency** — `pnpm test:codegen` applies generated SQL to real Postgres without Docker or CI (plan-critic M10 #4). Test-only; never bundled. Reverse: drop it once CI with a Postgres service exists.
- 2026-09-28 · **Import is JSON-only for specs (no YAML)** — OpenAPI JSON and package.json; docker-compose and OpenAPI YAML wait (no YAML parser in the repo, and adding one wasn't worth M10). Reverse: add `yaml` and route `.yml` through the same importers.
- 2026-09-28 · **Generated API routes are CRUD per ERD table on an in-memory store** — compiles with no database; non-CRUD sequence steps become 501 stubs. Reverse: generate pg queries from `db/schema.sql` (the contracts already match).
- 2026-09-28 · **AI-filled files are checked syntactically only** (exports kept, braces balance) and labelled "unverified" — the TypeScript compiler stays out of the gateway bundle (≈ 9 MB). Reverse: typecheck in the browser with a lazily loaded compiler, or in a sandbox.
- 2026-09-28 · **The AI-fill daily cap (50) is per gateway process** — exact with 1 replica. Reverse: move the counter to Redis before scaling out.
