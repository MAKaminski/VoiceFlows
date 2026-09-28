# ADR 0020 — All views at once, implied suggestions, flag history, a shared project library
Date: 2026-09-28 · Status: accepted · Amends: ADR 0014 (a library open wins over the tab's session), ADR 0012 (flag history)

## Context
User feedback after M7 ("working really well"):
1. See Screen, Architecture, ERD and Sequence at the same time, updating live.
2. Extract context beyond the literal words. A `cases` table should come with priority, status and subject
   pre-recommended, with no waiting, approved by voice ("approve", scoped: "approve all but status") or by a click.
3. A feature-flag screen that shows how flags are being turned on and off.
4. Save projects and open existing ones.

The user chose: suggestions in all views in two tiers, scoped voice approval, and **one shared workspace list**
(no accounts yet). Plan-critic returned "proceed with changes", with 8 blockers, all folded in below.

## Decision
1. **Grid** (flag `all_views`). A studio toggle, Focus | All views, defaults to the grid at ≥ 1280 px and is
   remembered per browser.
   - Each cell renders its view root, scaled to fit (`FitBox`, `data-scale`). Cells memoise on the root, so an edit
     in one view re-renders only that cell.
   - Clicking a cell makes it the view you speak to; naming a view by voice moves the outline.
   - SVG markers are namespaced per view.
   - The metrics tap measures only the active view's root, divided by its scale, so TTFV and reflow stay
     comparable. The share page gets the same grid.
2. **Suggestions are session state, never in the doc until approved.** This keeps versions, undo and share links
   clean.
   - **Tier 1 rules** (`suggest.ts`, $0, run with the lexicon): typical columns for about 85 tables, a
     forgot-password link, a terms line, an order total, search above a list, and Auth for a client plus an API.
   - **Tier 2 model** (`prompts/suggest.md`, flag `suggestions_model`, **off by default**):
     - Enabled, it raises measured free speech about +72% ($0.011 → $0.019/min), which fails CLAUDE.md rule 7
       (> 15%). Turning it on is an admin decision.
     - It has its own limiter (≤ 6/min), runs only after a settled sentence, and offers only suggestions that pass
       a dry-run apply.
3. **Approving.**
   - "approve …" and "reject …" are commands in voice and typed prompts. They are never drawn or sent to the model.
     Voice commands act on the **final** transcript only, so an eager "approve all" can't fire before "…but status".
   - Scope is resolved deterministically: table and column words, "all but" / "except". Jev is the fallback when
     nothing matches.
   - Approvals wait until no sentence is open and no job runs, then apply as **one version**.
   - Column suggestions compute their append at approve time. Rejections are remembered for the session.
4. **Save / open** (flag `project_library`).
   - "Save" (button, or "save the project" / "save it as X") marks the document saved. `setCurrent` keeps its
     title, `updated_at` and per-view counts current.
   - `GET /projects` lists saved projects to everyone. Archive and restore are reversible. All three are
     rate-limited per IP.
   - Open sends `hello {documentId, open: true}`, which wins over the tab's old session.
   - A project that another tab is editing is **never taken over**: `in_use` offers the read-only `/p/[id]`
     instead.
5. **Flag history.** `feature_flag_changes` (FK → `feature_flags`) records admin changes, with the actor as an
   8-hex fingerprint of the IP, and new flags seeded by migrate. `/admin` shows the last change per flag and a
   history table. The studio's Features popover shows what's on, read-only.
6. **Deploy safety.** `Flags` parses tolerantly: unknown keys are ignored, missing keys take their default. A web
   build one flag behind or ahead of the gateway no longer hangs.

## Consequences
+ All four views are visible and live. A named table arrives with its typical columns offered in ~5 ms, at $0.
+ Nothing implied enters the design without the user's approval, and each approval is one undoable version.
− **The shared list is public:** anyone with the site URL can see, open and edit saved projects. Mitigations:
  only saved projects are listed; noindex and no-store; rate limits; no takeover of a live editor; reversible
  archive; one flag switches it off. That is broader than share links (read-only, token-gated). Accounts
  (ADR 0000) are the real fix.
− Pending model suggestions and rejections live only as long as the session. Rule suggestions are recomputed
  when a session opens.
− The model tier is off until someone accepts its cost.

```arch
{
  "components": [
    {"id":"suggestions","label":"Implied suggestions (rules + model)","layer":"middleware","note":"ADR 0020: session state; approve = one version"},
    {"id":"project-library","label":"Project library (/projects)","layer":"middleware","note":"ADR 0020: shared list of saved projects"},
    {"id":"view-grid","label":"All-views grid","layer":"frontend","note":"ADR 0020: four live views, scaled per cell"}
  ],
  "flows": [
    {"from":"doc-session","to":"suggestions","label":"nouns drawn → rule suggestions (~5 ms)"},
    {"from":"project-library","to":"doc-session","label":"open {documentId, open} / in_use"}
  ],
  "features": [
    {"id":"all-views-feature","label":"All views at once","components":["view-grid"]},
    {"id":"suggestions-feature","label":"Implied suggestions","components":["suggestions","doc-session"]},
    {"id":"library-feature","label":"Save & open projects","components":["project-library","doc-session"]}
  ]
}
```
