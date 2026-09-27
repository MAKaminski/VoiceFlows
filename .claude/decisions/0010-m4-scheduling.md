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

## Browser cross-check (headless Chrome, fake mic, local prod build vs Railway) — findings fixed
The Node harness passed while the browser exposed five real bugs, all fixed and regression-tested:
1. Status line wrapped and pushed the whole canvas (every node "reflowed"): fixed-height line; reflows
   now measured relative to the phone frame.
2. Duplicate Button: Flux ended the turn mid-sentence, so the model's `+Button signin` had no provisional
   target → fold into any lexicon-drawn node the model hasn't edited yet (session-wide).
3. Flux revisions ("sign and" → "sign in") re-drew nodes → lexicon dedupe by occurrence key (`button#1`).
4. First words lost: the gateway dropped audio that arrived while the relay was connecting (and the
   browser opened the mic only after the handshakes) → browser buffers from the click, gateway queues
   until Flux is open (race-free: queue exists before any await).
5. "<name> screen" now draws the title first, so the model's title folds in instead of pushing inputs.
Plus: hedged model requests (second identical call if no first line after 600 ms) for tail latency.

## Result
Node relay harness vs Railway sfo + Flux + Haiku, 10 runs (`docs/m4/2026-09-27-acceptance-railway.json`):
**9/10 pass** · TTFV-0 p50 −192 ms adj. · TTFV-1 p50 **756 ms** adj. · settle p50 **697 ms** · max reflows 1 ·
9.6 calls/min · **$0.0111/speaking min**. The one fail: TTFV-1 1,002 ms raw (bar 944). Hedge fired on 2/10
calls and the primary won both — this run's gain is mostly lower model latency, not the hedge.
Headless browser, 3 runs (pre-hedge build): layout correct 3/3, on-screen reflows 1, TTFV-0 168–620 ms,
TTFV-1 862–1,349 ms, settle 692–1,309 ms — browser TTFV-1 runs ~150–250 ms above the harness.

```arch
{
  "notes": [
    {"on":"doc-session","text":"M4: 9/10 · 1 model call/utterance · TTFV-1 756 ms · settle 697 ms · $0.0111/min"},
    {"on":"client-lexicon","text":"M4: draws before the word ends in the harness; 168–620 ms on screen"}
  ]
}
```
