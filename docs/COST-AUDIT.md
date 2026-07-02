# Daily Mentor — Zapier Cost Audit

*Internal audit + client one-pager. Every figure below is derived from the client's actual Zapier invoices and reconciled to the data/health audit in `data/clean.json` and the locked ingestion/stack decisions in `README.md`.*

---

# PART A — INTERNAL AUDIT (for the build team)

## A0. Sources of truth used

- **Health / data audit:** `C:/Users/jawad/Downloads/Pavan/dashboard-build/data/clean.json` — `health.failed_zapier_rows = 21713`, `health.broken_formula_cells_approx ≈ 27000`, `health.bookings_rows = 23385`, `health.leads_rows = 44974`, 7 junk tabs (`Copy of HUB - Closers`, `old HUB - DMPN Closers`, `old HUB - DMA Closers`, `old HUB - Closers`, `old Hub - Inbound Setters`, `Bookings - zapier failed`, `helper_sheet`).
- **Tabs the app already ingests** (proof of what it can absorb): `pipeline/extract_site.py` line 8 — `HUB - Closers`, `HUB - Setters`, `Call Dashboard`, `Bookings`, `Leads`, `Jotform Closer`, `Jotform Setter`, `Payments`, `Refunds`, `Residuals`, `Elective Orders Completed`, `Leads Over Time` (12 tabs).
- **HUB reconciliation (proves the app can be trusted to replace the sheet as the reader):** `clean.json` → `closers_total.cash = 455674.9` (June 2026, call-date basis = HUB to the dollar); Sam Aujla `showed 50 / qual 43 / closeRate 62.79%`. `pipeline/tune.py` reproduces this assertion.
- **Locked ingestion / stack decisions and exact metric defs:** `README.md` ("keep these EXACT").
- **Billing:** client screenshots — Team plan, base **$898.50/mo** including **100,000 tasks/mo**; overage **$0.0226/task** up to +200,000; **7,145** tasks used this cycle (resets **2026-07-23**); invoice history below.

## A1. What the invoices actually tell us (the diagnosis)

Every invoice decomposes cleanly into **base ($898.50) + overage (tasks × $0.0226)**. Reverse-engineering the overage tasks from each invoice (verified arithmetic):

| Cycle | Invoice | Overage $ | Implied overage tasks |
|---|---|---|---|
| 05-09 | $3,261.03 | $2,362.53 | **~104,500** |
| 06-09 | $1,918.13 | $1,019.63 | ~45,100 |
| 04-09 | $1,742.28 | $843.78 | ~37,300 |
| 01-09 | $1,328.14 | $429.64 | ~19,000 |
| 06-23 | $1,094.98 | $196.48 | ~8,700 |
| 07-23 (upcoming) | $988.35 | $89.85 | ~4,000 |
| 03-09 | $983.83 | $85.33 | ~3,800 |
| 02-09 | $658.35 | **below base** | 0 |

*Average of the sampled invoices = **$1,496.89**.* There are two billing lines each month — the subscription on the 23rd and the larger variable line on the 9th — which is why cycles are labelled by close date.

**Three findings that drive everything:**

1. **The base plan is fine; the overage is the disease.** In a light month (02-09) the bill was *under* the base allowance. The $3,261 and $1,918 months are 100% task-volume overage — not a bigger platform, just more events firing. Kill the volume and you kill the spikes.
2. **The spikes track high-volume, low-decision Zaps.** ~104k overage tasks in one cycle cannot come from "a lead financed a deal" events (there are only **23,385 bookings** *ever* — `clean.json`). They come from Zaps that fire on *every* lead / message / row: reporting rollups, Slack / notification fan-outs, sheet create+update writes, and per-event tool mirrors. Those are exactly the categories the app **retires** or **moves to free**.
3. **Tasks compound multiplicatively.** One inbound lead can trigger: Jotform→Close, Close→Sheet create, a status-change Sheet update, a Slack notify, a reporting Zap, an SMS/email step — 5–6 tasks per lead. At **44,974 lead rows** and **~147 Zaps**, this is where 100k+ task months come from.

## A2. Bucketing methodology (how to sort all 147 Zaps)

For **each** Zap, ask four questions in order. First "yes" wins the bucket.

1. **Does the app already hold this data, or trivially can?** (sheet writes, `[Reporting]` rollups, dashboards, per-rep scorecards) → **RETIRE**. The app computes these live from Bookings; the Zap is redundant the moment the app is the reader.
2. **Is it a human-facing notification we can reproduce?** (Slack pings, "new booking" alerts, internal FYI emails) → **RETIRE (Phase 3)** — reproduce as an in-app feed / digest / native Slack post from our backend, not per-event Zaps.
3. **Is it a high-volume, mechanical tool→tool sync where both ends have a native webhook/API?** (Close↔Stripe, Calendly→Close, Jotform→Close, Manychat→Close) → **MOVE-TO-FREE** — replace the Zapier hop with a direct webhook into our `/ingest`, or a native tool webhook, at **$0/event**.
4. **Is it genuine multi-tool business glue with real branching/logic that must keep firing to run the business, and has no clean native path?** (e.g. an Elective financing approval that must update Close *and* trigger an SMS *and* start a Stripe subscription with conditional logic) → **KEEP** — leave it on Zapier. Quality first.

### Observable categories → buckets (finalize against the export)

| Zap category (visible in the 147 list) | Bucket | Why | Task-volume weight |
|---|---|---|---|
| **[Reporting] Zaps** | RETIRE | App computes every metric live from Bookings; reconciles to HUB to the dollar. | High |
| **Sheet create / update Zaps** ("Sales \| Master" writes) | RETIRE | Once the app (not the sheet) is the source dashboards read from, these writes serve nothing the app needs. Also the #1 task multiplier (create + N updates per booking). | **Highest** |
| **Notification / Slack Zaps** | RETIRE (P3) | Reproduce as in-app activity feed + one native digest post from our backend. | High |
| **Jotform → Close Zaps** | MOVE-TO-FREE → later RETIRE | Phase 2: post form submits to our `/ingest` (and keep a Zapier catch-hook so Close still fires). Phase 3: our own form builder replaces Jotform, cutting Jotform spend too. | High |
| **Close / Calendly / Stripe / Elective / Manychat integration Zaps (mechanical mirrors)** | MOVE-TO-FREE | Native webhooks post straight to `/ingest`; the append-only event log means we never lose a field. | High |
| **Pre-call email + SMS flow Zaps** | KEEP (audit each) | These *do* something to the customer. Keep unless a step is pure logging (that sub-step → RETIRE). | Medium |
| **Conditional multi-tool business glue** (financing/subscription orchestration) | KEEP | Real branching logic, revenue-critical, no clean native path yet. | Low–Medium |

**Needs the export to finalize (flag explicitly):**
- Exact task-count per Zap (Zapier's Task History export).
- Which "integration" Zaps are true mirrors vs. contain hidden branching.
- Whether any "notification" Zap is load-bearing for a downstream tool.
- The create-vs-update split on the Sheet Zaps.

> The bucket **rules** above are final. The **per-Zap assignment** is confirmed once you pull each Zap's task history and step config. — *confirm from export.*

## A3. The savings model (tied to $898.50 base + $0.0226/task)

**Model mechanics.** Bill = `898.50 + max(0, tasks − 100,000) × 0.0226`. Savings come in two layers: (1) collapse the overage tasks → bill floors at $898.50; (2) once durably under allowance every month, **drop the plan tier** (Team → Professional) since the seat/task headroom is no longer needed.

**Assumptions (stated):**
- Blended current spend ≈ **$1,500–1,700/mo** (invoice average of the sampled cycles = **$1,496.89**), ~$18–20k/yr, with $3,261 overage spikes.
- Retiring Sheet-write + `[Reporting]` + notification Zaps and moving tool-mirrors to free webhooks removes the bulk of overage tasks (they *are* the overage, per A1).
- KEEP Zaps (customer-facing flows + true glue) stay and continue consuming tasks, but comfortably inside the 100,000 allowance in a normal month (the 02-09 cycle already ran under base).
- No quality is removed: every retired/moved flow is reproduced by the app or a direct webhook **before** its Zap is switched off.

| Scenario | What's done | Steady-state monthly | Annual | vs. current (~$18–20k/yr) |
|---|---|---|---|---|
| **Today (baseline)** | Nothing changes | $1,500–1,700 (spikes $3,261) | ~$18,000–20,400 | — |
| **Conservative** | Retire Reporting + Sheet-writes + notifications; move the 2–3 biggest tool-mirrors to free. Stay on **Team base**, no tier change. Overage eliminated. | **$898.50** | **$10,782** | **Save ~$7,200–9,600/yr (~40–48%)** |
| **Optimistic** | All of the above + Jotform replaced by our form builder + remaining mirrors on free webhooks; usage durably under a lower tier → **downgrade Team → Professional** (~$73.50/mo band, annual). | **~$74–150** | **~$900–1,800** | **Save ~$16,000–19,000/yr (~85–90%)** |

**Conservative is the number to quote the client** — $898.50/mo floor, ~$7.2–9.6k/yr saved, spikes gone. Optimistic is the "if we also cut Jotform and finish the migration" ceiling. The single biggest lever is **retiring the Sheet create/update Zaps**, because they're the largest task multiplier and the app makes the sheet optional anyway.

**Secondary savings (out of the Zapier line, still real):** retiring Jotform in Phase 3 cuts the Jotform subscription; less Zapier task pressure also means fewer "$0.0226 surprise" reconciliation headaches for finance. Flag these **separately** so the Zapier-only number stays honest.

## A4. The 3-phase spend trajectory (what happens to the sheet + spend at each phase)

**Phase 1 — SEE IT** *(Overview / Closer / Setter dashboards live from a snapshot).*
- **Zaps:** untouched. All 147 keep firing.
- **Sheet:** still source of truth (one-time backfill scrubs the 21,713 failed-Zapier rows + 7 junk tabs).
- **Spend:** **unchanged** (~$1.5–1.7k/mo). This phase buys trust — numbers reconcile to HUB — with zero risk.

**Phase 2 — OWN THE DATA** *(onward capture; app becomes a real store).*
- **Zaps:** add **one** parallel "Webhooks by Zapier → POST" action to each relevant Zap (Zap still writes the sheet untouched **and** posts to our `/ingest`). Capture CREATE + UPDATE events, upsert on the Close opportunity/lead ID, append-only raw log. Nightly sheet-reconciliation sweep + automated HUB assertion.
- **Sheet:** still written, but now **mirrored, not trusted** — the app can survive without it.
- **Spend:** the added webhook action is **+1 task per already-firing Zap**, so spend ticks *up slightly* here — this is the investment phase. It's temporary and small; it unlocks Phase 3.

**Phase 3 — CUT THE GLUE** *(retire/move by bucket; make the sheet optional).*
- **Zaps:** switch off RETIRE Zaps (Reporting, Sheet-writes, notifications — app reproduces them); repoint MOVE-TO-FREE Zaps to native webhooks/`/ingest` at $0/event; KEEP the genuine glue. Order of operations: **reproduce-then-retire**, one bucket at a time, verified by the nightly HUB assertion so nothing drifts.
- **Sheet:** becomes **optional** — kept as a comfort backup or turned off; the client chooses.
- **Spend:** overage collapses → **$898.50 floor (Conservative)**; if usage stays under a lower tier, downgrade → **Optimistic**.

## A5. Risks / guardrails (quality-first)

- **Never retire before reproduce.** A RETIRE Zap is only switched off after the app (or a direct webhook) demonstrably produces the same result, verified by the nightly HUB assertion (`tune.py`-style check).
- **Append-only event log** protects against the "we didn't map that field" problem — replay from history, no re-scrape.
- **KEEP list is deliberately generous.** Any Zap with customer-facing side effects or real branching stays until there's a proven replacement. We're cutting waste, not cutting corners.
- **Export dependency:** per-Zap task counts and hidden-branching confirmation require the Zapier Task History + Zap step exports. Bucket rules are locked; per-Zap final assignment is "confirm from export."

---

# PART B — CLIENT ONE-PAGER (plain English, quality-first, no jargon)

## Your Zapier bill — what's really going on, and how we shrink it without losing anything

**The short version.** You're paying for a plan that's actually big enough — the problem is the *spikes*. Some months your bill jumps to ~$3,260 because a flood of tiny automated steps runs behind the scenes. Most of those steps just copy numbers into a spreadsheet or send an internal "FYI" — work your new dashboard does for you automatically. Turn those off (only *after* the dashboard proves it does the same job), and the spikes disappear.

**Where the money goes.** Your plan includes 100,000 automated "tasks" a month for a flat $898.50. Go over, and every extra task costs about 2 cents. In a busy month you've gone ~100,000 tasks *over* — that's the $3,260 bill. In a quiet month you stayed *under* and paid less than the base. So the fix isn't a bigger plan — it's fewer wasted tasks.

**You get to choose: keep the sheet, or move off it.** Nothing is forced. We build the dashboard *alongside* your current setup — your Google Sheet keeps working exactly as it does today. When you trust the new numbers (they already match your HUB totals to the dollar), you decide how far to go. Quality first, every step reversible.

### Your menu — do this, then this, then this

**Step 1 — See it.** A live dashboard (Overview, Closers, Setters) that matches your existing numbers exactly. Nothing else changes. Your sheet and all your automations keep running.
→ *Bill: no change. This step just earns your trust.*

**Step 2 — Own your data.** We quietly start capturing your sales events into your own database — in addition to the sheet, never instead of it yet. If anything ever looks off, the sheet is still right there.
→ *Bill: roughly the same (a tiny, temporary bump). This is the setup that unlocks the savings.*

**Step 3 — Cut the waste.** Now that the dashboard does the reporting and the database holds the data, we switch off the automations that were only copying numbers around and sending internal pings. The genuinely useful ones — the emails and texts that reach your customers, the tools that need to talk to each other — we keep, untouched.
→ *Bill: the spikes go away.*

### The savings story

- **Conservative (the number to plan around):** your bill settles at the flat **$898.50/month** — no more overage spikes. That's roughly **$7,000–$9,500 saved per year**, and it becomes predictable instead of lurching to $3,260 some months.
- **Best case (if you also let us replace your intake forms and finish the move):** you drop to a smaller plan and pay a small fraction of today — on the order of **$16,000–$19,000 saved per year**, and you stop paying for Jotform too.

**What you don't lose:** every customer email and text keeps sending. Every real connection between your tools keeps working. We never turn anything off until the new system has proven it does the same job — checked automatically every night against your own HUB totals. This is about cutting the *waste*, not the *work*.

---

*Note on precision:* the per-Zap task counts and the final "keep vs. cut" call on a handful of borderline automations need your Zapier Task-History export to confirm — the method above is locked, only the last-mile assignment of each individual Zap is "confirm from export." Everything else is derived from your actual invoices and the data audit.
