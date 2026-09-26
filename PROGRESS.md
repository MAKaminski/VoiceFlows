# Progress

| Milestone | Status | Acceptance results |
|---|---|---|
| M0 — Latency spike | **Blocked on keys** | Needs `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, Railway token (ADR 0001) |
| M1 — Skeleton + static render | **Done 2026-09-26** | `docker compose up`: postgres (healthy), redis, gateway (`/healthz` 200), web all up · `/playground` renders all 12 primitives (16 nodes) · schema = ERD: 13 tables, 16 FKs = 16 ERD relationships · WS `hello`→`welcome` round-trip · `@livecanvas/dsl` 7/7 unit tests (fixture validity, compact→RFC 6902, apply/invert = exact undo, delta score) · `pnpm -r typecheck` clean |
