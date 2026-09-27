# ADR 0006 — M0 findings: STT is the bottleneck; header, trigger and settle changes
Date: 2026-09-26 · Status: accepted · Amends: ADR 0001, 0002, D8 · Data: `docs/LATENCY_BUDGET.md`, `docs/m0/*.json`

## Context
M0 ran the spike from Railway sfo and from the owner's Mac. Measured p50: TTFV-0 607 ms
(target 400), TTFV-1 1,515 ms (target 1,000), cost $0.0313 per speaking minute (budget $0.046).
Deepgram Nova-3's interim partials arrive every ~979 ms, giving a 502 ms word-end → partial lag.
Haiku first valid op: 788 ms (compact) vs 878 ms (JSON Patch). Sonnet 5 first op: 2,232 ms,
88% op validity. Prompt cache tokens: 0.

## Decision
1. **M2 opens with an STT bake-off** using `spike.ts`, pass bar = word lag ≤ 295 ms p50 at
   ≤ $0.0077/min. Candidates: Chrome Web Speech (free), Deepgram with any lower-latency
   option it offers, and other streaming STT providers. The D6 adapter makes it a config swap.
2. **Compact format confirmed** (ADR 0002); add-at-index `+Type alias >parent … @i` added.
3. **Header compressed** to the fewest tokens that still carry action + confidence (≈ 150 ms).
4. **Trigger on the lexicon's content-word event** when no call is in flight (−75 ms gap wait).
5. **Settle pass uses Haiku**; Sonnet only for explicit reset / structural rebuilds, run in the
   background, never on the TTFV path (D8 amended).
6. **Prompt caching is not a latency lever** at this prefix size; keep the connection warm-up only.
7. **Region stays sfo** for now (Deepgram connect 24 ms, Haiku first op 788 ms from sfo). D14's
   US-East is not re-litigated until users' locations are known.

## Consequences
TTFV-1 projects to 1,290 ms with Deepgram and to 988 ms with a ≤ 200 ms STT. The latency targets
stay; the STT choice is now the gating decision for M2. Cost headroom (−32%) raises the managed
plan's worst-case margin at the 200-minute cap from 46% to 60%.

```arch
{
  "notes": [
        {"on":"fused-engine","text":"M0: first op 788 ms p50, 100% valid, $0.001/call"}
  ]
}
```
