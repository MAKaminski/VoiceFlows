# Sprawl census

Generated. Every item here is a candidate for consolidation — the goal is **fewer component kinds, repeated**, not more kinds.

| Measure | Count |
|---|---|
| Tables | 16 |
| Foreign keys | 20 |
| Tables with no FK in or out | 0 |
| Components (workspace members) | 4 |
| Components nothing depends on | 0 |
| Distinct error types | 1 |
| Client/Service/Manager/Handler/Provider types | 6 |
| Symbol names defined 3+ times | 1 |

## Symbol names defined three or more times

Repetition of a *pattern* is good. Repetition of a *name* usually means the same idea was implemented several times.

| Name | Definitions | Where |
|---|---|---|
| `metadata` | 3 | apps/web/app, apps/web/app/admin, apps/web/app/s/[token] |

