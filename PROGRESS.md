# Progress

| Milestone | Status | Acceptance results |
|---|---|---|
| M0 — Latency spike | **Done 2026-09-26** | Ran from Railway sfo + Mac. TTFV-0 **607 ms** (target 400 ❌), TTFV-1 **1,515 ms** (target 1,000 ❌), op validity **100%** Haiku / 88% Sonnet, cost **$0.0313/speaking min** (budget $0.046 ✅), cache 0/0. Bottleneck: Deepgram interim every 979 ms → 502 ms word lag. Decisions in ADR 0006; details in `docs/LATENCY_BUDGET.md` |
| M4 — Intent engine (design while talking) | **Done 2026-09-27** | ✅ **9/10** DoD runs pass (need 8), Node relay harness vs Railway + Flux + Haiku (`docs/m4/`): TTFV-0 p50 −192 ms adj., TTFV-1 **756 ms**, settle **697 ms**, max reflows **1**, form before "button" ends 10/10, **9.6 calls/min, $0.0111/min**. ✅ Headless browser 3/3: correct layout, 1 on-screen reflow (after fixing 5 browser-only bugs). ⚠️ Browser TTFV-1 862–1,349 ms runs above the harness. Gateway tests 27/27, dsl 19/19. HUD at `/studio?hud`. ADR 0010 |
| M3 — Patch engine (text-driven) | **Done 2026-09-27** | ✅ "add a login form" → Card + 3 children, all ops validate, **6/6 live runs** vs Railway + real Haiku (`docs/m3/`). ✅ First op before stream end: first op p50 **874 ms**, job end p50 1,126 ms (client-measured, incl. network). ✅ Undo restores the exact prior doc (6/6 live; unit + Postgres tests; verified in browser). Gateway tests 16/16 (engine, versions, undo mid-stream, abort, resume, legacy-resume regression, pg FK chain); dsl 13/13. Header compression measured −45 ms (est. −150). Lexicon deferred to M4 (ADR 0009). |
| M2 — Voice in, transcript out | **Built 2026-09-26; 1 acceptance item open** | ✅ Partials < 500 ms p50: **136 ms p50 / 457 ms p95** in a real browser (fake-mic Chrome → AudioWorklet → gateway relay → Flux), recall 93%, 2 valid runs × 14 words (`docs/m2/2026-09-26-e2e-voice-chrome-relay.json`). ✅ UTTERANCES + TRANSCRIPT_SEGMENTS persisted off the hot path (pg test green; Railway logs). ✅ Gateway tests 7/7, dsl 8/8, typecheck clean. ⏳ *No-key Web Speech fallback*: mode selection unit-tested; live browser check pending (not Brave). ⏳ Direct mode needs a grant-capable (Member) Deepgram key. |
| M2a — STT bake-off | **Done 2026-09-26** | Deepgram **Flux** adopted: word lag **91 ms p50** (sfo) / 51 ms (Mac) vs Nova-3 397 / 433 ms; updates every 240 ms. Projected TTFV-0 196 ms ✅, TTFV-1 879 ms ✅ with ADR 0006 levers. Soniox/AssemblyAI/ElevenLabs adapters ready, untested (no keys). ADR 0007 |
| M1 — Skeleton + static render | **Done 2026-09-26** | `docker compose up`: all 4 services · `/playground` renders all 12 primitives · schema = ERD (13 tables, 16 FKs) · WS hello→welcome · dsl tests · typecheck clean |
| Deploy (pulled forward) | **Live 2026-09-26** | Vercel `live-canvas` ↔ Railway gateway (sfo) `/healthz` 200, WS verified; Postgres schema applied by pre-deploy migrate (13 tables, 16 FKs); Redis online |

## M5a — Spoken diagrams: Architecture · ERD · Sequence (2026-09-27) — DONE
- ADR 0011 / D23: `Diagram`/`Layer`/`Node`/`Edge` primitives, 4 seeded architecture lanes, append-stable
  `layoutDiagram`, per-kind lexicon + prompt + call allowlist, `new_doc`, vocabulary rail.
- Plan-critic blockers fixed before build: exact-key folds for diagram nodes, lane-aware lexicon,
  nesting rules, reset keeps kind. Found in tests: a relationship verb called the model before its
  object was spoken (edge lost) → verbs wait for their object.
- Tests: dsl 35/35 (layout: no overlaps, edges avoid boxes, append-stable), gateway 28 + 3 pg-skipped.
- Visual check: /playground?kind=architecture|erd|sequence.
- Live (Railway): diagram prompts 6/6; screen regression 10/10, TTFV-1 817 ms adj., $0.0113/min. ADR 0011 §Result.

## M5b — Feature flags, admin screen, user vocabulary (2026-09-27) — built; live after deploy
- ADR 0012 / D24. 7 flags (registry → `feature_flags`), gateway-enforced; usage in `feature_events`;
  `/admin` page + bearer API; `vocabulary_terms` per document; keyword rail with rule tooltips;
  "+ Add word" and spoken "define X as Y" → "confirm".
- Plan-critic blockers fixed first: a spoken definition drew nothing and called no model; admin CORS
  scoped to admin origins with PUT + Authorization.
- Tests: dsl 40/40; gateway 37/37 incl. Postgres (migration twice on a fresh DB + once on existing:
  16 tables, 20 FKs). Browser (local): UI add word → chip + tooltip; admin flip hides ERD live.
