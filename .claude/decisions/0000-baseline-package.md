# ADR 0000 — Baseline: adopt the LiveCanvas package decisions D1–D14
Date: 2026-09-26 · Status: accepted

Adopts `docs/DECISIONS.md` D1–D14 as delivered in `livecanvas-claude-code-package.zip`:
standalone canvas, DesignDoc → React, RFC 6902 edits, 12 primitives + tokens, streaming STT,
Haiku/Sonnet split, Postgres system of record + Redis live state, Vercel web + Railway gateway.
Later ADRs amend individual decisions; this block declares the baseline shape.

```arch
{
  "components": [
    {"id":"anthropic","label":"Anthropic Messages API (Haiku 4.5 · Sonnet 5)","layer":"middleware"},
    {"id":"postgres","label":"Postgres 16 — system of record","layer":"backend"},
    {"id":"redis","label":"Redis 7 — live doc · active job · pub/sub","layer":"backend"},
    {"id":"vercel","label":"Vercel — hosts web","layer":"infrastructure"},
    {"id":"railway","label":"Railway US-East — gateway · Postgres · Redis","layer":"infrastructure"}
  ],
  "flows": [
    {"from":"@livecanvas/web","to":"@livecanvas/gateway","label":"WS: partials · provisional ops · first_render"},
    {"from":"@livecanvas/gateway","to":"@livecanvas/web","label":"WS: ops · rollback · status"},
    {"from":"@livecanvas/gateway","to":"anthropic","label":"streamed generation"},
    {"from":"@livecanvas/gateway","to":"redis","label":"apply op to live doc"},
    {"from":"@livecanvas/gateway","to":"postgres","label":"batched persistence (off hot path)"},
    {"from":"vercel","to":"@livecanvas/web","label":"serves"},
    {"from":"railway","to":"@livecanvas/gateway","label":"runs (min 1 replica)"}
  ],
  "features": [
    {"id":"voice-design","label":"Live voice design session","uses":["@livecanvas/web","@livecanvas/gateway","anthropic","redis"],"owns_tables":["sessions","utterances","transcript_segments","intents","generation_jobs","patch_ops"]},
    {"id":"documents","label":"Design documents · versions · undo","uses":["@livecanvas/gateway","postgres"],"owns_tables":["design_documents","design_versions"]},
    {"id":"vocabulary","label":"Component vocabulary & themes","uses":["@livecanvas/dsl"],"owns_tables":["primitives","token_sets"]},
    {"id":"accounts","label":"Accounts (magic link)","uses":["@livecanvas/gateway","redis","postgres"],"owns_tables":["users"]},
    {"id":"export","label":"Export — React · HTML · PNG · URL (M6)","uses":["@livecanvas/gateway"],"owns_tables":["exports"]}
  ]
}
```
