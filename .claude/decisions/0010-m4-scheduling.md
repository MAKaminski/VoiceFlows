# ADR 0010 — M4 scheduling: call the model only for what the lexicon can't draw
Date: 2026-09-27 · Status: accepted · Amends: ADR 0001 (header gate dropped), ADR 0006, D7a · Data: `docs/m4/`

## Context
First M4 runs (5 model calls per 6.2 s utterance) missed settle (~3 s) and cost (48 calls/min,
$0.048/min). The timeline showed calls spent on words the lexicon had already drawn (email,
password, button), the budget empty when "logo on top" arrived, and settle waiting for Flux's
definite end of turn. Separately, Haiku ignored "edit provisional nodes in place" in 2/3 samples:
it rebuilt the screen in a Card and deleted the provisional nodes.

## Decision
1. **Model calls only for uncovered content words** — positions, edits of existing elements,
   structure. Words the lexicon turned into nodes (and the modifiers attached to them) never trigger
   a call; a held modifier counts only after 4 words without a noun or at end of speech.
2. **Header gate dropped** (plan critique): cost cap = token bucket 20/min, burst 2, every started
   call counted; the end-of-utterance call may overdraw by one.
3. **Settle on Flux `EagerEndOfTurn`** (threshold 0.4): commit at once when nothing is uncovered,
   else one forced call then commit — ONE version per utterance. `TurnResumed` reopens the utterance.
4. **The gateway enforces edit-in-place**: a model re-add of an existing element (same kind key, or
   the only provisional node of that type) becomes update + move to the requested parent (a Card
   wrap still happens, without duplicates); removing a provisional or folded node is dropped.
5. Structural deferral removed (with ≤ 2 calls per utterance it saved nothing).

## Result (Node relay harness vs Railway sfo + real Flux + Haiku, 10 runs, `docs/m4/`)
8/10 pass. TTFV-0 p50 −38 ms adjusted (lexicon draws before the word ends), TTFV-1 p50 906 ms,
settle p50 839 ms, max reflows 1, 9.6 calls/min, $0.0129 per speaking minute. Both failures:
TTFV-1 1,070 / 1,100 ms raw (model latency variance).
Adjusted = network arrival + 40 ms capture + 16 ms render (estimates; a browser run confirms).

```arch
{
  "notes": [
    {"on":"doc-session","text":"M4: 1 model call/utterance · TTFV-1 906 ms · settle 839 ms · $0.0129/min"},
    {"on":"client-lexicon","text":"M4: draws before the word ends (TTFV-0 −38 ms p50)"}
  ]
}
```
