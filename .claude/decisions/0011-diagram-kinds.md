# ADR 0011 — Three diagram kinds: Architecture, ERD, Sequence
Date: 2026-09-27 · Status: accepted · Amends: D5 (primitive set), ADR 0002 (compact refs), ADR 0010 (uncovered words per kind)

## Context
The user wants to speak software diagrams, not only phone screens: an architecture diagram that
always shows Frontend, APIs, Database and Infrastructure, an ERD, and a sequence flow. Appearance is
the top priority; unlimited flexibility is explicitly not wanted. The latency budget, single-writer
gateway and op pipeline (ADR 0001/0009/0010) must carry over unchanged.

## Decision
1. **Same pipeline, new root.** A doc's root is a `Frame` (screen) or a `Diagram {kind}`; kind ∈
   architecture | erd | sequence (closed set). Four primitives are added — `Diagram`, `Layer`, `Node`,
   `Edge` — instead of six (plan-critic: Box/Entity/Actor are one labelled `Node{kind, label, tech?,
   cols?}`). `PARENTS` enforces nesting, so screen and diagram primitives never mix; an `Edge` must
   point at two existing Nodes (the gateway prunes edges of a removed node; undo restores both).
2. **Architecture lanes are seeded and fixed**: `n_frontend` Frontend · `n_api` APIs · `n_data`
   Database · `n_infra` Infrastructure (the four-layer rule). Components live in a lane.
3. **Positions are never data.** `layoutDiagram` (packages/dsl) computes them from tree order:
   deterministic, append-stable (appending never moves anything drawn), orthogonal edge routes through
   the gaps between boxes. The model only says *what* exists and *what connects*.
4. **Two tiers still apply.** The lexicon picks a noun table by kind (tech nouns → the right lane;
   entity nouns and "`<word>` table" → tables with `id:uuid:pk`; actor nouns → participants) and
   switches kind only while the doc is blank. Relationships, columns and labels are the model's
   (one prompt per kind, same header + compact grammar; `from=`/`to=` resolve aliases to ids).
5. **Model-call triggers stay an allowlist per kind** (relationship verbs, column words, edits); a
   relationship word waits for its object (a node drawn after it, 3 words, or end of speech).
6. **Diagram re-adds fold only on an exact kind key** — the only-provisional-of-type fallback would
   have merged the model's Redis into the lexicon's Postgres (plan-critic blocker #1).
7. `new_doc {kind}` starts a blank doc of a kind as one undoable version; "start over" keeps the kind.
8. **Guided vocabulary (first step):** the studio shows a per-kind rail of the terms the lexicon
   draws instantly, plus an example sentence — steering speech toward standard terms costs 0 ms.

## Consequences
+ Screens and diagrams share one writer, one op log, one version history, one persistence path
  (no DDL: `primitives` rows are seeded from `propSchemas`).
+ Layout can be unit-tested (no overlaps, edges avoid boxes, append-stability).
− Hand-rolled layout: dense graphs (> 5 per lane row) wrap; crossing minimisation is basic. Revisit
  with ELK only if measured ugly — ELK is async and not append-stable.
− Each kind has its own static prompt prefix: the first call after a switch misses the prompt cache.

## Result (2026-09-27, Railway + Haiku)
- Live typed prompt per kind (`scripts/e2e/diagram-live.mts`), 2 runs: **6/6 pass**. First op
  693–903 ms; architecture 6 nodes / 5 edges, ERD 4 tables / 3 relations, sequence 4 participants /
  5 messages; 0 invalid ops; 770–1,020 input tokens per call.
- First live run failed sequence (0 nodes): Haiku echoed `?provisional` from the example, the expander
  rejected every `+Node`, and edge pruning silently ate the orphan messages. Fixed: expander ignores
  `?flags`, pruning applies only to pre-existing edges, prompts say "never write ?provisional".
- Screen regression (`voice-accept.mts`, 10 runs): **10/10**, TTFV-1 p50 817 ms adj. (bar 870),
  settle 746 ms, 1 reflow, 9.6 calls/min, $0.0113/min (`docs/m5/2026-09-27-screen-regression.json`).

```arch
{
  "components": [
    {"id":"diagram-layout","label":"layoutDiagram","layer":"frontend","note":"ADR 0011: positions from tree order"},
    {"id":"diagram-canvas","label":"DiagramCanvas","layer":"frontend","note":"arch lanes · ERD · sequence"}
  ],
  "flows": [
    {"from":"diagram-layout","to":"diagram-canvas","label":"rects + edge routes"}
  ],
  "features": [
    {"id":"diagrams","label":"Spoken diagrams: Architecture · ERD · Sequence","components":["diagram-canvas","diagram-layout","doc-session","client-lexicon"]}
  ],
  "notes": [
    {"on":"doc-session","text":"ADR 0011: per-kind prompt + allowlist; exact-key folds for diagram nodes"}
  ]
}
```
