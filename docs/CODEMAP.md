# Code map

_Generated from the TypeScript AST by `pnpm codemap` — do not edit by hand; CI runs `pnpm codemap --check`._

| Measure | Count |
|---|---|
| Modules | 26 |
| Lines | 1488 |
| Top-level symbols | 140 |
| Exported symbols | 66 |
| Exported names defined in 2+ modules | 0 |

## Package dependency graph

```mermaid
flowchart LR
  _livecanvas_dsl["@livecanvas/dsl<br/><small>Middleware (shared contracts)</small>"]
  _livecanvas_prompts["@livecanvas/prompts<br/><small>Middleware</small>"]
  _livecanvas_gateway["@livecanvas/gateway<br/><small>Middleware</small>"]
  _livecanvas_web["@livecanvas/web<br/><small>Front-end</small>"]
  _livecanvas_gateway --> _livecanvas_dsl
  _livecanvas_gateway --> _livecanvas_prompts
  _livecanvas_web --> _livecanvas_dsl
```

| Package | External runtime imports |
|---|---|
| @livecanvas/dsl | `zod` |
| @livecanvas/prompts | — |
| @livecanvas/gateway | `@fastify/websocket`, `fastify`, `postgres`, `undici`, `ws`, `zod` |
| @livecanvas/web | `lucide-react`, `next`, `react`, `zustand` |

## Modules and exported symbols

### @livecanvas/dsl — Middleware (shared contracts)

| Module | LOC | Exports (kind) |
|---|---|---|
| [compact.ts](../packages/dsl/src/compact.ts) | 143 | `SHORT_KEYS` const · `CompactContext` interface · `CompactParseError` class · `expandCompact` function · `serializeCompact` function |
| [doc.ts](../packages/dsl/src/doc.ts) | 63 | `DesignNode` interface · `NodeId` const · `DesignNodeSchema` const · `DesignDocSchema` const · `DesignDoc` type · `emptyDoc` function · `findNode` function |
| [fixtures.ts](../packages/dsl/src/fixtures.ts) | 41 | `kitchenSinkDoc` const |
| [index.ts](../packages/dsl/src/index.ts) | 9 | — |
| [intent.ts](../packages/dsl/src/intent.ts) | 50 | `IntentAction` const · `Intent` const · `Intent` type · `IntentHeader` const · `IntentHeader` type · `DELTA_WEIGHTS` const · `deltaScore` function |
| [ops.ts](../packages/dsl/src/ops.ts) | 84 | `PatchOp` const · `PatchOp` type · `applyOp` function · `invertOp` function |
| [primitives.ts](../packages/dsl/src/primitives.ts) | 86 | `PRIMITIVE_TYPES` const · `PrimitiveType` const · `PrimitiveType` type · `propSchemas` const · `CONTAINER_TYPES` const · `PRIMARY_TEXT_PROP` const |
| [tokens.ts](../packages/dsl/src/tokens.ts) | 30 | `ColorToken` const · `SpaceToken` const · `RadiusToken` const · `ColorToken` type · `SpaceToken` type · `RadiusToken` type · `TokenSet` const · `TokenSet` type · `defaultTokens` const |
| [ws.ts](../packages/dsl/src/ws.ts) | 30 | `ClientMsg` const · `ClientMsg` type · `ServerMsg` const · `ServerMsg` type |

### @livecanvas/prompts — Middleware

| Module | LOC | Exports (kind) |
|---|---|---|
| [index.ts](../packages/prompts/src/index.ts) | 31 | `Prompt` interface · `PromptName` type · `loadPrompt` function |

### @livecanvas/gateway — Middleware

| Module | LOC | Exports (kind) |
|---|---|---|
| [bench/align.ts](../apps/gateway/src/bench/align.ts) | 27 | — |
| [bench/bakeoff.ts](../apps/gateway/src/bench/bakeoff.ts) | 126 | `pcmFromWav` function |
| [bench/providers.ts](../apps/gateway/src/bench/providers.ts) | 149 | `SttSession` interface · `SttProvider` interface · `wsSession` function · `PROVIDERS` const |
| [config.ts](../apps/gateway/src/config.ts) | 26 | `Config` type · `loadConfig` const |
| [migrate.ts](../apps/gateway/src/migrate.ts) | 34 | — |
| [server.ts](../apps/gateway/src/server.ts) | 50 | `buildServer` function |
| [spike.ts](../apps/gateway/src/spike.ts) | 271 | — |

### @livecanvas/web — Front-end

| Module | LOC | Exports (kind) |
|---|---|---|
| [app/layout.tsx](../apps/web/app/layout.tsx) | 13 | `metadata` const · `RootLayout` function |
| [app/page.tsx](../apps/web/app/page.tsx) | 6 | `Home` function |
| [app/playground/page.tsx](../apps/web/app/playground/page.tsx) | 21 | `Playground` function |
| [components/canvas/Canvas.tsx](../apps/web/components/canvas/Canvas.tsx) | 13 | `Canvas` function |
| [components/canvas/CanvasNode.tsx](../apps/web/components/canvas/CanvasNode.tsx) | 19 | `CanvasNode` const |
| [components/canvas/primitives.tsx](../apps/web/components/canvas/primitives.tsx) | 111 | `renderers` const |
| [components/canvas/tokens.ts](../apps/web/components/canvas/tokens.ts) | 16 | `tokenVars` function · `color` const · `space` const · `radius` const |
| [next.config.ts](../apps/web/next.config.ts) | 15 | — |
| [store/doc.ts](../apps/web/store/doc.ts) | 24 | `useDoc` const |
