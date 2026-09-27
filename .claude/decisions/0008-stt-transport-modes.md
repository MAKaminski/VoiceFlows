# ADR 0008 — STT transport: direct, relay, or Web Speech, chosen by the gateway
Date: 2026-09-26 · Status: accepted · Amends: ADR 0003

## Context
ADR 0003 chose browser → Deepgram direct. In M2 the configured Deepgram key returned
`403 Insufficient permissions` on `/v1/auth/grant`, so the browser cannot get a short-lived token,
and shipping the raw key to the browser is not acceptable.

## Decision
`POST /stt/token` returns one of three modes (`SttGrant` in packages/dsl):
- **direct** — the key can mint grants: browser → Flux with `["bearer", jwt]` (preferred, no extra hop).
- **relay** — it cannot: browser sends 80 ms PCM frames over the session WS; the gateway streams them
  to Flux (`apps/gateway/src/stt/providers.ts`) and returns `transcript` messages. Key stays server-side.
- **webspeech** — no key configured: browser Web Speech API (Chrome/Edge only; not Brave).
A 401/403 from the grant endpoint is cached so the gateway stops asking. A Member-role Deepgram key
switches production to direct with no code change.

## Consequences
Measured in a real browser (fake-mic Chrome, relay via Railway sfo): word lag **136 ms p50,
457 ms p95**, recall 93% (2 valid runs, 28 words) — passes M2's < 500 ms bar even with the extra hop.
Direct-mode browser auth (`bearer` subprotocol on `/v2`) is still unverified until a grant-capable key exists.

```arch
{
  "flows": [
    {"from":"@livecanvas/web","to":"@livecanvas/gateway","label":"relay: 80 ms PCM frames (binary WS)"},
    {"from":"@livecanvas/gateway","to":"deepgram","label":"relay stream"}
  ],
  "notes": [
    {"on":"@livecanvas/gateway","text":"POST /stt/token → direct | relay | webspeech (ADR 0008)"}
  ]
}
```
