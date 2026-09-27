# ADR 0015 — Version timeline: see every version, jump to any, branch on edit
Date: 2026-09-27 · Status: accepted · Amends: ADR 0009 (undo/redo semantics after a jump)

## Context
Versions already form a tree (`parent_version`; undo/redo move `current_version`), but only undo/redo
reach them. People want to see the history and go back to a specific point.

## Decision
1. `versions {current, path, items}` is sent at welcome and whenever the pointer moves (commit, undo,
   redo, jump, new diagram). Items are **summaries only** — version, parent, time, kind, element count,
   and +added / −removed / ~changed versus the parent by node id — computed once per version (versions
   are immutable) and capped at the last 200. Never the docs.
2. `goto_version {version}` jumps through the undo/redo path (`moveTo`, op origin `goto`): aborts the
   running job, discards an uncommitted utterance, clears stale lexicon fold targets. The next edit
   branches from the version on screen.
3. **Redo retraces a jump**: jumping (or undoing) back from X remembers X; redo walks toward X instead of
   the newest child (plan-critic: a newer sibling branch would otherwise hijack redo). A new edit clears it.
4. `path` = ancestors of the current version + the redo chain ahead of it — drawn solid in the strip;
   other branches are faded.
5. Flag `version_timeline`; the gateway refuses `goto_version` when off. No DDL (`created_at` exists).

## Consequences
+ History is visible and navigable with zero model cost; branches are never lost.
− Undo after a jump goes to the version's parent (tree semantics), not "back to where I was" — redo does that.

```arch
{
  "components": [
    {"id":"version-timeline","label":"VersionTimeline","layer":"frontend","note":"ADR 0015: summaries, jump, branches"}
  ],
  "flows": [
    {"from":"version-timeline","to":"doc-session","label":"goto_version"}
  ],
  "features": [
    {"id":"version-timeline-feature","label":"Version timeline","components":["version-timeline","doc-session"]}
  ]
}
```
