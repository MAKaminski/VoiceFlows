# Assumptions log

| Date | Decision | Reason | How to reverse |
|---|---|---|---|
| 2026-09-26 | Magic-link tokens stored in Redis with 15-min TTL, not Postgres | D10 says single table; tokens are ephemeral | Add `magic_links` table with FK → users |
| 2026-09-26 | `ARCHITECTURE.md` lives at repo root, not `docs/` | Owner's standing rule for all projects | Move file back; update CLAUDE.md links |
| 2026-09-26 | pnpm workspaces monorepo | Simplest workspace tool already installed | Swap to npm workspaces |
| 2026-09-26 | Canvas styling via plain CSS variables (no Tailwind) | Tokens map 1:1 to CSS vars; fewer deps | Add Tailwind and map tokens to theme |
