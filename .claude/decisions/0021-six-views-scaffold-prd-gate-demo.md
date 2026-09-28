# ADR 0021 — Six views that scaffold each other, a live PRD, an invite gate, a narrated demo
Date: 2026-09-28 · Status: accepted · Amends: ADR 0016 (six view roots, not four), ADR 0020 (grid is 3×2), ADR 0012 (new flags)

## Context
User feedback after M8:
1. A home page before the product, with a login. The user chose a **shared invite code** for now.
2. A demo in which AI voices build a product, with a PRD filling in live. The user chose a **live scripted demo on
   the real engine**.
3. Two more views: **Constraints** (bottlenecks, rates) and **Cost-Value Analysis**.
4. Everything generates at once: saying something in one view scaffolds the others. The user chose **drawn live,
   marked inferred, undoable**. An optional light intake.
5. Flags and usage for all of it.

Exploration found that the gateway's `/ws`, `/stt/token` and `/projects` had no auth, and that any client could
raise its own model-call cap with `tune`. A public demo makes both a cost risk. Plan-critic returned "proceed with
changes", with 8 blockers, all folded in below.

## Decision
1. **Six views, appended.**
   - `constraints` and `cva` are view roots 4 and 5. Op paths are index-based, so existing indexes never move.
   - This is a **one-way door**: views can be appended, never reordered.
   - `DesignDocSchema` pads a 4-view Project to 6 inside the schema (preprocess), so every parse path works:
     snapshot, share, `/p`, version history. `PROTOCOL = 3`.
   - New optional props, all numbers:
     - Constraints nodes: `demand`, `capacity` (req/s), `latency` (ms), `unit`.
     - Edges: `rate`.
     - Cost-value items: `cost` and `value` (1–5).
   - **Layouts.** `layoutConstraints` is a pipeline in architecture order, with a gauge that turns red at ≥ 80%
     utilisation. `layoutCva` is a 2×2 grid: quick wins, big bets, fill-ins, money pits, plus an unscored strip.
     Numbers and judgements go to the model (`prompts/diagram_constraints.md`, `diagram_cva.md`).
   - **Triggers.** "bottlenecks" and "cost value" are strong. "constraints" and "throughput" are loose and switch
     only from a blank view, so "foreign key constraints" stays in the ERD (corpus `c-fk-stays`).
2. **Cross-view scaffolding** (flag `cross_view_scaffold`).
   - A pure rule table in `packages/dsl/src/scaffold.ts`, $0, no model. It runs **once, when a sentence commits**,
     before that sentence's version is written. So it lands in the same version, one undo removes it all, and a
     rolled-back job can't leave it behind.
   - It runs to a fixpoint (≤ 3 rounds; rules never duplicate): screen → architecture → constraints / cva.
   - Scaffolded nodes carry `inferred: true`, shown faded with a badge, and are cleared when the user or model edits
     them.
   - **Slot takeover.** Your own node in the same slot replaces an inferred placeholder in place, and the copies in
     other views are renamed. For example, "a react app calls the api gateway which uses auth0" turns the inferred
     Web app, API and Auth into your three names.
   - It never overwrites what you said, and rule suggestions skip inferred nodes.
3. **The PRD** (flag `prd_view`). `compilePrd(project)` renders the six views into Markdown sections, with an
   Open questions section for each empty view.
   - It is deterministic, $0, recompiled on every version, and never paraphrased.
   - The studio drawer has Copy and `.md`.
4. **Light intake** (flag `project_intake`). An optional card on an empty project asks: what are you building, who
   uses it, and which systems.
   - The answers seed the title and notes. Named systems become architecture nodes, which scaffold the other views.
   - It all lands as one version.
5. **Invite gate** (flag `invite_gate`, enforced only when `ACCESS_SECRET` is set).
   - The invite code lives in a server-only Vercel env var and is checked in `/api/enter`, timing-safe and
     rate-limited. **This deviates from the plan**, which checked it at the gateway. The code is high-entropy and
     the route is rate-limited, so the extra hop wasn't worth it.
   - A valid code sets a 30-day httpOnly cookie: HMAC(`ACCESS_SECRET`), purpose `cookie`.
   - Edge middleware guards `/studio`, `/playground`, `/p`, `/admin`. `/api/access-token` mints a 10-minute
     `full` token and `/api/demo-token` mints a `demo` token.
   - With the secret set, the gateway requires a token on `hello`, `/stt/token` and `/projects*`.
   - **Revoking access = rotate `ACCESS_SECRET` on both Vercel and Railway.** Changing `INVITE_CODE` stops new
     entries only.
   - `tune` is clamped to the defaults for everyone (callsPerMin ≤ 20), closing the self-raised cap.
   - Fastify `trustProxy` trusts exactly one hop (Railway), so per-IP limits count visitors.
6. **Demo scope.** A `demo` token opens a fresh in-memory document; asked-for session and document ids are ignored.
   It also refuses these messages:
   - `prompt`: the demo only speaks.
   - `save_project`: a no-op.
   - `share_create`.
   - `tune`.

   Caps:
   - 40 model calls per session;
   - 5 minutes, then the socket closes;
   - ≤ 3 sessions per IP per hour;
   - ≤ 150 per day globally.
7. **Narrated demo** (flag `voice_demo`).
   - An 8-line script builds a support desk across all six views.
   - The gateway generates each line with **Deepgram Aura-2** in 3 voices (Thalia, Orion, Andromeda) on first
     request. It transcribes each clip with nova-3 for real word timings and caches everything in memory, served at
     `/demo/manifest` and `/demo/audio/:voice/:n`. The default voice is warmed at boot.
   - **No audio is committed to the public repo.**
   - The `/demo` page plays a clip and sends the **script's** words as `partial`s at those timings, the same path
     browser STT uses, so the real engine draws everything.

## Consequences
+ One sentence fills six views and a PRD, at $0 for everything except the model calls it already made.
+ The product is no longer open to anyone who finds the URL. The demo's worst case is bounded: 150 runs/day ×
  ≈ $0.01 ≈ **$1.50/day**, plus TTS ≈ 8 lines × 3 voices ≈ $0.10 per deploy.
− A shared invite code is not identity. Anyone holding it has full access until the secret is rotated. Accounts
  (ADR 0000) are the real fix.
− Demo caps are in memory, per gateway replica. With 1 replica that is exact; more replicas multiply them.
− Six views are a one-way door for view order.

**Roadmap, not in M9:**
- Code scaffolding across workers, generated from the six views as a structured spec.
- Context enrichment from customers' own systems. The intake's "systems" is the seam.

```arch
{
  "components": [
    {"id":"scaffold","label":"Cross-view scaffolding (rules)","layer":"middleware","note":"ADR 0021: at commit, same version, inferred"},
    {"id":"prd","label":"PRD compiler","layer":"frontend","note":"ADR 0021: six views → Markdown, $0"},
    {"id":"invite-gate","label":"Invite gate (HMAC access tokens)","layer":"middleware","note":"ADR 0021: cookie / full / demo purposes"},
    {"id":"voice-demo","label":"Narrated demo (Aura-2 + word timings)","layer":"middleware","note":"ADR 0021: generated on demand, cached in memory"}
  ],
  "flows": [
    {"from":"doc-session","to":"scaffold","label":"utterance commit → inferred ops, same version"},
    {"from":"invite-gate","to":"doc-session","label":"hello {access} → full | demo scope"},
    {"from":"voice-demo","to":"doc-session","label":"script words as partials at clip timings"}
  ],
  "features": [
    {"id":"six-views-feature","label":"Constraints and Cost-Value views","components":["doc-session","view-grid"]},
    {"id":"scaffold-feature","label":"Everything generates at once","components":["scaffold","doc-session"]},
    {"id":"prd-feature","label":"Live PRD","components":["prd"]},
    {"id":"gate-feature","label":"Home page + invite code","components":["invite-gate"]},
    {"id":"demo-feature","label":"Narrated demo","components":["voice-demo","invite-gate","doc-session"]}
  ]
}
```
