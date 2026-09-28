# Repo map — VoiceFlows   (e9aa0a8, 2026-09-28T14:42:54Z)

Read this once. Then `grep` `.claude/index/symbols.tsv` for exact symbols —
`name<TAB>kind<TAB>path:line`, 228 entries. Do not read symbols.tsv whole.

## Layers

| Layer | Where | Files |
|---|---|---|
| Front-end |  | 18 |
| Back-end | db  | 5 |
| Middleware |  | 0 |
| Infrastructure |  | 5 |

## Entry points
- `./packages/dsl/src/index.ts`
- `./packages/prompts/src/index.ts`

## Task runner
- npm run arch:check
- npm run build
- npm run codemap
- npm run dev:gateway
- npm run dev:web
- npm run test:dsl
- npm run typecheck
