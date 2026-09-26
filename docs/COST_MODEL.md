# Cost model — LiveCanvas

Prices as published 2026-09-26. Unit = **speaking minute** (mic open and user talking;
nothing is metered while idle). Locked as D16 in `docs/DECISIONS.md`; ADR 0004.
Re-derive after M0 replaces the two starred assumptions with measured values.

## Unit prices
| Layer | Service | Price |
|---|---|---|
| Middleware | Claude Haiku 4.5 | $1 / MTok in · $5 / MTok out · cache read $0.10 |
| Middleware | Claude Sonnet 5 | $2 / MTok in · $10 / MTok out · cache read $0.20 |
| Middleware | Deepgram Nova-3 streaming | $0.0077 / min list (promo $0.0048 not relied on); Growth $0.0065 |
| Infrastructure | Railway Pro | $20/mo incl. $20 usage · $10/GB-RAM/mo · $20/vCPU/mo · $0.05/GB egress |
| Front-end | Vercel Pro | $20/seat/mo |
| — | Stripe | 2.9% + $0.30 per charge |

## Cost per speaking minute
| Line | Package as written | Cost-tuned design (locked) |
|---|---|---|
| Haiku | 158k in + 22.4k out = $0.158 + $0.112 = **$0.270** | 20 calls* × (1,100 in* + 60 out) = 22k in + 1.2k out = $0.022 + $0.006 = **$0.028** |
| Sonnet settle | not budgeted | ~1/min × (3,000 in + 400 out) = $0.006 + $0.004 = **$0.010** |
| Deepgram | $0.0077 | **$0.0077** |
| **Total** | **$0.278** | **$0.046** |

\* Assumptions M0 must measure: model calls per speaking minute, input tokens per call.
No prompt-cache discount is assumed (static prefix is likely below Haiku's minimum cacheable length).

### Cost rules the build must keep (D16)
1. Model calls fire only when the client lexicon sees a new content word (noun / modifier /
   verb) **and** no call is in flight — target ≤ 20 calls per speaking minute.
2. Model input uses the compact doc format; for large docs send only the subtree being edited —
   target ≤ 1,100 input tokens per call.
3. Sonnet only on `structural=true` settle passes — target ≤ 1 per speaking minute.
4. Audio is streamed to Deepgram only while client VAD detects speech.
A change that raises $/speaking-minute by > 15% is a failing change (same rule as latency).

## Fixed infrastructure (≈ $65/mo; budgeted $0.80/user at 100 users)
| Layer | Service | Monthly |
|---|---|---|
| Front-end | Vercel Pro, 1 seat | $20 |
| Back-end | Railway Postgres (0.5 vCPU / 1 GB) + Redis (0.25 vCPU / 0.5 GB) | $15 usage |
| Middleware | Railway gateway (1 vCPU / 1 GB, always on) | $30 usage |
| Infrastructure | Railway Pro: $20 base + $45 usage − $20 included | $45 |
| **Total** | | **$65** → $0.65/user at 100 users (budget $0.80) |

## Plan pricing
### Managed — $20/mo, includes 200 speaking minutes
Fixed per user: $0.80 infra + $0.88 Stripe ($20 × 2.9% + $0.30) = $1.68.

| Speaking min/mo | Cost | Margin at $20 |
|---|---|---|
| 70 (typical: 10 sessions × 20 min × 35% talking) | 70 × $0.046 + $1.68 = $4.90 | $15.10 (75%) |
| **200 (cap)** | 200 × $0.046 + $1.68 = $10.88 | $9.12 (46%) |
| 300 | $15.48 | $4.52 (23%) |
| 398 (break-even) | ($20 − $1.68) ÷ $0.046 = 398 min | $0 |

**Overage: $10 per additional 100 speaking minutes** (cost 100 × $0.046 = $4.60 → 54% margin).
At the cap without an overage purchase: degrade to lexicon tier + slower model cadence, never hard-stop mid-session.

### BYOK — $10/mo, no minute cap
Customer pays models + STT directly (≈ $0.046/speaking min, ≈ $3.22/mo typical).
Our cost: $0.80 infra + $0.59 Stripe ($10 × 2.9% + $0.30) = $1.39 → margin $8.61 (86%).
Gateway compute per speaking minute ≈ $0 (I/O-bound). Only an abuse guard: max concurrent
sessions per account; not billed.

## Build impact (lands with M5; M0–M4 unchanged)
| Layer | Work |
|---|---|
| Front-end | Usage meter ("142 / 200 min"), warning at 80%, upgrade prompt at cap, "Use your own keys" settings |
| Back-end | `plans`; `usage_periods` (FK → users, plans); `provider_keys` (FK → users, encrypted). Speaking minutes derived from `transcript_segments` — no new telemetry |
| Middleware | Quota check on session open; per-user key routing for BYOK; Stripe metered overage |
| Infrastructure | Stripe account; key-encryption secret in Railway |

## Measurement
HUD shows live $/speaking-minute (GENERATION_JOBS tokens × unit prices + Deepgram minutes).
M0 reports calls/min and tokens/call; if $/min > $0.055 (+20%), cut the cap before launch
rather than raising price.
