# Build plan — one milestone per Claude Code session

## M1 — Skeleton + static render
Monorepo, compose stack, schema migrated, `packages/dsl` zod schemas, web renders a
hard-coded DesignDoc using all 12 primitives and default tokens.
**Accept:** `docker compose up` works; `/playground` shows every primitive; schema.sql = ERD.

## M2 — Voice in, transcript out
AudioWorklet capture → WS → STT adapter (Deepgram + Web Speech fallback) → transcript strip.
Persist UTTERANCES + TRANSCRIPT_SEGMENTS.
**Accept:** partials appear <500 ms p50 after speech; works with no STT key via fallback.

## M3 — Patch engine (text-driven)
Typed prompt → Patch Engine → streamed ops applied live, versions + undo/redo.
**Accept:** "add a login form" yields ops that validate; first op renders before stream ends;
undo restores the exact prior doc.

## M4 — Intent engine (the core experience)
Wire partials → intent → delta → commit → speculative jobs with abort + rollback.
Latency events + dev HUD with tunable sliders. `FUSED_FAST_PATH` flag.
**Accept:** the CLAUDE.md definition-of-done utterance passes 8/10 runs; p50 TTFV ≤ 1.2 s;
<3 reflows per element.

## M5 — Polish, share, deploy
Token sets (3 themes), version timeline UI, read-only share link, magic-link auth.
Deploy: `apps/web` to Vercel (`NEXT_PUBLIC_GATEWAY_WS=wss://<railway-domain>/ws`);
`apps/gateway` + Postgres + Redis to Railway in one region, with `railway.json` for the
gateway service, health check at `/healthz`, and `schema.sql` applied as the first migration.
**Accept:** switching theme is a single patch; share link renders live updates; the
definition-of-done utterance passes on the deployed URLs with p50 TTFV ≤ 1.3 s
(an extra 100 ms allowed for the public network).

## M6 — Export
HTML/React export, PNG export, import-by-URL handoff for external design tools.
**Accept:** exported React renders identically to the canvas (visual diff <2%).
