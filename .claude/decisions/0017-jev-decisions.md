# ADR 0017 — Jev decides structure; the model only writes new text
Date: 2026-09-27 · Status: accepted · Amends: ADR 0010 (a voice job may finish without a model call), ADR 0001 (a third tier between lexicon and model)

## Context
After the lexicon draws the nouns (~0 ms), the remaining ~600 ms of TTFV-1 is waiting for Haiku, which
mostly makes *choices*: which two components connect and in which direction, sync or async,
one-to-many or one-to-one, request or reply, "logo on top". TypeSafe Jev is a typed-decision model
(Choice / Noul / Score, one forward pass, calibrated confidence, cannot write text).
Bake-off from Railway sfo (`apps/gateway/src/bench/jev.ts`, `docs/m6/`): Jev p50 90 ms / p95 146 ms,
97.9 % correct, 100 % correct when confidence ≥ 0.8 (85 % of decisions); Haiku on the same questions
p50 722 ms, 95.1 %; Jev ≈ $0.00004 per call vs $0.00067.

## Decision
1. **Phase 0 of every voice job is one Jev request** (flag `jev_decisions`; no `TYPESAFE_API_KEY` → as
   before). Questions come from the active view: one **3-way Choice per adjacent pair** of mentioned
   components (a→b, b→a, none) + sync/async, cardinality or request/reply; on the screen, target +
   position for "on top/bottom". The adjacent-pair format was re-measured with multi-clause, passive and
   negative sentences before building (plan-critic).
2. **Confident answers (≥ 0.8) become ordinary compact op lines** — the lines Haiku would write — and go
   through the same expand → enforceEdits → applyValidated path (validation, folds, versions, rollback
   shared), emitted with op origin `jev`. Labels come from the user's own words between the two
   mentions (passive "is read by" → "read"); ERD adds the foreign-key column on the many side.
3. **The model runs only for what Jev didn't settle**: low-confidence answers, and anything needing new
   text (column names, copy, labels the user didn't say). If every word that started the job is covered,
   the job finishes with no model call. Jev failure or > 250 ms (`JEV_TIMEOUT_MS`) → model, nothing lost.
4. **One connection per pair**: a second Edge between the same two components folds into an update of
   the first (the model's label wins); in sequence diagrams only the job's own edges fold, since messages
   may repeat.
5. Jev calls don't spend the model call bucket; its cost (~$0.00004) isn't added to the HUD's $.
   Intents log `path='jev'` (migration 004).

## Consequences
+ The definition-of-done sentence needs no model call at all ("logo on top" is a Jev move).
+ Connections appear ~90 ms after the second component is named instead of ~600 ms.
− Jev is 12 days old (launched 2026-09-15); a timeout or outage costs ≤ 250 ms before the model takes over.
− Non-adjacent relations ("the api and the worker both write to postgres") still go to the model.

```arch
{
  "components": [
    {"id":"jev-decisions","label":"Jev decisions (phase 0)","layer":"middleware","note":"ADR 0017: typed choices → compact ops; model only for text"}
  ],
  "flows": [
    {"from":"doc-session","to":"jev-decisions","label":"adjacent-pair questions (~90 ms)"},
    {"from":"jev-decisions","to":"doc-session","label":"confident answers → ops"}
  ],
  "features": [
    {"id":"jev-decisions-feature","label":"Jev decisions","components":["jev-decisions","doc-session"]}
  ]
}
```
