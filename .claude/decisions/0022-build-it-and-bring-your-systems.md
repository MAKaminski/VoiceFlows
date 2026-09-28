# ADR 0022 — Build it (code scaffolding across workers) and Bring your systems (context import)
Date: 2026-09-28 · Status: accepted · Builds on: ADR 0021 (six views as a structured spec) · Supersedes: M6 "Export" (never built)

## Context
ADR 0021 put two items on the roadmap:
- **code scaffolding across workers:** the six views become a starter codebase;
- **context enrichment from customers' own systems:** a session starts from what they already have.

Plan-critic returned "proceed with changes", with 7 blockers, all adopted:
1. Don't bump PROTOCOL: a gateway-first deploy would strand open tabs in a reload loop.
2. TypeScript isn't in the gateway bundle.
3. There's no YAML parser.
4. There's no CI.
5. There's no retention path, and migrations re-run.
6. Hostile identifiers could reach generated code.
7. AI fill had no global cost cap.

It also named the cheaper shape: **generate in the browser**, which removes the back-end layer entirely.

## Decision
1. **Deterministic codegen in `packages/dsl` (`codegen.ts`), run in the browser.** One pure generator per worker,
   each reading only its views:

   | Worker | Reads | Writes |
   |---|---|---|
   | db | ERD | `db/schema.sql`: PKs, FKs via ALTER, FK indexes, quoted identifiers |
   | contracts | ERD | zod schema per table, singular type names |
   | api | architecture + sequence + ERD | Fastify CRUD per table on an in-memory store; action stubs for sequence steps; a client stub per external; `.env.example` |
   | web | screen | `page.tsx` from the 12 primitives with default tokens (M6's React export, finally) |
   | infra | architecture | `docker-compose.yml` |
   | load | constraints | `k6.js` at the declared peak; `capacity.md` |
   | plan | cva | `PRD.md`, `BACKLOG.md` (quick wins → big bets → fill-ins; money pits as "don't") |
   | readme | all | README, root `package.json`, `tsconfig` |

   - $0 and < 200 ms. Zipped in the browser by a store-only writer (`lib/zip.ts`, no dependency).
   - **No table, no migration, no endpoint.** Flag `code_scaffold`.
2. **AI fill across workers** (flag `code_scaffold_model`). The browser sends the source skeletons (≤ 12 files,
   ≤ 16 KB each; paths must match the generator's own shape). The gateway runs **4 concurrent Haiku workers**
   (`engine/fill.ts`, `prompts/code_fill.md`, `max_tokens` 2000, raw streaming that keeps indentation).
   - **Checks:** the file is non-empty, every exported name is kept, and braces balance (apostrophes are text in
     JSX). Any failure keeps the skeleton. The result is labelled "AI-written, unverified", and the skeleton stays
     one click away.
   - **Budget:** ≤ $0.15 per build. The worst case is reserved before each file starts, so concurrent workers
     can't overshoot.
   - **Time:** 45 s wall per build.
   - **Rate:** 1 per 5 min per session, **≤ 50/day globally** (50 × $0.144 = $7.20/day max). Refused in the demo.
   - Stateless: nothing is persisted, and results stream back as `fill_file` / `fill_done`.
   - This spend is click-driven, not per speaking minute, so it doesn't touch the speech call bucket or the
     $/speaking-minute threshold.
3. **Import** (flag `context_import`): pure parsers in `packages/dsl/src/importers.ts` for SQL DDL and pg_dump,
   Prisma, OpenAPI 3 JSON, and package.json.
   - **Every identifier is normalised to `[a-z_][a-z0-9_]{0,62}` and every label to a safe charset at the parser
     boundary**, so nothing hostile reaches the compact grammar, generated code or a prompt.
   - Caps: 512 KB, 60 tables, 40 columns, 40 components, 20 flows.
   - The gateway (the doc's only writer) applies the lines with origin `import`, with per-line fallback, then runs
     scaffolding. One version, one undo.
   - Existing tables get missing columns merged, never a duplicate table. Refused mid-sentence or while a job runs.
     Refused in the demo.
4. **Contracts are additive; `PROTOCOL` stays 3.**
   - `ClientMsg` gains `import` and `fill`; `ui_event` gains `code_scaffold`.
   - `ServerMsg` gains `import_result`, `fill_file` and `fill_done`.
   - `OpOrigin` gains `import`.
   - Deploy the gateway first; old web ignores the new server messages.

## Consequences
+ The design is now the start of the product, not a picture of it: a zip that runs `docker compose up` with SQL
  that applies to Postgres 16, and TypeScript that typechecks. Both are checked by `pnpm test:codegen` (PGlite +
  tsc, locally, since no CI exists).
+ A customer's schema or API spec seeds all six views in one step (scaffolding does the rest).
+ Measured locally with a real fill: 4 route files, 4 workers, **$0.024, 18.9 s**.
− AI-filled files are checked only syntactically, not typechecked (the compiler is ~9 MB and stays out of the
  gateway bundle). They are labelled "unverified".
− The route shape comes from the ERD (CRUD per table). Sequence steps that aren't CRUD become 501 action stubs.
− Not yet supported: YAML (docker-compose, OpenAPI YAML), live connectors (Postgres by connection string,
  Salesforce/HubSpot describe via OAuth), and pushing to a GitHub repo. These wait for accounts and per-user
  secret storage (ADR 0000).

```arch
{
  "components": [
    {"id":"codegen","label":"Codegen workers (browser)","layer":"frontend","note":"ADR 0022: six views → starter codebase, $0"},
    {"id":"fill-workers","label":"AI fill worker pool (4× Haiku)","layer":"middleware","note":"ADR 0022: ≤ $0.15/build, ≤ 50/day"},
    {"id":"importers","label":"Importers (SQL · Prisma · OpenAPI · package.json)","layer":"middleware","note":"ADR 0022: sanitised at the boundary"}
  ],
  "flows": [
    {"from":"codegen","to":"fill-workers","label":"fill {skeleton files} → fill_file stream"},
    {"from":"importers","to":"doc-session","label":"import → origin 'import' ops, one version, then scaffold"}
  ],
  "features": [
    {"id":"build-it-feature","label":"Build it (code scaffolding)","components":["codegen","fill-workers"]},
    {"id":"import-feature","label":"Bring your systems (import)","components":["importers","doc-session","scaffold"]}
  ]
}
```
