# Repo map — VoiceFlows   (04f933e, 2026-09-28T20:52:40Z)

Read this once. Then `grep` `.claude/index/symbols.tsv` for exact symbols —
`name<TAB>kind<TAB>path:line`, 298 entries. Do not read symbols.tsv whole.

## Layers

| Layer | Where | Files |
|---|---|---|
| Front-end |  | 27 |
| Back-end | db  | 6 |
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
