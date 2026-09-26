# ADR 0004 — Cost model and plan limits
Date: 2026-09-26 · Status: accepted (numbers provisional until M0) · Adds: D16

## Context
Licence price ceiling is $20/user/month. Package as written: $0.278 per speaking minute
(Haiku $0.270 + Deepgram $0.0077) → typical 70 min = $19.46 before infra and Stripe.

## Decision
Cost-tuned design at $0.046/speaking min (details and math in `docs/COST_MODEL.md`).
Managed $20 includes 200 speaking min (46% margin at cap); overage $10/100 min (54%).
BYOK $10/mo uncapped (86%). Cost regression > 15% is a failing change.

## Consequences
M4 must enforce call gating and input-token ceilings; M5 adds plans, usage_periods,
provider_keys (all FK → users) and Stripe metered billing. Revisit after M0 measurements.

```arch
{
  "components": [
    {"id":"stripe","label":"Stripe metered billing (M5, planned)","layer":"middleware"}
  ],
  "flows": [
    {"from":"@livecanvas/gateway","to":"stripe","label":"overage usage (M5)"}
  ],
  "features": [
    {"id":"billing","label":"Plans · quota · BYOK (M5, planned)","uses":["@livecanvas/web","@livecanvas/gateway","stripe","postgres"],"owns_tables":["plans","usage_periods","provider_keys"]}
  ],
  "notes": [
    {"on":"stripe","text":"$20 incl. 200 speaking min · BYOK $10"}
  ]
}
```
