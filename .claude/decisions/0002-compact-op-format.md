# ADR 0002 — Compact op wire format
Date: 2026-09-26 · Status: accepted · Clarifies: D4

Model emits one compact line per op; `packages/dsl/src/compact.ts` expands each to RFC 6902
before zod validation, storage (PATCH_OPS) and fan-out. Grammar:
- `+<Type> <alias> ><parentRef> [k=v ...] ["text"]` → add (parentRef = `root` | node id | alias)
- `~<ref> k=v ... ["text"]` → replace props
- `-<ref>` → remove
- `^<ref> ><parentRef> [@index]` → move
Values are tokens or bare words; one quoted string maps to the primitive's primary text prop.
Header line (fused path) is JSON: `{"a":"add","t":"Button","c":0.8,"s":false}`.

```arch
{
  "components": [
    {"id":"compact-expander","label":"Compact op expander → RFC 6902 (packages/dsl)","layer":"middleware"}
  ],
  "flows": [
    {"from":"anthropic","to":"compact-expander","label":"compact lines (~3× fewer tokens)"},
    {"from":"compact-expander","to":"@livecanvas/gateway","label":"validated RFC 6902 ops"}
  ]
}
```
