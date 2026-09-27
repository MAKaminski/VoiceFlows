# ADR 0007 — Speech-to-text: Deepgram Flux (flux-general-en)
Date: 2026-09-26 · Status: accepted · Amends: D6, ADR 0003 · Data: `docs/m2/*.json`

## Context
M0 showed Nova-3 interim results every ~980 ms (502 ms word lag p50), which blocked TTFV-0.
The M2 bake-off (`apps/gateway/src/bench/bakeoff.ts`) streams the same WAV in real time and
scores every provider against one ground-truth alignment (`scripts/fixtures/dod.words.json`),
10 runs × 15 words, from Railway sfo and from the owner's Mac. Pass bar: word lag ≤ 295 ms
p50 at ≤ $0.0077/min.

| Provider | Where | Word lag p50 / p95 | Update interval | Price/min | Result |
|---|---|---|---|---|---|
| Deepgram Nova-3 | sfo | 397 / 838 ms | 982 ms | $0.0077 | fail |
| Deepgram Nova-3 | Mac | 433 / 895 ms | 979 ms | $0.0077 | fail |
| **Deepgram Flux** | sfo | **91 / 411 ms** | **240 ms** | $0.0077 | **pass** |
| **Deepgram Flux** | Mac | **51 / 372 ms** | **240 ms** | $0.0077 | **pass** |
| Soniox, AssemblyAI, ElevenLabs | — | not run (no keys) | — | $0.0020 / $0.0025 / $0.0065 | adapters ready |
| Chrome Web Speech | — | not measurable with injected audio | — | $0 | dev fallback only |

Flux shows ~30% of words *before* their ground-truth end (it decodes partial words), which is
what "draw it before you finish the sentence" needs. Both models miss "in" in the synthetic
voice's "sign-in" (heard as "sign and").

## Decision
Use **Deepgram Flux** (`wss://api.deepgram.com/v2/listen?model=flux-general-en`, 80 ms chunks,
`TurnInfo` Update/EndOfTurn events) as the default STT. Same vendor and key, same list price.
Flux's `EagerEndOfTurn`/`EndOfTurn` replace our own pause detection (PAUSE_MS) as the settle signal.

## Consequences
- TTFV-0 projects to 40 + 91 + 5 + 60 = **196 ms** (target 400 ✅).
- TTFV-1 projects to **1,104 ms** with Flux alone and **879 ms** with the header compression and
  lexicon-triggered call from ADR 0006 — both levers are required to meet 1,000 ms.
- Browser→Flux auth on `/v2` (subprotocol or `/v1/auth/grant` JWT) is unverified; the M2 capture
  build must prove it before the gateway token endpoint is final.
- Cost option, not needed for latency: Soniox at $0.0020/min would save $0.0057 per speaking minute
  (18% of $0.0313; $1.14/user/month at the 200-minute cap). Test when a key is available.

```arch
{
  "components": [
    {"id":"deepgram","label":"Deepgram Flux streaming STT (flux-general-en)","layer":"middleware"}
  ],
  "notes": [
    {"on":"deepgram","text":"M2 bake-off: word lag 91 ms p50 (sfo), update every 240 ms — ADR 0007"}
  ]
}
```
