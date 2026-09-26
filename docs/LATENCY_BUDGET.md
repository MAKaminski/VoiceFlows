# Latency budget

Metric that matters: **TTFV** — time from the spoken words that justify a change to the
first visible canvas change.

| Hop | Budget (p50) | Budget (p95) | Notes |
|---|---|---|---|
| Mic frame → gateway | 40 ms | 80 ms | 20 ms frames, WS, same region |
| STT interim partial | 250 ms | 450 ms | provider interim results |
| Extract gap / debounce | 125 ms | 250 ms | avg half of 250 ms gap |
| Intent model first token + JSON close | 350 ms | 650 ms | tiny prompt, small JSON |
| Patch model first op closes | 350 ms | 700 ms | op streamed, applied on close |
| Apply + WS push + React render | 60 ms | 120 ms | per-node memo |
| **TTFV total** | **~1.18 s** | **~2.25 s** | target p50 ≤ 1.2 s |
| Settle after stop speaking | ≤ 1.5 s | ≤ 2.5 s | final + settle pass |

Math: 40 + 250 + 125 + 350 + 350 + 60 = 1,175 ms p50.
Biggest lever: fusing intent + patch into one call for non-structural edits removes one
~350 ms model hop (≈30% of TTFV). Implement behind `FUSED_FAST_PATH` in M4 and A/B it.
These are targets to measure against, not guarantees — M4 replaces them with observed values.

## Instrumentation
Write a LATENCY_EVENTS row per stage: `frame_rx, partial, extract_start, intent_ready,
commit, first_op, first_render, final, settled, reflow`. Client reports `first_render`
back over WS. Dev HUD shows rolling p50/p95.

## Cost model (plug in current Anthropic pricing)
Per spoken minute, assuming 1 extract / 0.5 s of speech and 1 commit / 3 s:
- Intent calls: 120 × (~900 in + ~120 out) = 108k in / 14.4k out tokens
- Patch calls: 20 × (~2,500 in + ~400 out) = 50k in / 8k out tokens
- Total ≈ 158k input + 22.4k output tokens per minute; input is ~88% of volume, so
  **prompt caching on the static prefix is mandatory**.
Log per-job tokens in GENERATION_JOBS and show $/minute in the HUD.
