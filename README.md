# LiveCanvas — build package for Claude Code

Speak a design out loud; watch it assemble on the canvas before you finish the sentence.

## How to use this package
1. Unzip into an empty repo folder.
2. Open Claude Code in that folder. It reads `CLAUDE.md` automatically.
3. Say: **"Build milestone M1 per docs/BUILD_PLAN.md."** Then M2, M3… one milestone per run.
4. Claude Code must not stop to ask questions. Every decision is locked in `docs/DECISIONS.md`.
   Anything it has to guess goes into `ASSUMPTIONS.md` for you to review afterward.

## What's inside
| File | Purpose |
|---|---|
| `CLAUDE.md` | Master instructions for Claude Code (read first, every session) |
| `docs/DECISIONS.md` | Locked choices + rationale. Change here, not in chat |
| `ARCHITECTURE.md` | Systems architecture by layer + full ERD |
| `docs/INTENT_ENGINE.md` | The debounce / speculative-generation core |
| `docs/DESIGN_DSL.md` | The 12-primitive component model + JSON Patch contract |
| `docs/LATENCY_BUDGET.md` | Per-hop budget, measurement plan |
| `docs/COST_MODEL.md` | $/speaking-minute, plan limits, BYOK pricing |
| `docs/BUILD_PLAN.md` | Milestones M1–M6 with acceptance tests |
| `db/schema.sql` | Postgres schema (matches the ERD exactly) |
| `prompts/*.md` | System prompts for the two model calls |
| `infra/docker-compose.yml`, `.env.example` | Local stack |
