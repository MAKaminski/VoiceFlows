# Progress

| Milestone | Status | Acceptance results |
|---|---|---|
| M0 — Latency spike | **Done 2026-09-26** | Ran from Railway sfo + Mac. TTFV-0 **607 ms** (target 400 ❌), TTFV-1 **1,515 ms** (target 1,000 ❌), op validity **100%** Haiku / 88% Sonnet, cost **$0.0313/speaking min** (budget $0.046 ✅), cache 0/0. Bottleneck: Deepgram interim every 979 ms → 502 ms word lag. Decisions in ADR 0006; details in `docs/LATENCY_BUDGET.md` |
| M2a — STT bake-off | **Done 2026-09-26** | Deepgram **Flux** adopted: word lag **91 ms p50** (sfo) / 51 ms (Mac) vs Nova-3 397 / 433 ms; updates every 240 ms. Projected TTFV-0 196 ms ✅, TTFV-1 879 ms ✅ with ADR 0006 levers. Soniox/AssemblyAI/ElevenLabs adapters ready, untested (no keys). ADR 0007 |
| M1 — Skeleton + static render | **Done 2026-09-26** | `docker compose up`: all 4 services · `/playground` renders all 12 primitives · schema = ERD (13 tables, 16 FKs) · WS hello→welcome · dsl tests · typecheck clean |
| Deploy (pulled forward) | **Live 2026-09-26** | Vercel `live-canvas` ↔ Railway gateway (sfo) `/healthz` 200, WS verified; Postgres schema applied by pre-deploy migrate (13 tables, 16 FKs); Redis online |
