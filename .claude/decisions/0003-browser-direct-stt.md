# ADR 0003 — Browser connects directly to Deepgram
Date: 2026-09-26 · Status: accepted · Amends: D6

Gateway exposes `POST /stt/token` (short-lived Deepgram token, minted at session open).
Browser streams 16 kHz PCM straight to Deepgram, runs the lexicon on partials, and forwards
partials + provisional ops to the gateway over the session WS. Web Speech fallback unchanged.
Trade-off: the gateway no longer sees raw audio (no server-side VAD) — pause detection uses
Deepgram `vad_events`/`speech_final` relayed by the client.

```arch
{
  "components": [
    {"id":"deepgram","label":"Deepgram Nova-3 streaming STT","layer":"middleware"}
  ],
  "flows": [
    {"from":"@livecanvas/gateway","to":"@livecanvas/web","label":"short-lived STT token"},
    {"from":"@livecanvas/web","to":"deepgram","label":"16 kHz PCM, 20 ms frames"},
    {"from":"deepgram","to":"client-lexicon","label":"interim partials"}
  ]
}
```
