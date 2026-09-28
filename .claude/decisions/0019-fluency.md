# ADR 0019 — Fluency: open vocabulary at the end of a sentence, colours as tokens, a corpus that proves it
Date: 2026-09-28 · Status: accepted · Supersedes: ADR 0011 §5 ("model-call triggers stay an allowlist per kind") · Amends: ADR 0017 (fan-out pairs), ADR 0002 (colour tokens)

## Context
The user's first free-form session on production (2026-09-28): "when it worked, it worked well, but it didn't
always work". It failed on connectors ("rights to"), growing the ERD, and colours ("pink", "orange" did nothing).
Root causes, from the code:
1. **The model was only called for allowlisted words.** "pink", "background", "rights", "priority" and "phone"
   never started a job. "make the button pink" called on "make the button" before "pink" arrived, and never again.
2. **Pink and orange did not exist.** `ColorToken` had six semantic tokens; the lexicon knew six colour words.
3. **Flux writes "rights to" for "writes to".**
4. **Relations spoken as lists** ("the api and the worker both write to postgres") only asked adjacent pairs.
5. **A relation word sent before its object was spoken was never asked again.** "the api reads from redis and
   postgres" connected redis, and postgres was silently dropped.
6. **A prefix noun blocked the full name.** "api" was drawn before "gateway" arrived.
7. **Hedged model client deadlock.** When the reader stopped early ("none 0"), the client awaited the unread
   stream's usage, which never settles on a suspended generator. That job, and every later model call in the
   session, hung. Latent since M4; open vocabulary makes "none" replies common.

## Decision
1. **Open vocabulary at the end of a sentence** (flag `open_vocabulary`, default on). While speaking, calls stay
   gated by the per-kind allowlist; the allowlist gains colours, restyle verbs, inflections and "rights". At
   (eager) end of turn, any word that is not filler, not understood by the lexicon/Jev, and not part of a label
   already on the view gets **one** call. Label phrases the lexicon read ("login", "sign in", "sign and") are
   consumed with their noun, so the definition-of-done sentence still makes no model call.
2. **Speech timing rules.**
   - Screen verbs and references wait for their object: 3 words, or the end of the sentence. A move waits for
     its destination.
   - A word whose call changed nothing is retried once at the end with the whole sentence.
   - A diagram relation word is re-asked at the end if a component was named after it was sent.
   - A provisional diagram node is renamed when a longer name completes: "api" becomes "API gateway".
3. **Colours are tokens.** `pink orange yellow green teal` join `ColorToken`; about 30 spoken colour names map
   onto them. `Card.fill` is added, and `Frame.fill` is the background. Buttons on light fills get dark text.
   **Forward-only:** a doc holding a new token will not parse on an older gateway or web build. `PROTOCOL = 2`
   in `welcome`; a tab built for an older protocol reloads once.
4. **Speech repair** (`fixSpeech`, a small explicit table). Jev and the model read the repaired sentence
   ("rights to" → "writes to"). The raw transcript and its word keys (highlighting) are never rewritten.
5. **Fan-out pairs** (Jev). Mentions joined by and/or/both form a group; adjacent groups ask every cross pair.
   The label comes from the verb between the groups. A fan-out pair's "none", and any unsure answer, is left
   to the model.
6. **A named system is itself.** Only generic nouns ("the app", "the database") refer back to an existing
   element. "the genesys bot" next to Genesys is a new component.
7. **Forced calls are charged to the bucket.** The bucket may go into debt, capped at the burst size, so the
   long-run rate stays at 20 calls/min.
8. **The hedged client closes both inner streams before awaiting usage.**
9. **The fluency corpus is the regression bar.** `scripts/corpus/cases.ts` holds 74 cases (73 scored, 1 known
   blind spot) in the way people talk, across all four views, and has two runners:
   - offline (`apps/gateway/test/corpus.test.ts`, CI) checks the engine: every word that needs the model
     reaches it, instant cases make no call, one version per sentence;
   - live (`scripts/e2e/corpus-live.mts`) scores the finished design. **Bar: ≥ 90% of cases.**

## Consequences
+ **Production (Railway, 2026-09-28): 73/73 scored cases (100%)**: screen 24/24, architecture 23/23,
  ERD 18/18, sequence 8/8; settle p50 794 ms (from the final partial); 88 model calls, $0.095 for the corpus.
  Locally, the first run (before fixes 2–8) scored 62/73.
+ DoD acceptance after deploy (10 runs, real audio): 10/10, TTFV-1 p50 85 ms adj. (was 112), settle p50 670 ms
  (was 695), $0/min.
+ The DoD sentence is unchanged: no model call, one version (offline test asserts both spellings).
− Free speech costs more: at most one extra call per sentence. Worst case is the bucket cap,
  20 × $0.00116 = $0.023/min, under the $0.046 target. The DoD acceptance is $0 and unaffected.
− The live corpus sends text partials, which skip Flux's revisions and its ~685 ms end-of-turn. Its pass rate
  is an upper bound, and its settle is measured from the final partial. `voice-accept.mts` (real audio) stays
  the DoD gate.
− Colour tokens are a one-way door (3 above).

```arch
{
  "components": [
    {"id":"fluency-corpus","label":"Fluency corpus (74 cases)","layer":"infrastructure","note":"ADR 0019: offline engine checks + live scoring, bar ≥ 90%"}
  ],
  "flows": [
    {"from":"fluency-corpus","to":"doc-session","label":"streams cases as partials, scores the design"}
  ],
  "features": [
    {"id":"open-vocabulary","label":"Speak freely (open vocabulary)","components":["doc-session","jev-decisions"]}
  ]
}
```
