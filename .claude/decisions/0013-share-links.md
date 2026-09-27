# ADR 0013 — Share links: read-only, pinned to a version, stored as `exports`
Date: 2026-09-27 · Status: accepted · Amends: ADR 0012 (new flag `share_links`), D14/M6 export (`exports.format='url'` now used)

## Context
People need to show a diagram or screen to someone else without giving them the editor. Every
feature sits behind a flag (ADR 0012). There are no accounts yet: every visitor is the anonymous
user, and a new tab opens a new document.

## Decision
1. **A share link is an `exports` row** (`format='url'`, `uri='/s/<token>'`) with two new columns,
   `token` (unique) and `revoked_at` — the export kind the schema already reserved, so no second
   table solves the same problem (plan-critic #3). No DDL beyond migration 003.
2. **Pinned to the version on screen** (`exports.version_id`): later edits — even switching to a new
   diagram in the same document — never change what was shared. One live link per version; sharing
   the same version again returns the same link.
3. **The token is the only credential**: 128-bit random, base64url. Unknown and revoked tokens both
   return 404; 30 misses / 10 min per IP → 429; tokens are redacted from gateway logs; the view page
   sends no Referer and is `noindex`; responses are `no-store`, so a revoke applies on the next load.
4. **Revoke is scoped to the caller's document** (`… and v.document_id = <socket's document>`).
   Links are listed at welcome, so they stay revocable across reloads of the same tab. After the tab
   is gone the author can't reach the document at all (no accounts) — known gap; admin can switch the
   `share_links` flag off, which stops every link resolving at once.
5. **Usage**: create = `used` (session); a view = `exposed`, once per token per IP per hour (bounded
   in memory), so public traffic can't write unbounded rows.
6. **Read path**: `GET /share/:token` on the gateway, fetched by the client page `/s/[token]`
   (existing CORS list; no new Vercel env var). Renders with the same `Canvas`.

## Consequences
+ One table owns every export; M6 file exports reuse the same row shape.
− Snapshot, not live: viewers don't see edits made after sharing (by design; "share again").
− No per-link expiry yet; revoke or the flag are the off switches.

```arch
{
  "components": [
    {"id":"share-api","label":"GET /share/:token","layer":"middleware","note":"ADR 0013: public, no-store, 404 on revoke"},
    {"id":"share-view","label":"/s/[token] page","layer":"frontend","note":"read-only Canvas, noindex, no-referrer"},
    {"id":"share-popover","label":"SharePopover","layer":"frontend","note":"create · copy · revoke"}
  ],
  "flows": [
    {"from":"share-view","to":"share-api","label":"GET pinned version"},
    {"from":"share-popover","to":"doc-session","label":"share_create / share_revoke"}
  ],
  "features": [
    {"id":"share-links","label":"Share links (read-only, pinned)","components":["share-popover","share-view","share-api"]}
  ]
}
```
