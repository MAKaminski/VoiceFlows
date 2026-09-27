# ADR 0016 — Projects: four views in one document; everything said is kept as context
Date: 2026-09-27 · Status: accepted · Amends: ADR 0011 (kind switch no longer replaces a doc), ADR 0009 (a model job is pinned to its view), ADR 0015 (timeline kinds are the changed view)

## Context
Screen (wireframe), Architecture, ERD and Sequence must be one project: speak to any view, and keep
everything said as context so a general sense becomes a proper design. Architecture must represent
any real system (MuleSoft, Salesforce, Genesys, Observe.AI, a Genesys bot, a backend called "Shaw", a
full-stack team). Next (not now): deploy the code — the project must stay a structured spec.

## Decision
1. **One document, four view roots**: root `Project {title?, notes?}` with children `n_view_screen`
   (Frame), `n_view_architecture` / `n_view_erd` / `n_view_sequence` (Diagram), fixed order; ids unique
   project-wide. Versions, undo, timeline, share links and remember-across-tabs all work per project
   unchanged; **no DDL**. Rejected: a `projects` table with four documents (four histories, re-plumbed
   share/timeline/remember, no cross-view undo).
2. **The engine runs on a view doc** (`viewDoc`); `DocSession.doc` is a view of `project` and writes
   back with structural sharing; ops are rewritten `/root…` → `/root/children/<i>…` on the way out
   (`mapOpPaths`). A model job is **pinned to the view it started in**, so switching views mid-call never
   misroutes its ops. Utterances may span views; commit clears provisional flags project-wide.
3. **Naming a view switches to it and never replaces anything** (plan-critic blocker): strong phrases
   ("architecture", "the ERD", "sequence diagram", "wireframe") always; loose ones ("schema", "a login
   screen") only while the current view is blank; the latest phrase wins, so words before it stay in
   the view that was active when they were spoken. "Start over" clears only the active view.
4. **Project context, capped by cost**: every model call gets a ≤ 120-token brief (title, notes, named
   elements of the other views). `notes` (≤ 60 words, versioned in `Project.props`) is rewritten by a
   background Haiku call on view switch and every 8 committed utterances (≥ 30 s apart; flag
   `project_notes`) — never on the draw path. Utterances stay persisted as before.
5. **Any architecture**: the four lanes are a minimum — the model may add named lanes (`tier=other`);
   ~25 enterprise systems draw from the lexicon (Salesforce, MuleSoft, Genesys, Observe.AI, ServiceNow…);
   any other named system is a Node the model adds; a team is an `owner` badge on nodes, not a box.
6. Old single-view docs and **every version row** upgrade on read (`toProject`); share links made
   before projects render as a project. Flag `projects`: off → view switching refused. The stored shape
   is one-way (projects stay projects).
7. The metrics tap measures `[data-view-root]` and logs an error if it's missing (TTFV/reflow would
   otherwise read null silently).

## Consequences
+ One spec per product: four coordinated views, one history, one link — the input for "deploy the code".
− Brief + notes add ≈ $0.0022/speaking-min at 9.6 calls/min (measured in the M6 acceptance run).
− View switching by voice is heuristic; the tabs are the precise control.

```arch
{
  "components": [
    {"id":"project-views","label":"Project (4 views)","layer":"middleware","note":"ADR 0016: view docs + path rewrite, pinned jobs"},
    {"id":"project-notes","label":"project notes rewrite","layer":"middleware","note":"background Haiku, ≤ 60 words, flag project_notes"}
  ],
  "flows": [
    {"from":"project-views","to":"doc-session","label":"active view + brief"},
    {"from":"project-notes","to":"project-views","label":"notes → brief"}
  ],
  "features": [
    {"id":"projects","label":"Projects: Screen · Architecture · ERD · Sequence","components":["project-views","project-notes","doc-session","client-lexicon"]}
  ]
}
```
