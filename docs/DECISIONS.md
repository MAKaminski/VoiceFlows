# Locked decisions

Changing any of these is a product decision — update this file first, then code.

| # | Decision | Choice | Why | Rejected alternative |
|---|---|---|---|---|
| D1 | Canvas ownership | **Standalone canvas we control**, with export adapters later | Third-party design tools don't expose a low-latency, patch-level write stream; we need sub-second incremental edits | Driving Claude Design / Canva / Figma live via API |
| D2 | Export targets (M6) | HTML/React code, PNG, and an import-by-URL handoff | Gets designs into Claude Design, Figma, v0 without coupling the live loop to them | Live two-way sync |
| D3 | Render model | Declarative DesignDoc tree → React | Diffable, patchable, serializable | Pixel canvas / SVG drawing |
| D4 | Edit contract | RFC 6902 JSON Patch ops | Small, streamable, reversible, auditable | Full-doc regeneration |
| D5 | Component vocabulary | 12 primitives + tokens (DESIGN_DSL.md) | Keeps output organized and repeatable | Freeform HTML from the model |
| D6 | Speech input | Streaming STT with interim partials | Partials are what let us act before the sentence ends | Batch transcription |
| D7 | When to generate | Intent-delta debounce + speculative generation with cancellation (INTENT_ENGINE.md) | Render on meaningful change, not every word — kills flicker and wasted tokens | Regenerate on every partial |
| D8 | Model split | Haiku for intent + fast patches; Sonnet for structural rebuilds | Fast path dominates volume; heavy model only when layout changes | One model for everything |
| D9 | Users | Single-user sessions in v1; multi-viewer read-only in M5 | Scope | Real-time multiplayer editing |
| D10 | Auth | Magic-link email (single table), no SSO in v1 | Scope | Enterprise SSO |
| D11 | Voice output | None in v1 — the canvas *is* the response; short text toasts only | Avoids talk-over with the user | TTS narration |
| D12 | Undo | Every committed patch batch = one version; undo/redo by version | Falls out of D4 for free | Snapshot diffs |
| D13 | Deployment | **Vercel** hosts `apps/web`; **Railway** hosts `apps/gateway`, Postgres, and Redis in one project/region | Vercel serverless functions can't hold long-lived WebSockets, so the gateway must be a persistent container; keeping gateway + data in one Railway region avoids a cross-provider hop on every patch | Everything on Vercel (breaks WebSockets) |
| D14 | Region | Web on Vercel's edge; gateway, Postgres, and Redis co-located in Railway's US-East region | The gateway → Redis → client hop is on the latency path; the browser → Vercel hop is not | Split regions |

## Amendments — 2026-09-26 (latency-first re-plan; see `.claude/decisions/`)
| # | Decision | Choice | Why | Rejected alternative |
|---|---|---|---|---|
| D15 | Two-tier response | **Client-side lexicon tier** creates `provisional` nodes from nouns/token words in STT partials (TTFV-0 target ≤ 400 ms p50); model tier edits them in place (TTFV-1 ≤ 1,000 ms p50) | Cloud STT + LLM cannot reach ~200 ms; an instant cheap response + streamed refinement is how voice products hide latency | Single model tier (1,175 ms p50 budget) |
| D6a | STT transport | Browser connects **directly** to Deepgram with a short-lived token minted by the gateway; client forwards partials to gateway | Removes a relay hop from TTFV-0 and lets the lexicon run client-side | Gateway relays audio |
| D7a | Generation scheduling | **Fused, header-first, single in-flight** Haiku call: line 1 = intent header, scored before ops apply; a new partial never aborts the running call, only an intent-delta commit does. `EXTRACT_MIN_GAP_MS=150` | Keeps the flicker gate without a separate intent hop; continuous speech can't starve the model tier | Separate intent call; abort on every partial |
| D4a | Model wire format | Model emits **compact op lines** (`+Button signin >root v=primary`); gateway expands to RFC 6902 before validation/storage | ~3× fewer output tokens; output tokens are the main model-side latency lever. Internal contract (D4) unchanged | Model emits raw JSON Patch |
| D13a | Gateway hosting note | Vercel Functions now support WebSockets; gateway **still** stays a persistent Railway container (min 1 replica) | Warm upstream sockets, in-memory session state and no cold starts are latency features | Move gateway to Vercel Functions |
| D16 | Unit economics | $/speaking-minute budget **$0.046** (≤ 20 model calls/min, ≤ 1,100 input tokens/call, ≤ 1 Sonnet settle/min, audio only while speaking). Managed plan **$20/mo incl. 200 speaking min**, overage $10/100 min; BYOK **$10/mo**, uncapped. See `docs/COST_MODEL.md` | Package as written costs $0.278/min — a typical user would cost more than $20 | Unmetered flat $20 (loses money above 398 min) |
| D17 | Language | **TypeScript end to end**; Rust only for the gateway hot path after a measured trigger (self-time > 20 ms p95, GC p99 > 10 ms, or gateway cost > $0.005/speaking min). ADR 0005 | Rust saves ≤ 1 ms of ~995 ms TTFV-1 (≤ 0.1%) and 0 ms of TTFV-0 (lexicon + render run in the browser) | Rewrite gateway in Rust now |
