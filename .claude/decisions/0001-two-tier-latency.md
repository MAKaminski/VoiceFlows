# ADR 0001 — Two-tier response (lexicon + model)
Date: 2026-09-26 · Status: accepted · Amends: D7, D8 · Adds: D15

## Context
Success metric is "Claude-voice-grade" latency. Package budget was p50 TTFV 1,175 ms
(40 + 250 + 125 + 350 + 350 + 60). STT partial alone is ~250 ms; Haiku first closed op ≥ 500 ms.

## Decision
- TTFV-0 (optimistic, client lexicon): 40 + 250 + 5 + 60 = 355 ms est., target ≤ 400 ms p50.
- TTFV-1 (model quality, fused header-first): 40 + 250 + 20 + 75 + 350 + 170 + 30 + 60 = 995 ms est.,
  target ≤ 1,000 ms p50.
- Lexicon rules: create on first mention of a noun (dedupe by alias); never set position; hold
  modifiers until a noun arrives; provisional nodes exempt from abort rollback; model edits them
  in place.
- One model call in flight per session; only an intent-delta commit aborts it.

## Consequences
Schema: `intents.path` gains `'lexicon'` (delta_score = 1.0); lexicon jobs use `model='lexicon'`;
`latency_events.utterance_id` added for pre-job stages. M0 latency spike replaces estimates.

```arch
{
  "components": [
    {"id":"client-lexicon","label":"Client lexicon — TTFV-0 provisional nodes","layer":"frontend"},
    {"id":"fused-engine","label":"Fused intent+patch engine — header-first, single in-flight","layer":"middleware"}
  ],
  "flows": [
    {"from":"client-lexicon","to":"@livecanvas/web","label":"provisional ops (≤ 5 ms)"},
    {"from":"@livecanvas/gateway","to":"fused-engine","label":"partial (≥ 150 ms gap, new content word)"},
    {"from":"fused-engine","to":"anthropic","label":"1 call in flight"}
  ],
  "features": [
    {"id":"latency","label":"Latency telemetry & HUD","uses":["@livecanvas/web","@livecanvas/gateway"],"owns_tables":["latency_events"]}
  ],
  "notes": [
    {"on":"client-lexicon","text":"TTFV-0 target ≤ 400 ms p50"},
    {"on":"fused-engine","text":"TTFV-1 target ≤ 1,000 ms p50"}
  ]
}
```
