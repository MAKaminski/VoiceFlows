# CLAUDE.md — LiveCanvas

You are building **LiveCanvas**: a web app where a user speaks and a UI design is generated
and refined on a canvas *while they are still talking*. The product's measure of success is
**latency**, bounded by **cost**. Read §Thresholds before touching the hot path.

## Read first, every session
| File | What it is |
|---|---|
| `ARCHITECTURE.md` | Source of truth: layers, living diagram, sequence, throughput, thresholds, ERD, design AST, patterns, sprawl. Generated blocks via `/arch` |
| `docs/CODEMAP.md` | Every module + exported symbol, generated from the TypeScript AST (`pnpm codemap`) |
| `docs/DECISIONS.md` + `.claude/decisions/*.md` | Locked decisions D1–D23 and ADRs 0000–0011 (each carries an ```` ```arch ```` block) |
| `docs/COST_MODEL.md` | $/speaking-minute, plan limits, BYOK |
| `docs/LATENCY_BUDGET.md` | Per-hop budget (superseded numbers noted in ADR 0001; M0 rewrites it) |
| `docs/BUILD_PLAN.md`, `PROGRESS.md`, `ASSUMPTIONS.md` | Milestones, results, guesses to review |

## Operating rules (non-negotiable)
1. **Do not ask the user questions during a milestone build.** Decisions are in
   `docs/DECISIONS.md` and `.claude/decisions/`. If something is unspecified, choose the
   simplest option consistent with them, log it in `ASSUMPTIONS.md` (date, decision, reason,
   how to reverse), and keep going. Missing secrets are the only blocker — then stop and ask,
   with the URL of the page that issues them.
2. **Build one milestone per session** from `docs/BUILD_PLAN.md` (M0 latency spike comes
   first). A milestone is done only when every acceptance test passes. Report in `PROGRESS.md`.
3. **Keep the architecture current.** Any schema or component change updates
   `ARCHITECTURE.md` prose *and* re-runs `/arch` + `pnpm codemap` in the same commit.
   `pnpm arch:check` must pass. New decisions go through `/adr` with an ```` ```arch ```` block.
   `db/schema.sql` keeps one column per line and `);` on its own line (the ERD parser needs it).
4. **Minimal, repetitive components.** Use the six patterns in `ARCHITECTURE.md` §6 before
   inventing a seventh. The canvas renders only the 12 screen primitives and the 4 diagram
   primitives (ADR 0011: Architecture · ERD · Sequence, positions from `layoutDiagram`); new visual
   needs compose primitives + tokens. A new table arrives with a foreign key.
5. **Never regenerate the whole design.** All changes are RFC 6902 ops through
   `applyOp`/`invertOp` in `packages/dsl`. The model writes compact op lines (ADR 0002); the
   gateway expands them. Full regeneration only on an explicit "start over" intent.
6. **One writer, two response tiers (ADR 0001, 0009).** The gateway's `DocSession` is the only
   writer of the doc; the browser applies its ops in order. The lexicon (gateway, M4) draws
   provisional nodes from STT partials with no model call; the fused Haiku call (compressed header,
   one in flight per session) edits them in place. Never let a new partial abort a running call —
   only an intent-delta commit, a new prompt, or undo/redo may.
7. **Latency and cost are features.** Every hop is timestamped. A change that regresses p50
   TTFV-0 or TTFV-1 by > 15%, or raises $/speaking-minute by > 15%, is a failing change.
8. **TypeScript end to end (ADR 0005).** Rust only for the gateway hot path, and only after a
   measured trigger (self-time > 20 ms p95, GC p99 > 10 ms, or gateway cost > $0.005/min).
9. Secrets only via env vars. Never commit or print `.env` contents.

## Thresholds (full table: ARCHITECTURE.md §4.4)
| Metric | p50 target | Fails when |
|---|---|---|
| TTFV-0 first visible change | ≤ 400 ms | > 15% regression |
| TTFV-1 first model-quality change | ≤ 1,000 ms | > 15% regression |
| Settle after speech stops | ≤ 1,200 ms | > 1,500 ms |
| Reflows per element per utterance | < 3 | ≥ 3 in > 2/10 runs |
| Cost per speaking minute | ≤ $0.046 (measured M4: $0.0111) | > $0.013 (+15% on measured) |
| Model calls per speaking minute | ≤ 20 | > 23 |
| Input tokens per model call | ≤ 1,100 | send only the edited subtree |

## Stack (locked)
- Front-end: Next.js 15 (App Router) + React 19 + TypeScript, Zustand, canvas as React nodes
  (not `<canvas>`), AudioWorklet mic → **Deepgram directly** with a gateway-minted token (ADR 0003).
- Middleware: Node 22 + TypeScript, Fastify + `@fastify/websocket`, zod for every contract,
  all contracts in `packages/dsl` (shared by browser and gateway).
- Models: Anthropic Messages API, streaming. Fused fast path `claude-haiku-4-5-20251001`;
  structural settle `claude-sonnet-5`. Keep-alive connection warmed at session open.
- STT: Deepgram Nova-3 streaming (interim results, VAD events); Web Speech fallback with no key.
- Back-end: Postgres 16 (system of record, never on the hot path), Redis 7 (live doc, active job, pub/sub).
- Infra: Docker Compose locally (build context = repo root). Production: `apps/web` on Vercel;
  `apps/gateway` + Postgres + Redis on Railway US-East, min 1 replica, no scale-to-zero.

## Repo layout
```
apps/web          # Next.js: canvas renderers (one per primitive), store, playground, HUD
apps/gateway      # Fastify + ws: session, STT token, fused engine, job controller, persistence
packages/dsl      # zod contracts, applyOp/invertOp, compact expander, delta score, lexicon
packages/prompts  # loads /prompts/*.md (static prefix + template)
prompts/          # model system prompts
db/schema.sql     # Postgres DDL (applied by compose init)
infra/            # docker-compose.yml
scripts/          # gen-codemap.ts, latency-spike.ts (M0)
docs/             # decisions, DSL, latency, cost, build plan, CODEMAP (generated)
.claude/decisions # ADRs with ```arch blocks → living diagram
```

## Commands
| Command | Does |
|---|---|
| `docker compose -f infra/docker-compose.yml up -d --build` | Full local stack (web :3000, gateway :8787, pg :5432, redis :6379) |
| `pnpm dev:web` / `pnpm dev:gateway` | Hot-reload dev servers |
| `pnpm test:dsl` | Contract, patch, compact-format and delta-score unit tests |
| `pnpm typecheck` | All workspaces |
| `pnpm codemap` / `pnpm arch:check` | Regenerate code map / fail if code map or ARCHITECTURE.md is stale |

## Definition of done for the whole project
Speaking "a login screen with email and password, big blue sign-in button, logo on top"
produces a visible frame + inputs before the word "button" finishes (TTFV-0 ≤ 400 ms p50),
model-quality edits land during speech (TTFV-1 ≤ 1,000 ms p50), the final layout settles
within 1.2 s of the user stopping, with fewer than 3 visible reflows of any element, at
≤ $0.046 per speaking minute — 8 of 10 runs, measured on the deployed URLs.
