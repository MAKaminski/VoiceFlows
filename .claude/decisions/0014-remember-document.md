# ADR 0014 — Remember the document across tabs: one owning tab per document
Date: 2026-09-27 · Status: accepted · Amends: ADR 0009 (single writer is per document, not per socket), ADR 0013 (a new tab no longer opens a new document)

## Context
A new tab opened a blank document, so work (and the share links on it) became unreachable once its
tab closed. With no accounts yet, the browser is the only identity we have.

## Decision
1. **The browser remembers its document**: `documentId` in localStorage (per browser; the session id stays
   per tab in sessionStorage). `hello {sessionId?, documentId?}`; `welcome` returns `documentId` and the
   client overwrites what it stored (an unknown id falls back to a new document). Flag
   `remember_document`: off → the gateway ignores `documentId`.
2. **One owning tab per document** (plan-critic: fan-out to several tabs broke the one-utterance-at-a-time
   DocSession). The gateway keeps `documentId → {DocSession, owner}`; a new tab opening a live document
   **takes it over**: the old tab gets `taken_over`, its mic stops, its messages are refused, and it shows
   "open in another tab — Use it here" (a reload takes it back). Closing a non-owning tab never
   releases the document.
3. **Every open is a fresh `sessions` row** on the document (`openOnDocument`), including a reload of the
   same tab — utterance seqs restart safely (a resumed session used to reuse seq 0 and lose rows).
4. **Reload race**: before loading a document that isn't live, the gateway awaits pending persistence
   writes, so a version written by a tab that just closed is read back before the next one is numbered.
   Concurrent opens re-check the registry after their awaits; the loser's session row is ended.
5. "New" (studio header) forgets the stored ids and reconnects to a blank document.

## Consequences
+ Work survives closing the tab; share links stay revocable from the same browser.
− `documentId` in localStorage is a bearer credential for that document (122-bit random UUID; same
  exposure class as the session id already in sessionStorage; XSS would expose either). Accepted until
  accounts; then documents belong to users.
− One replica assumed (ADR 0012); the registry is in-process.

```arch
{
  "components": [
    {"id":"live-docs","label":"live document registry","layer":"middleware","note":"ADR 0014: documentId → DocSession + owning tab"}
  ],
  "flows": [
    {"from":"live-docs","to":"doc-session","label":"one owner per document; takeover"}
  ],
  "features": [
    {"id":"remember-document","label":"Remember the document across tabs","components":["live-docs","doc-session"]}
  ]
}
```
