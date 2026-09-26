# Repo map — VoiceFlows   (none, 2026-09-26T20:29:40Z)

Read this once. Then `grep` `.claude/index/symbols.tsv` for exact symbols —
`name<TAB>kind<TAB>path:line`, 70 entries. Do not read symbols.tsv whole.

## Layers

| Layer | Where | Files |
|---|---|---|
| Front-end |  | 7 |
| Back-end | db  | 1 |
| Middleware |  | 0 |
| Infrastructure |  | 5 |

## Entry points
- `./packages/dsl/src/index.ts`
- `./packages/prompts/src/index.ts`

## Task runner
- npm run build
- npm run dev:gateway
- npm run dev:web
- npm run test:dsl
- npm run typecheck
