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

## M5b — Feature flags, admin screen, user vocabulary (2026-09-27) — DONE (admin needs ADMIN_TOKEN)
- ADR 0012 / D24. 7 flags (registry → `feature_flags`), gateway-enforced; usage in `feature_events`;
  `/admin` page + bearer API; `vocabulary_terms` per document; keyword rail with rule tooltips;
  "+ Add word" and spoken "define X as Y" → "confirm".
- Plan-critic blockers fixed first: a spoken definition drew nothing and called no model; admin CORS
  scoped to admin origins with PUT + Authorization.
- Tests: dsl 40/40; gateway 37/37 incl. Postgres (migration twice on a fresh DB + once on existing:
  16 tables, 20 FKs). Browser (local): UI add word → chip + tooltip; admin flip hides ERD live.
- Live (Railway, 2026-09-27): `vocab-live.mts` 5/5 (spoken define drew nothing, no model job; confirm; next
  "ledger" drew in Database lane); diagrams 3/3; screen regression batches 7/10 then 10/10 (27/30 across
  the three post-M5 batches; the screen path is unchanged — the miss is model-latency variance).
  Watch: TTFV-1 adj. p50 trending 817 → 835 → 859 ms against the 870 ms bar.

## M5c — Transcript word highlighting (2026-09-27)
- Flag `transcript_highlight`; gateway `words` marks (drawn / yours / model) keyed by occurrence;
  strip styles words with tooltips ("Drew “Postgres” instantly", "Sent to the model …"). ADR 0012 §7.
- Fixed a lexicon bug found by its test: a definite article from the previous noun suppressed the next one.
- Tests: dsl 41/41, gateway 38/38 incl. Postgres.

## M5d — Share links (2026-09-27)
- ADR 0013 / D25: flag `share_links`; links are `exports` rows pinned to the version on screen; revoke → 404
  next view; tokens redacted from logs; lookups rate-limited; `/s/[token]` read-only page (noindex, no-referrer).
- Plan-critic fixes taken: reuse `exports` (no second table), pin to version, revoke scoped to own document,
  links listed at welcome, bounded view counting. Declined: server-side fetch (client fetch + existing CORS is simpler).
- Tests: gateway 42/42 incl. Postgres (pinning survives a new diagram; one link per version; cross-document
  revoke refused; flag off → 404); web production build passes.

## M5e — Remember the document across tabs (2026-09-27)
- ADR 0014 / D26: flag `remember_document`; one owning tab per document with takeover; fresh session row
  per open (fixes seq reuse on resume); flush-before-load closes the reload race; "New" button.
- Plan-critic replan taken: single owner instead of multi-tab fan-out.
- Tests: gateway 47/47 incl. Postgres reload race (v0,v1,v2 all persisted); web build passes.

## M5f — Version timeline (2026-09-27)
- ADR 0015 / D27: History strip (v#, kind, +/−/~, time), jump to any version, branch on edit, redo retraces
  the jump, other branches faded; flag `version_timeline`.
- Plan-critic fixes taken: goto op origin, redo toward the jump origin, clear lexicon fold targets, cap 200.
- Tests: gateway 50/50 incl. Postgres; dsl 41/41; web build passes.

## M6 — Projects: four views, context kept (2026-09-27)
- ADR 0016 / D28: one project document with Screen · Architecture · ERD · Sequence views; engine on a view
  doc with path rewrite; jobs pinned to their view; naming a view switches without replacing; project
  brief (≤120 tokens) + background notes; enterprise systems, extra lanes, owner badges; flags
  `projects`, `project_notes`; old docs/versions/share links upgrade on read.
- Plan-critic blockers fixed first: brief cost capped (math in ADR), metrics tap measures the view root
  and errors if missing, the kind switch can no longer wipe a view.
- Tests: dsl 46/46; gateway 53/53 incl. Postgres (cross-view speech, brief carries other views' names,
  a fact at utterance 1 reaches utterance 20 via notes, start-over clears only its view).
- 2026-09-27 · Architecture prompt trimmed 4,044 → 2,510 chars; the four standard lanes are no longer re-sent
  in the document. Live: input tokens per architecture call ~1,272 → 779 (−39%, under the 1,100 guideline);
  projects-live 2/2 all checks pass; diagram-live 3/3.
- 2026-09-27 · ERD prompt 3,001 → 2,154 chars and sequence 2,943 → 1,990. Live input tokens per call: ERD
  862 → 692 (−20%), sequence 826 → 618 (−25%); same tables/participants/edges drawn; diagram-live 3/3 twice;
  projects-live all pass.
- 2026-09-27 · Screen prompt trim tried and **reverted**. A/B on Railway, 10 runs each: trimmed 7/10 and 10/10,
  settle p50 920 / 891 ms, $0.0119 / $0.0116; original 9/10, settle p50 750 ms, $0.0119. No measurable cost
  win and a consistent ~150 ms settle loss, so the original stays. (Trimmed draft kept out of the repo.)

## Jev bake-off (2026-09-27) — PASS
- TypeSafe Jev (typed-decision "System One" model) vs Haiku on the SAME structural questions (24 cases, 390
  decisions: connections, direction, style, lane, kind, owner, ERD relation + cardinality, sequence
  messages, screen position/size/colour, view routing, actionable gate). 10 rounds from Railway sfo
  (`apps/gateway/src/bench/jev.ts`, raw: `docs/m6/2026-09-27-jev-bakeoff-railway-sfo.json`).
- Jev p50 **90 ms** / p95 146 ms, 97.9 % correct, $0.00004 per call. Haiku p50 722 ms / p95 910 ms, 95.1 %,
  $0.00067 per call. Jev answers with confidence ≥ 0.8: 85 % of decisions, **100 % correct**.
- Misses: "postgres is read by shaw" (both engines, reversed grammar); "the web app calls the api" gated
  as not-actionable 2/10 (Haiku 7/10) — both low-confidence, i.e. would fall back.
- Bar was p50 ≤ 300 ms and ≥ 90 % correct: passed on both.

## M6b — Jev decisions tier (2026-09-27)
- ADR 0017 / D29: phase 0 of every voice job is one Jev request; confident answers → compact ops (origin `jev`);
  the model runs only for low-confidence answers and new text; 250 ms timeout → model; same-pair edges fold;
  flag `jev_decisions`; migration 004 (`intents.path` += 'jev').
- Re-measured the build's adjacent-pair format first (plan-critic): Jev p50 90 ms / p95 134 ms, 95.8 % correct
  (Haiku 716 ms, 93.5 %), confident answers 100 % correct on 85 % of decisions
  (`docs/m6/2026-09-27-jev-bakeoff-adjacent-railway-sfo.json`). Shared blind spot: "X belongs to Y" direction
  (both engines 0/10; Jev unsure → falls back).
- Tests: gateway 64/64 incl. Postgres (11 new), dsl 46/46.
- Live tuning after first deploy (2026-09-27): Jev answered in 76–139 ms but was "unsure" on 10/10 screen moves
  (ids as option keys; every element offered). Fixed: readable option keys (relationships then confident and
  correct on every run), "X on top" with X named right before decided by grammar (no call), labels without
  dangling prepositions, the lexicon re-reads provisional labels, and "sign and"/"log and" before "button" are the
  known Flux mishearings of sign in/log in (Haiku had been silently fixing them).
- **Screen acceptance with Jev (Railway, 10 runs): 10/10 · TTFV-1 p50 116 ms (172 ms adj., was 775–901) ·
  settle 754 ms · 1 reflow · $0/min on the DoD sentence (no model call).** Diagram checks 3/3, projects-live
  6/6, vocab-live 6/6; a spoken relationship decided by Jev in 114 ms in-region.
- Settle unchanged (~750 ms): it waits for Flux's end-of-turn signal, not the model — the next lever.

## Settle tuning (2026-09-28) — no safe gain; ADR 0018
- eager_eot_threshold 0.3 vs 0.4: settle 689 vs 686 ms (no change). Silence rule (audio clock / energy):
  0/10, split sentences (4 then 2 versions). The DoD recording's pause after "button," is 640–800 ms of real
  silence — longer than Flux's end-of-turn (~685 ms). Silence rule kept as an OFF tunable; reopen-on-new-words
  fix kept; harness requires one version per utterance.
- Confirmation after the final deploy (silence rule off, Railway, 10 runs): **10/10 · one version per sentence on
  every run · TTFV-0 p50 −176 ms adj. · TTFV-1 p50 112 ms adj. · settle p50 695 ms · 1 reflow · $0/min**.

## M7 — Fluency: speak freely (2026-09-28) — ADR 0019
- Trigger: the user's first free-form session on production — connectors ("rights to"), growing the ERD and
  colours (pink/orange) failed. Root cause #1: the model was only called for allowlisted words.
- Built: open vocabulary at end of sentence (flag `open_vocabulary`); 5 hue tokens + ~30 colour words, Card
  fill, background; speech repair ("rights to" → "writes to"); fan-out Jev pairs; retry of words sent too
  early; re-ask of relations when a later component is named; prefix nouns renamed when the name completes;
  named systems never mistaken for references; forced calls charged to the bucket; stale tabs reload on a
  newer protocol.
- **Bug found and fixed:** the hedged model client deadlocked when the reader stopped after "none 0". It awaited
  usage from a suspended stream, which hung that job and every later model call in the session. Regression test
  added.
- **Fluency corpus: 74 cases** (73 scored + 1 known blind spot) across Screen/Architecture/ERD/Sequence (fillers, mishearings, passives, fan-in/out,
  negation, colours, growth over several sentences, view switches). Offline engine checks run in CI.
  Live, local: 62/73 → 72/73 while fixing. **Production (Railway): 73/73 (100%)**: screen 24/24,
  architecture 23/23, ERD 18/18, sequence 8/8; settle p50 794 ms from the final partial; $0.095 for all 74 cases.
  The "belongs to" direction blind spot is still wrong (not scored). Bar ≥ 90%.
- **DoD acceptance after deploy (10 runs, real audio): 10/10 · TTFV-0 p50 −195 ms adj. · TTFV-1 p50 85 ms adj.
  (was 112) · settle p50 670 ms (was 695) · 1 reflow · $0/min.**
- "Belongs to" blind spot closed by rule (ADR 0017 amendment, 2026-09-28): "each order belongs to a customer" →
  customers 1:n orders with `customer_id` on orders, instantly and with no model call. It also covers "owned by",
  "part of", "assigned to", fan-out ("each comment and each ticket is owned by an agent"), and leaves
  negations to Jev. Corpus: 77 cases, all scored.
