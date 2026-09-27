# Latency budget — measured (M0 + M2 STT bake-off, 2026-09-26)

Metric that matters: **TTFV**, the time from a spoken word ending to a visible canvas change.
- **TTFV-0** is the first visible change: the client lexicon draws provisional nodes (ADR 0001).
- **TTFV-1** is the first model-quality change: the fused Haiku call.

Raw data: [`docs/m0/2026-09-26-railway-sfo.json`](m0/2026-09-26-railway-sfo.json) (the spike ran as a
Railway service in sfo) and [`docs/m0/2026-09-26-mac.json`](m0/2026-09-26-mac.json) (the owner's Mac).
Harness: `apps/gateway/src/spike.ts`. It streams a recorded 6.23 s WAV of the definition-of-done
sentence in real time. 10 STT runs; 20 model runs per cell (5 for Sonnet).

## Result against targets

| Metric | Target p50 | **Measured p50** | Gap | Verdict |
|---|---|---|---|---|
| TTFV-0 | ≤ 400 ms | **607 ms** | +207 ms (+52%) | ❌ STT-bound |
| TTFV-1 | ≤ 1,000 ms | **1,515 ms** | +515 ms (+52%) | ❌ STT + model |
| Model op validity | ≥ 98% | **100%** Haiku · 88% Sonnet | — | ✅ Haiku · ❌ Sonnet |
| Cost per speaking minute | ≤ $0.046 | **$0.0313** | −32% | ✅ |
| Model calls per speaking minute | ≤ 20 | 20 (cap binds; 106 content-word events/min) | — | ✅ |

TTFV-0 = 40 net + **502 STT** + 5 lexicon + 60 render = **607 ms**.
TTFV-1 = 40 net + **502 STT** + 20 relay + 75 gap + **788 first op** + 30 push + 60 render = **1,515 ms**.
Net, relay, gap, push and render are still estimates. M4 measures them on the client.

## Per hop: estimate vs measured

| Hop | ADR 0001 estimate | Measured sfo p50 / p95 | Measured Mac p50 | Note |
|---|---|---|---|---|
| Deepgram connect | — | 24 / — ms | 254 ms | Opened at session start, so it is off the hot path |
| **Deepgram word-end → first partial** | 250 ms | **502 / 2,706 ms** | 541 ms | **The dominant hop.** p95 is inflated because the harness counts a word Deepgram revises as a new word |
| Deepgram interval between partials | ~250 ms | **979 ms** | 987 ms | Nova-3 sends an interim roughly once per second; this is the root cause |
| Keyword lag p50 ("button", "email", "logo") | — | 502 · 416 · 363 ms | 568 · 460 · 426 ms | "big" is worst at 801 ms |
| Haiku TTFT | 350 ms | **475 ms** | 499 ms | |
| Haiku header line closed | — | 669 ms | 695 ms | The header costs about **194 ms** (≈ 23 tokens at 117 tok/s) |
| **Haiku first valid op (compact, warm)** | 520 ms | **788 / 1,110 ms** | 820 ms | |
| Haiku first op, compact on a fresh connection | — | 796 ms | 899 ms | Keep-alive saves 8 ms in sfo and 79 ms from the Mac |
| Haiku first op, JSON Patch | — | 878 ms | 901 ms | Compact wins by **90 ms (−10%)**, and needs no separate intent call |
| Sonnet 5 first op (settle) | — | **2,232 / 5,726 ms** | 1,531 ms | Too slow for a ≤ 1.2 s settle |
| Prompt cache writes / reads | 0 expected | **0 / 0** | 0 / 0 | The ~600-token prefix is under the minimum cacheable length |

## What this changes (decisions in ADR 0006)
1. **STT is the problem, not the model.** Deepgram Nova-3's ~1 s interim cadence alone
   exceeds the TTFV-0 budget. TTFV-0 ≤ 400 ms requires the STT hop to be ≤ 295 ms
   (400 − 40 − 5 − 60). **M2 runs an STT bake-off with this same harness:** Chrome Web Speech
   (free, per-word interims) and other streaming providers, each judged on word lag and
   $/min. The provider adapter (D6) already allows the swap.
2. **Compress the intent header.** Each output token costs ≈ 8.5 ms (at 117 tok/s), so cutting
   the header from ≈ 23 tokens to ≈ 5 (e.g. `add .9`) saves ≈ 150 ms of TTFV-1.
3. **Fire on the lexicon event instead of waiting for the gap.** When no call is in flight,
   start the call on the content word, saving 75 ms of average gap wait.
4. **Settle with Haiku by default.** Sonnet is reserved for explicit reset/structural rebuilds and runs in the
   background: its first op was 2,232 ms p50 with 88% validity.
5. **Drop prompt caching from the latency plan.** It never activates at this prefix size, and
   keep-alive only matters from far-away clients.

Projected, if the levers land:

| Scenario | TTFV-0 | TTFV-1 |
|---|---|---|
| Deepgram as-is + header + no gap | 607 ms | 40 + 502 + 20 + 0 + 638 + 30 + 60 = **1,290 ms** |
| STT at 200 ms + header + no gap | 40 + 200 + 5 + 60 = **305 ms ✅** | 40 + 200 + 20 + 0 + 638 + 30 + 60 = **988 ms ✅** |

## Instrumentation (unchanged)
Write a `latency_events` row per stage: `frame_rx, partial, extract_start, intent_ready, commit,
first_op, first_render, final, settled, reflow`. TTFV is measured on the client, from the
Deepgram word-end offset to render. The dev HUD shows rolling p50/p95.

## M2 STT bake-off (ADR 0007) — Deepgram Flux adopted

| Provider | Where | Word lag p50 / p95 | Update interval | Pass |
|---|---|---|---|---|
| Deepgram Nova-3 | sfo · Mac | 397 / 838 · 433 / 895 ms | 982 · 979 ms | ❌ |
| **Deepgram Flux** | sfo · Mac | **91 / 411 · 51 / 372 ms** | **240 · 240 ms** | ✅ |

Scored against one ground-truth alignment (`scripts/fixtures/dod.words.json`); raw data in `docs/m2/`.

| TTFV | With Nova-3 (M0) | With Flux | With Flux + header + trigger (ADR 0006) | Target |
|---|---|---|---|---|
| TTFV-0 | 607 ms | 40 + 91 + 5 + 60 = **196 ms ✅** | 196 ms ✅ | ≤ 400 |
| TTFV-1 | 1,515 ms | 40 + 91 + 20 + 75 + 788 + 30 + 60 = 1,104 ms ❌ | 40 + 91 + 20 + 0 + 638 + 30 + 60 = **879 ms ✅** | ≤ 1,000 |

## M4 acceptance — measured end to end (ADR 0010, `docs/m4/`)

Node harness streams the WAV over the gateway relay exactly like the browser; 10 runs vs Railway sfo.
Adjusted = + 40 ms capture + 16 ms render (estimates).

| Metric | p50 raw | p50 adjusted | Target | |
|---|---|---|---|---|
| TTFV-0 (lexicon) | −94 ms | −38 ms | ≤ 400 | ✅ elements appear before the word ends |
| TTFV-1 (first model op) | 850 ms | 906 ms | ≤ 1,000 | ✅ (2/10 runs over: 1,070 / 1,100 raw) |
| Settle after last word | 839 ms | 895 ms | ≤ 1,200 | ✅ |
| Max reflows / element | 1 | — | < 3 | ✅ |
| Model calls / speaking min | 9.6 | — | ≤ 20 | ✅ |
| $ / speaking min | $0.0129 | — | ≤ $0.046 | ✅ (−72% vs budget) |
