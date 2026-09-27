# ADR 0012 — Feature flags, usage measurement, admin screen, user vocabulary
Date: 2026-09-27 · Status: accepted · Amends: ADR 0011 (keyword rail), D16 (what we meter)

## Context
Every feature must sit behind a flag — nothing is "free use" — and we must measure what people use.
An admin screen turns features on and off. The first two features: speak-to-create, and add
vocabulary: users see the words each diagram kind understands and add their own ("kafka" → a
queue), by UI or by voice with an explicit confirm. Constraints: minimal, zero latency cost, no
obscure logic.

## Decision
1. **Registry** `FEATURES` in `packages/dsl/src/features.ts` (key → default, description), seeded into
   `feature_flags` by migrate (new keys get their default; an admin's choice is never overwritten).
   Keys: speak_to_create, diagram_architecture/erd/sequence, vocabulary_rail, custom_vocabulary,
   diagram_metrics (off — teaser for duration/throughput on edges).
2. **The gateway enforces**, the UI only hides. A disabled feature's message returns an `error` and a
   `blocked` event. Flags are cached in memory (a property lookup on the hot path); one replica.
3. **Usage** = `feature_events` rows (exposed once per session per enabled flag; used at utterance
   commit, typed prompt, new diagram, word define/confirm; blocked on refusal), written through the
   per-session persistence queue — never awaited.
4. **Admin API** `GET /admin/flags` (flags + 7-day counts), `PUT /admin/flags/:key`: bearer
   `ADMIN_TOKEN` compared as SHA-256 digests with `timingSafeEqual`, 10 failures / 10 min per IP →
   429, every flip logged, flips broadcast to open sockets as `flags`. CORS for `/admin` answers only
   `ADMIN_ORIGINS` (production web + localhost), never the preview-deploy pattern. `/admin` web page is
   `noindex`; the token lives in that tab's sessionStorage only.
5. **Vocabulary** `vocabulary_terms`, scoped to a **document** (every visitor is the anonymous user
   until accounts), max 50 per document. Confirmed terms are checked before built-in nouns, so a
   user's word wins. UI "+ Add word" is confirmed on click; voice is deterministic and model-free:
   "define/treat X as (a) Y" at the START of an utterance (Y ∈ kind words: queue, database, service,
   external, table, user, …) proposes; "confirm" / "lock it in" confirms. The whole command utterance
   draws nothing and calls no model (plan-critic M5b #1). The typed and spoken paths share
   `parseDefine`.
6. **Explainability**: every rail chip's tooltip is the rule itself ("draws “Postgres” · Database lane").

## Consequences
+ Adding a feature = one registry line + a `permit(key)` at its entry point + a `used` event.
+ Zero hot-path cost: flag reads are in-memory; events are queued.
− Global flags only (no per-user or percentage rollout) until accounts exist.
− Single-replica assumption for flag flips (documented; reload on a TTL if we scale out).

```arch
{
  "components": [
    {"id":"flag-service","label":"FlagService","layer":"middleware","note":"ADR 0012: in-memory flags, admin flips"},
    {"id":"admin-api","label":"/admin/flags","layer":"middleware","note":"bearer ADMIN_TOKEN · admin origins only"},
    {"id":"admin-page","label":"/admin page","layer":"frontend","note":"toggles + 7-day usage"},
    {"id":"keyword-rail","label":"KeywordRail","layer":"frontend","note":"built-in + user words, tooltips = rules"}
  ],
  "flows": [
    {"from":"admin-page","to":"admin-api","label":"GET/PUT flags"},
    {"from":"admin-api","to":"flag-service","label":"set → broadcast"},
    {"from":"keyword-rail","to":"doc-session","label":"vocab_define / confirm"}
  ],
  "features": [
    {"id":"feature-flags","label":"Feature flags & usage","components":["flag-service","admin-api","admin-page"]},
    {"id":"vocabulary","label":"Vocabulary: keywords + user words","components":["keyword-rail","doc-session","client-lexicon"]}
  ]
}
```
