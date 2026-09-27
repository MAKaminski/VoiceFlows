# Repo map — VoiceFlows   (1f6cf8c, 2026-09-27T17:38:17Z)

Read this once. Then `grep` `.claude/index/symbols.tsv` for exact symbols —
`name<TAB>kind<TAB>path:line`, 127 entries. Do not read symbols.tsv whole.

## Layers

| Layer | Where | Files |
|---|---|---|
| Front-end |  | 10 |
| Back-end | db  | 2 |
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
