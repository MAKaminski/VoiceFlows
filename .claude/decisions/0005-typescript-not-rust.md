# ADR 0005 — Keep TypeScript; Rust only behind a measured trigger
Date: 2026-09-26 · Status: accepted

## Context
Owner is open to switching to Rust for speed. Where the time goes (estimates, ADR 0001):
- TTFV-0 = 355 ms: 290 ms network + STT, 60 ms browser render, **5 ms** lexicon. The lexicon
  and render run in the browser, which is JS (or WASM) regardless of the server language.
- TTFV-1 = 995 ms: 520 ms model (TTFT + output tokens), 290 ms network + STT, 75 ms gap wait,
  110 ms push + render. Gateway CPU per op (expand + zod validate + apply + serialize) is
  estimated at ≤ 1 ms in Node.
- Best case Rust saves ≤ 1 ms of ~995 ms = **≤ 0.1%** of TTFV-1, and 0 ms of TTFV-0.

## Decision
Stay on TypeScript end to end (one `packages/dsl` shared by browser and gateway, so the
lexicon, schemas and expander exist exactly once). Re-open only if M4 profiling shows either:
- gateway self-time > 20 ms p95 per TTFV-1 (2% of budget), or
- Node GC pause p99 > 10 ms under the load test, or
- gateway cost > $0.005 per speaking minute (≈ 11% of the $0.046 budget).
If triggered, port only the hot path (compact expander + applier) to Rust via napi-rs,
keeping the TypeScript contracts as the source of truth.

## Consequences
No second language, no duplicated schemas. The latency levers stay where the time is:
STT partial cadence, model output tokens, and call scheduling.

```arch
{
  "notes": [
    {"on":"@livecanvas/gateway","text":"TypeScript; Rust hot path only if self-time > 20 ms p95 (ADR 0005)"}
  ]
}
```
