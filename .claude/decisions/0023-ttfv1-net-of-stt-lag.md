# ADR 0023 — Gate TTFV-1 net of speech-to-text lag
Date: 2026-09-28 · Status: accepted · Amends: CLAUDE.md rule 7 and the thresholds table; ARCHITECTURE §4.4

## Context
TTFV-1 was gated at "+15% over the measured p50" (95 ms adjusted after M8, so a 110 ms bar). Across four
10-run sets on 2026-09-28, gross TTFV-1 ranged 101–178 ms adjusted with no change to the speech path:
- The new harness field showed TTFV-1 tracking Deepgram Flux's STT lag run for run (31–165 ms per-run p50).
- Head to head, the engine's partial → ops time is 0.12 ms p50 (M8: 0.10 ms).

A bar with 3–15 ms of headroom on a number dominated by a third party fails builds that changed nothing. The
user approved measuring TTFV-1 net of STT lag.

## Decision
- **TTFV-1 net** = first model or Jev op at the client − arrival at the client of the transcript that delivered
  the trigger word (`scripts/e2e/voice-accept.mts`).
- **Bar:** net p50 + 16 ms render ≤ **50 ms**. The baseline is 18 ms (2 ms + 16 ms render). +15% of 18 ms would
  be 3 ms, below measurement jitter, so the bar is an absolute floor with 32 ms of headroom for our own work.
- **Gross TTFV-1** is still reported and keeps the product target (≤ 1,000 ms p50).
- **STT lag** is reported every run (p50 and max). It's tracked, not gated: it's Deepgram's.
- Unchanged: TTFV-0 (+15%), settle, reflows and $/min.

## Consequences
+ The gate now catches regressions in what we own (gateway, lexicon, Jev, model scheduling, network back) and
  ignores Deepgram's hour-to-hour variance.
− A worse STT provider or region wouldn't fail the gate. The STT lag report is the watch for that. If STT lag p50
  exceeds 200 ms for a day, revisit ADR 0006/0008 (provider, direct vs relay).
