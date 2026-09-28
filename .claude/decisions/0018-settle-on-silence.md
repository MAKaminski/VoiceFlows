# ADR 0018 — Settle: Flux's end-of-turn stays in charge; the silence rule ships OFF
Date: 2026-09-28 · Status: accepted · Amends: ADR 0010 (reopen on any new word after an early settle)

## Context
With the Jev tier, TTFV-1 fell to ~170 ms but settle stayed ~690 ms. The timeline (Railway, relay mode)
shows the full transcript ~114 ms BEFORE the last word ends, Flux's EagerEndOfTurn ~685 ms after it,
and the version 3 ms later — settle is purely waiting for Flux to decide the speaker is done.

## What was measured
| Attempt | Result (10 runs, DoD sentence) |
|---|---|
| eager_eot_threshold 0.4 (baseline) | 10/10, settle p50 686 ms, 1 version/sentence |
| eager_eot_threshold 0.3 (Deepgram's minimum) | 10/10, settle p50 689 ms — no change |
| Silence rule v1: audio clock − last transcribed word ≥ 400 ms | 0/10 — 4 versions/sentence (transcripts lag audio while speaking) |
| Silence rule v2: audio RMS < 0.02 for 400 ms + transcript caught up | 0/10 — 2 versions/sentence |
| Recording analysis | the pause after "…sign-in button," is 640–800 ms of real silence |

## Decision
1. Keep Flux's EagerEndOfTurn (threshold 0.4) as the settle signal. A natural mid-sentence pause
   (640–800 ms) outlasts it; any silence rule fast enough to beat Flux splits the sentence. Flux also uses
   intonation, which silence can't.
2. The energy-based silence rule stays in the code as a tunable (`SILENCE_SETTLE_MS`, default 0 = off)
   for fast, clipped speakers; it only fires when the audio's own energy is quiet AND the transcript has
   caught up, and it fails safe in noisy rooms (never quiet → Flux decides).
3. Kept fix: after any early settle, a transcript that GROWS reopens the utterance — before, words the
   lexicon alone would draw were dropped for the rest of the turn.
4. The acceptance harness now requires one version per utterance.

## Consequences
+ Settle stays ~690 ms with no split versions; drawing itself finishes at TTFV-1 (~170 ms), so settle is
  when the version commits and the provisional shimmer turns solid — not when things appear.
− Cutting settle further needs a semantic+acoustic end-of-turn signal faster than Flux's.
