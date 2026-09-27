# ADR 0009 — The gateway is the only writer of the doc; the lexicon runs there (M4)
Date: 2026-09-27 · Status: accepted · Amends: ADR 0001 (client lexicon), D15 · Critique: plan-critic M3 review

## Context
ADR 0001 placed the lexicon in the browser. With the model's ops also coming from the gateway,
two writers would mutate an index-addressed JSON Patch document: a model op computed before a
provisional op lands targets the wrong index. M3 also needs undo that is exact while a job streams.

## Decision
1. **Single writer.** The gateway (`DocSession`) owns each session's doc; the browser is a replica
   that applies `doc` snapshots and `ops` batches in arrival order. `ClientMsg.provisional_ops` removed.
2. **Lexicon runs in the gateway** (pure function in `packages/dsl`) — deferred to **M4** with speculative
   jobs; M3's acceptance never used it and it is where rollback risk lives.
3. **Undo/redo** move a version pointer (monotonic versions + `parent_version`); undo/redo/new prompt
   **abort the running job first** and restore the pre-job snapshot with one `replace /root` op.
4. Every job has an intent → utterance chain (typed prompts are `utterances.source = 'typed'`).

## Latency (corrected per critique #6)
Relay mode (production today, ADR 0008): transcripts already arrive at the gateway, so the lexicon
adds **no hop**: TTFV-0 = 40 + 91 + 5 + 30 push + 60 = **226 ms**.
Direct mode: partial → gateway → ops back is a full round trip (~70–80 ms sfo↔client), so
TTFV-0 ≈ 40 + 91 + 80 + 5 + 60 = **276 ms**. Both < 400 ms.
Measured M3 header compression gain: first token → first op 321 → **276 ms (−45 ms)**, output tokens
44 → 30 per call (Mac, n = 12). The ADR 0006 estimate of −150 ms was optimistic; TTFV-1 projects to
40 + 91 + 20 + 0 + 743 + 30 + 60 = **984 ms** — under 1,000 ms with a thin margin M4 must measure.

```arch
{
  "components": [
    {"id":"client-lexicon","label":"Lexicon — provisional nodes (gateway, M4)","layer":"middleware"},
    {"id":"doc-session","label":"DocSession — single writer: doc, job controller, versions/undo","layer":"middleware"}
  ],
  "flows": [
    {"from":"@livecanvas/gateway","to":"doc-session","label":"prompt · final utterance · undo/redo"},
    {"from":"doc-session","to":"@livecanvas/web","label":"doc snapshot · ops batches (origin + jobId) · version · job"},
    {"from":"doc-session","to":"postgres","label":"intent → job → patch_ops → design_versions (async)"}
  ],
  "features": [
    {"id":"documents","label":"Design documents · versions · undo","uses":["doc-session","postgres"],"owns_tables":["design_documents","design_versions"]}
  ]
}
```
