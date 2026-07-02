# Daily Mentor — Sales Platform

Hosted, self-updating sales dashboard **+ data platform** for Daily Mentor (dailymentor.co).
Evolves the read-only prototype in `../dashboard-build` into a live **Node/TS + Postgres** app that
reconciles to the team's HUB numbers **to the dollar**, and that lets the client progressively move
off their Google Sheet and cut their Zapier/Jotform spend — without losing quality.

**Status:** Planning package complete (this commit). Phase‑1 app scaffold is next. _Client approval pending — this is prep so it's ready when they say go._

## Docs
| File | What it is |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | Master architecture spec (data model, ingestion, metric port, auth, deploy, invariants) |
| [docs/PLAN.md](docs/PLAN.md) | Phased implementation plan + repo scaffold |
| [docs/ISSUES.md](docs/ISSUES.md) | GitHub epics + issues (ready to create) |
| [docs/COST-AUDIT.md](docs/COST-AUDIT.md) | 147‑Zap bucketing + Zapier savings model (internal) |
| [docs/CLIENT-ONEPAGER.md](docs/CLIENT-ONEPAGER.md) | Plain‑English piece to send the client |
| [db/schema.sql](db/schema.sql) | Initial Postgres schema |

## The pipeline
```
tools ─▶ ~147 Zapier Zaps ─▶ "Sales | Master" sheet (untouched)
   backfill (one-time, scrubbed sheet read)  +  onward capture (parallel Zapier Webhooks→POST → /ingest)
        └────────────────────────┴─────▶ Postgres ─▶ ported metric engine ─▶ 3 dashboards + 12 raw tabs (read-only)
```

## Non-negotiables
- **Metric engine ported VERBATIM** from the prototype — never re-implemented in another language (protects HUB reconciliation).
- **DB is row-faithful to Bookings** — the engine counts raw rows with no dedup, so keying is a *proven-safe live optimization*, never a correctness primitive.
- **Reproduce-then-retire** — no Zap is switched off until the app provably replaces it, verified nightly by the HUB assertion.

## Pending client input
Zapier Task‑History + Zap step exports — finalizes the per‑Zap cost buckets and the exact webhook wiring. Everything else is buildable now.
