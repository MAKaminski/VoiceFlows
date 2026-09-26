# Intent Engine — the core of "design before you stop talking"

## Problem
Rendering on every STT partial causes flicker and burns tokens. Waiting for the final
transcript loses the magic. The engine sits between them.

## Algorithm (per session)
```
on partial(text, t):
  buffer.text = text
  if now - last_extract < EXTRACT_MIN_GAP_MS (250): schedule trailing extract; return
  extract()

extract():
  intent = haiku(prompts/intent_system.md, doc_summary, buffer.text)   # streaming, JSON
  delta = score(intent, committed_intent)
  if delta >= COMMIT_THRESHOLD (0.35)
     or (pause_detected and delta > 0)          # VAD silence >= 350 ms
     or intent.explicit_command:                # "undo", "start over", "make it blue"
       commit(intent)

commit(intent):
  job_controller.abort_active()
  path = intent.structural ? "sonnet" : "haiku"
  patch_engine.run(intent, path)
  committed_intent = intent

on final(text):
  extract(); settle pass once; create DESIGN_VERSION
```

## Intent shape (zod in packages/dsl)
```json
{
  "action": "add|modify|remove|restyle|layout|undo|reset|none",
  "targets": [{"ref": "node id or description", "primitive": "Button"}],
  "attributes": {"color": "primary", "size": "lg", "label": "Sign in"},
  "structural": false,
  "explicit_command": false,
  "confidence": 0.0
}
```

## Delta score
Weighted sum, each term 0–1:
| Term | Weight |
|---|---|
| action changed | 0.35 |
| new/removed target | 0.30 |
| attribute set changed (Jaccard distance) | 0.20 |
| structural flag flipped | 0.15 |

Commit only when `confidence >= 0.6`, except explicit commands (always commit).

## Speculative generation
A committed job starts immediately even though the sentence continues. If a newer commit
arrives, the old job is aborted (AbortController on the HTTP stream) and its
already-applied ops are **kept** only if they still validate against the new intent;
otherwise they are rolled back with inverse patches. Target: <3 visible reflows per element
per utterance (tracked as LATENCY_EVENTS stage `reflow`).

## Tunables (env)
`EXTRACT_MIN_GAP_MS=250 COMMIT_THRESHOLD=0.35 PAUSE_MS=350 MIN_CONFIDENCE=0.6`
Expose all four in the dev Latency HUD with live sliders.
