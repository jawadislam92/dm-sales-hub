# Daily Mentor Sales Platform — Phased Implementation Plan

**Status:** approved design, ready to build.
**Author's note:** This plan is the executable synthesis of six design sections (schema, ingestion, metrics, app/frontend/auth, deploy/ops, cost) and two adversarial reviews (keying/upsert integrity, metric-port fidelity). Where a review overturned a design assumption, **the review wins and the plan reflects the corrected design** — this is called out inline so nobody rebuilds against the broken version.

## The one correction that reshapes the whole build (read first)

The design docs assumed `Call ID` (or a Close opportunity id) is the stable per-booking key and that ingestion is "upsert on that key." **The data disproves this and it is measured, not hypothetical:**

- `Call ID` is populated on **354 of 23,385 Bookings rows (1.5%)**. `bookings.call_id TEXT PRIMARY KEY` would collapse the table to ~355 rows and zero out every dashboard.
- There is **no Close opportunity/lead-id column anywhere** in the 38 Bookings columns.
- The synthetic fallback key `(booking_date | scheduled_call_date | email | lead_owner)` is **not unique** — it merges **9,730 distinct rows** across 151 collision groups; 77 groups hold genuinely different bookings (proven case: one `Closed / $5,000` row and one `$0 / Setter Qualified Booked Call` row for the same lead/date/owner would merge and silently delete the $5,000).
- The reconciling oracle (`tune.py`) and the overview compute (`compute_dash.py`) **never reference any id**. They count **raw Bookings rows** keyed on person + date + status + cash. A booking *is* a sheet row.

**Therefore the corrected model, which this plan builds:**

1. **The DB is a row-faithful, append-first mirror of Bookings.** Surrogate `id bigserial` PK. Backfill **inserts 1:1 by sheet row position**, never upserts, never dedup-merges.
2. **Keyed upsert is a narrow LIVE-only optimization**, applied **only** to rows that carry a proven Zap-payload id. Until the Zap export confirms such an id + an event timestamp exist, the live path is **append + nightly-sweep reconciliation**, not idempotent upsert.
3. **The go-live gate is the HUB assertion** (`June closer cash = $455,674.90`; Sam Aujla shown 50 / qual 43 / closed 27 / close 62.79%), **not** a raw row count.

Every task below is written to this corrected model.

---

## Blocked-on-external tasks (surface these to the client immediately)

These block specific tasks, not the whole build. Phase 1 proceeds fully without them.

| Ref | Blocker | Blocks | Needed from |
|---|---|---|---|
| **BLK-1** | Does the create/update Zap payload carry a stable Close **opportunity/lead id**? | Live keyed-upsert path (T2.4); idempotency | Zapier Zap export / Close API |
| **BLK-2** | Does the payload carry an **event timestamp** (`occurred_at` / Close `date_updated`)? | Out-of-order conflict resolution (T2.4) | Zapier export / Close |
| **BLK-3** | Do update-Zaps send the **full booking row** or a partial delta? | Whole-row LWW safety (T2.4) | Zapier export |
| **BLK-4** | **Which** of the ~147 Zaps write Bookings (create vs update vs the 21,713-row failed producers)? | Which Zaps get the parallel POST (T2.3) | Zapier export |
| **BLK-5** | Google Sheets API service-account access to "Sales \| Master" | Backfill via API + nightly sweep (T1.3, T2.6) | Client Google Workspace admin |
| **BLK-6** | Per-Zap **task-count** history + step config | Final per-Zap keep/cut assignment (Phase 3) | Zapier Task History export |
| **BLK-7** | Split-payment shape: one `Total Cash Collected` field vs multiple rows | Live payment handling (T3.x) | Close/Stripe/Elective + export |

**Fallback if BLK-1/2/3 resolve "no":** the live path stays append-only + nightly sweep. The platform still reconciles to $455,674.90 to the dollar — it just loses idempotent live upsert until a real key exists. This is acceptable for v1; do not block the build on it.

---

# Repository structure & scaffold

One Node/TypeScript app + Postgres, Dockerized and env-driven, portable to Vercel + managed Postgres with no rewrite.

```
daily-mentor-platform/
├─ docker-compose.yml            # app, worker, postgres(+WAL), pgbackup, caddy
├─ Caddyfile                     # TLS + webhook rate-limit/hardening
├─ Dockerfile                    # multi-stage: build FE + compile TS -> slim runtime
├─ .env.example                  # every key, blank — the portability checklist
├─ .dockerignore .gitignore
├─ package.json  tsconfig.json
├─ migrations/                   # forward-only, platform-neutral SQL
│  ├─ 0001_extensions_enums.sql
│  ├─ 0002_config_users_catalog.sql   # sources, source_field_mappings, users, tab_catalog, lead_status_classes
│  ├─ 0003_raw_layer.sql              # raw_events, raw_rows, quarantine, reconciliation_runs
│  ├─ 0004_typed_bookings.sql         # bookings (surrogate PK) + indexes
│  ├─ 0005_typed_mirrors.sql          # leads, payments, refunds, residuals, elective_orders,
│  │                                  #   jotform_closer/setter, call_dashboard, leads_over_time, hub_closers/setters
│  └─ 0006_seed.sql                   # QSET/SHOWN vocab, tab_catalog from extract_site cols/types, bootstrap admins
├─ src/
│  ├─ server.ts                  # Fastify entry (static UI + read API + /ingest + admin API)
│  ├─ worker.ts                  # scheduler + ingest queue drainer (same image, diff entrypoint)
│  ├─ healthcheck.ts             # hits /healthz (DB reachable + fast HUB spot-check)
│  ├─ backup.ts                  # pg_dump -> offsite S3, PITR shipping
│  ├─ config/
│  │  └─ env.ts                  # validate-once env parsing (zod); the ONLY reader of process.env
│  ├─ db/
│  │  ├─ pool.ts                 # pg pool; app role = SELECT-only, worker role = writes
│  │  ├─ queries.ts              # bookings projection to buildBK shape (cs/bd/o/s/st/cash/fees)
│  │  └─ migrate.ts              # runner for migrations/*.sql
│  ├─ engine/
│  │  ├─ metrics.ts              # *** VERBATIM PORT *** buildBK/aggregate/series/rate/statusMix + QSET/SHOWN/PALETTE
│  │  ├─ charts.ts               # verbatim svgCombo/svgDonut (server or client — unchanged output)
│  │  └─ dateEngine.ts           # verbatim parseD/isoD/addDays/daysBetween/monthStart/End/presetRange
│  ├─ ingest/
│  │  ├─ route.ts                # POST /ingest contract (source-tagged, HMAC, idempotent)
│  │  ├─ router.ts               # sources + source_field_mappings -> coerce -> upsert/insert
│  │  ├─ coercers.ts             # money_usd/date_pst/yesno_bool/trim — match extract_site conv + engine +||0
│  │  └─ replay.ts               # re-run raw_events window through router
│  ├─ backfill/
│  │  ├─ backfill.ts             # Sheets API (or xlsx) -> raw_rows -> bookings (INSERT 1:1)
│  │  └─ scrub.ts                # tab allow-list, blank-row drop, broken-formula coerce, no-date quarantine
│  ├─ reconcile/
│  │  ├─ sweep.ts                # nightly sheet-diff (repair/flag)
│  │  ├─ hubAssert.ts            # tune.py ported -> assertions -> reconciliation_runs
│  │  └─ statusDrift.ts          # DISTINCT lead_status ⊆ frozen set tripwire
│  ├─ api/
│  │  ├─ dashboards.ts           # /api/overview /api/closers /api/setters
│  │  └─ tabs.ts                 # /api/tabs, /api/tabs/:name?page (paginated raw grids)
│  ├─ auth/
│  │  ├─ magicLink.ts  session.ts  allowlist.ts  requireAdmin.ts
│  ├─ admin/
│  │  └─ routes.ts               # sources, mappings, users, jobs, raw-events, replay
│  └─ web/                       # ported prototype: index.html + app.js + styles.css (blob/inflate removed)
├─ tests/
│  ├─ hub.parity.test.ts         # CI: June cash = $455,675, Sam 50/43/27/62.79 — the release gate
│  ├─ engine.fidelity.test.ts    # date-slice, cash>0 strict, QSET/SHOWN exact, trim, 92/93 boundary
│  └─ fixtures/                  # frozen snapshot for deterministic parity
└─ docs/
   ├─ PLAN.md                    # this file
   ├─ spec-schema.md  spec-ingestion.md  spec-app.md  spec-deploy.md  spec-cost.md
   └─ RUNBOOK.md                 # restore drill, cutover, replay-after-mapping-fix
```

**`package.json` dependencies (minimal, portable):**
- Runtime: `fastify`, `pg` (+ `kysely` or `drizzle-orm` for typed queries), `zod` (env + payload validation), `pino` (structured logs), `googleapis` (Sheets read), `node:crypto` (HMAC, magic-link tokens), an S3 client (`@aws-sdk/client-s3`) for offsite dumps, a small cron lib (`node-cron` / `croner`) for the in-process scheduler, `nodemailer` (magic-link email).
- Dev: `typescript`, `tsx`, `vitest`, `@types/*`, `esbuild` (bundle `web/` if desired).
- **Engine module imports nothing from `pg`, `fs`, or Fastify** — pure functions over in-memory records. This is the discipline that keeps numbers identical across hosts and lets the HUB test run the exact dashboard code.

**Docker / env:** `docker-compose.yml` = five services (`app` ×2 replicas start-first, single `worker`, `postgres` w/ `wal_level=replica` + archive, `pgbackup` sidecar, `caddy`). Only Caddy is exposed. `.env.example` lists every key (DB DSN, `SESSION_SECRET`, per-source `WEBHOOK_SHARED_SECRET`, `GOOGLE_SA_JSON`, `SHEETS_SPREADSHEET_ID`, `HUB_ASSERT_MONTH=2026-06`, `HUB_ASSERT_CLOSER_CASH=455675`, `ALERT_WEBHOOK_URL`, `SMTP_URL`, `BACKUP_S3_*`, `ZAPIER_CATCH_HOOK_URL` reserved/unset). Nothing in app code reads a secret from anywhere but `process.env` via `config/env.ts`.

---

# PHASE 1 — SEE IT + OWN THE SHAPE (v1: read-only, full parity)

**Goal:** three dashboards (Overview / Closer / Setter) + 12 read-only raw tabs, live from Postgres, reconciling to the HUB to the dollar, behind email allow-list auth, deployed on the VPS. **Spend unchanged** — no Zaps touched yet.

**Build order is deliberate: engine + parity test FIRST.** Everything else is scaffolding around a proven-correct engine.

### T1.0 — Repo scaffold & Docker skeleton
- Create the tree above; `docker compose up` brings up empty `app` + `postgres` with a `/healthz` returning DB-reachable.
- `config/env.ts` validates all env once at boot; missing/invalid = crash loud.
- **Acceptance:** `docker compose up` healthy; `GET /healthz` 200; a deliberately-missing env var fails boot with a named error.

### T1.1 — Port the metric engine VERBATIM  ⟵ do this before any DB work
Port into `src/engine/metrics.ts`, `charts.ts`, `dateEngine.ts` from `source/dashboard.template.html`, character-for-character:
- `buildBK` (line 193): 7 columns, `cs/bd = (''+(r[x]||'')).slice(0,10)`, `o/s = (…).trim()`, `st = r[st]||''` (**not** trimmed), `cash/fees = +r[x]||0`.
- `aggregate` (252), `series` (260), `rate` (259), `statusMix` (268); `QSET`/`SHOWN` (157–158), `PALETTE`, `MON`.
- `svgCombo`/`svgDonut` (238/248); `parseD`…`presetRange` (185–283); `TODAY` **injected as config**, pinned to `2026-06-30` in fixtures.

**Fidelity guards the port MUST honor (from the metric-port review — each is a real drift trap):**
- **Date = raw 10-char string prefix, never a parsed/tz-shifted `Date`.** Store/compare the date as the leading 10 chars of the source cell. Do **not** normalize to a Postgres `date` before the engine sees it, or a `2026-06-30T23:00-07:00` call shifts to July in UTC and leaves June.
- Range compare is **string** `>=from && <=to`, inclusive both ends. Never a `Date`-object `<= to` (excludes the `to` day).
- Person key = `.trim()` **only** — no case-fold, no whitespace collapse, no alias merge. Use JS `String.prototype.trim` semantics in TS (the prototype is ground truth), and make the HUB assert use the **same** trim, not Python `.strip()` (they diverge on exotic Unicode whitespace).
- `closed = cash > 0` **strictly**, cash-not-status. Refunds (negative cash) lower `cash` but never touch `closed`. **Never** materialize a stored `is_closed` from status.
- `cash = Number(x) || 0` (use `Number`, not `parseFloat`; `+""→0`, `+"$1,790"→NaN→0`). Ingest must deliver **clean bare numbers** so `Number(x)` parses — do not add a locale currency parser that would make `"$1,790"` parse to 1790 where the prototype yields 0.
- Status membership is exact-case, exact-spacing `Set.has` on **untrimmed** status. `" - "` is space-hyphen-space; `"Closed "` (trailing space) ≠ `"Closed"`.
- Trend threshold: `span = daysBetween(from,to)+1`, `daily = span <= 92` (92→daily, 93→monthly). `parseD` = `new Date(s+'T00:00:00Z')` (UTC, no DST).
- Column resolution: `findIndex` trim+lowercase; on `-1` **fail loudly** (startup assertion all 7 required columns resolve ≥0), never silently produce zeros.
- **Acceptance:** engine module has zero infra imports; unit tests in `engine.fidelity.test.ts` cover each guard above (date-slice boundary June/July, `cash>0` vs `>=0`, QSET/SHOWN checksum + union derivation, trim vs JS trim on distinct owner values, 92/93 boundary, `-1` column throws).

### T1.2 — HUB parity test as the release gate  ⟵ immediately after T1.1
Port `tune.py` to `tests/hub.parity.test.ts` and `src/reconcile/hubAssert.ts`. Convert every **printed** comparison in `tune.py` into a **hard assertion** (tune.py currently asserts nothing — it can drift green forever).
- **Per-closer** June-2026 call-date: `bookings==HUB.bookings`, `shown==HUB.showed`, `qual==HUB.qual`, `closed==HUB.dmpn+HUB.dma` (None→0), `round(cash)==round(HUB.cash)` (integer dollars).
- **Named anchors:** Sam Aujla 50/43/27, close 62.79%; **team June closer cash == $455,674.90 to the dollar**.
- **Grand totals** asserted too (catches offsetting per-person errors that still total-match).
- **Setter side** reconciled identically (`tune.py` only checks closers — the ported test must also assert setters, or setter attribution drift slips through).
- Status-drift canary: assert no Bookings `Lead Status` value differs from a QSET/SHOWN member only by whitespace/case.
- **Acceptance:** test runs against `fixtures/` and passes to the dollar; runs in CI on every deploy; a one-cent perturbation of any closer's cash fails it.

### T1.3 — One-time backfill (INSERT 1:1, corrected model)  ⟵ blocked on BLK-5 for the API path; xlsx path is unblocked
Port `extract_site.py`'s scrub into `src/backfill/`. Read via Sheets API (preferred, reused by the sweep) **or** the committed `.xlsx` (unblocked fallback for a first run).
- **Tab allow-list:** exactly the 12 tabs in `extract_site.py` `TABS`. Never read the 7 junk tabs (`Bookings - zapier failed`, `helper_sheet`, the `old*`/`Copy of*` HUBs).
- **Scrub (verbatim from `conv()`/blank-row drop):** dates→`YYYY-MM-DD`, bools→`Yes/No`, blank-row drop (`all cells==""` → skip). Coerce broken-formula literals (`#REF!/#N/A/#VALUE!/#DIV/0!`) → `""` (text) / `0` (money) — **cell-level, never quarantine the row**; preserve the original error string in `raw_extra.__coercion_errors__`.
- **Stage everything in `raw_rows` first** (verbatim per-tab landing, `{colname:value}` jsonb, original row index).
- **Project Bookings into `bookings` by INSERT, 1:1 by sheet row position** (`source_row_index`). **No synthetic merge key. No dedup-merge. Delete the "keep latest on collision" rule** — it is the mechanism that deletes the $5,000 deal.
- **Quarantine, don't drop:** Bookings rows with no parseable date in *either* date column → `raw_rows` `quarantine_reason='no_date'` (measured ~9,583 rows; all cash $0), excluded from `bookings` and from the sweep's "missing webhook" alert. The 21,713 failed-Zapier rows are handled by **not reading the failed tab** (they are not in the 23,385).
- **Trim** `Lead Owner`/`Attributed Setter Full Name` on store (engine trims).
- **Acceptance (corrected gate — NOT `count==23385`):**
  1. `raw_rows(tab='Bookings') == 23385` (verbatim landing).
  2. `count(bookings)` == the frozen metric-eligible count derived once from `extract_site` output (has a parseable basis date), **not** 23,385.
  3. **The T1.2 HUB assertion passes** against the backfilled `bookings` (this is the real gate).
  4. Per-closer June book/shown/qual/closed/cash equal `tune.py`'s raw counts (Sam 131 June rows / 50 / 43 / 27; team cash 455674.90) — a bare count check would pass at 13,655 and mask a merge bug, so assert per-closer.

### T1.4 — Read API + engine boundary
- `db/queries.ts` projects `bookings` into the **exact `buildBK` record shape** (`cs/bd/o/s/st/cash/fees`) as a SQL SELECT, feeding the ported `aggregate/series/statusMix` unchanged. The date columns come back as the **10-char text** the engine expects (store the basis dates as text or `TO_CHAR(...,'YYYY-MM-DD')` in the projection — never let a tz round-trip happen).
- Endpoints: `GET /api/overview`, `/api/closers`, `/api/setters` (accept `from,to,basis`), `GET /api/tabs`, `GET /api/tabs/:name?page=` (paginated raw grids). `overview.new_returning` + `overview.lead_sources` served from precomputed aggregates (as the prototype reads from `dash.json`).
- App DB role = **SELECT-only** on typed tables (structural read-only).
- Indexes tuned to the engine's scan: `(scheduled_call_date_pst, lead_owner)`, `(scheduled_call_date_pst, attributed_setter_full_name)`, and the `booking_date` pair, all `WHERE is_quarantined=false` (partial, matches the engine's read predicate).
- **Acceptance:** `/api/closers?from=2026-06-01&to=2026-06-30&basis=call` returns numbers byte-identical to the T1.2 fixture; raw-tab endpoint paginates 23,385 Bookings rows without loading all into memory.

### T1.5 — Frontend port (reuse the framework-free prototype)
- Copy all markup/CSS/SVG/virtualized-grid/date-engine from `dashboard.template.html` into `src/web/`. **Delete only** the `#payload`/`#dash` `<script>` blobs and the `DecompressionStream` inflate in `boot()`; replace with `fetch()` to the read API.
- Raw-tab grid: keep the `total * ROWH(34px)` spacer virtualizer; convert to fetch-on-scroll pages (do not rewrite `renderRows()`; shim the data source).
- Keep untouched: `svgCombo`, `svgDonut`, `dateBar`, `presetRange`, CSS tokens, drawer, status-chip coloring.
- `TODAY` injected from server config (pinned `2026-06-30` until live data arrives; then PST-calendar "today", never UTC `new Date()` — at 5pm PST UTC is already tomorrow and would include a partial future day and shift default ranges).
- **Acceptance:** all three dashboards + 12 tabs render from the API; date-basis toggle and per-day/per-month trend behave exactly as the prototype; a visual diff of the June default view matches the prototype screenshot.

### T1.6 — Auth (email allow-list, passwordless)
- Magic-link: enter email → if on allow-list, emailed a signed one-time link (`SMTP_URL`) → one `HttpOnly/Secure/SameSite=Lax` signed session cookie (`SESSION_SECRET`). Not on list → generic "ask an admin" (no user enumeration).
- Roles `viewer` / `admin`. Read-only enforced **structurally** (no write routes exist for viewers) **and** by the SELECT-only DB role. `requireAdmin` **404s** the admin surface for viewers.
- Bootstrap admins from `ALLOWLIST_BOOTSTRAP` on first boot.
- **Acceptance:** allow-listed email gets in via link; non-listed email gets the generic message; a viewer hitting an admin route gets 404; session survives restart (stateless, cookie-signed).

### T1.7 — `/ingest` endpoint (contract only, live-append; keyed upsert gated on BLK-1)
Ship the generic seam now so Phase 2 is additive. **Structural correction baked in:** surrogate PK, nullable `external_id`, insert-by-default.
- `POST /ingest`: `{source, external_id?, event_type, occurred_at?, schema, payload}`, per-source `WEBHOOK_SHARED_SECRET` (HMAC/bearer, **not** the session), `Idempotency-Key` optional.
- Every accepted call → append to `raw_events` (immutable) **before** any mapping. Router reads `sources` + `source_field_mappings`, coerces, then:
  - **If a proven payload id exists** (BLK-1 resolved yes) → partial-unique upsert on `external_id WHERE external_id IS NOT NULL`, ordered by `occurred_at` (BLK-2), whole-row (BLK-3).
  - **Else** → **insert + let the nightly sweep reconcile** (no idempotent key yet).
- Conflict-resolution watermark = **`occurred_at` + ingest_seq tiebreak** — a single clock everywhere. **Remove any `last_event_id >` guard** (that orders by arrival, so a replayed old event with a higher serial wrongly wins).
- Responses: `202` (logged), `202 duplicate:true` (idempotent replay), `400/401/403`, `409` (stale update, stored-not-applied), `422` (valid envelope, unmapped payload → flagged `needs_mapping`), `429/5xx` (retryable).
- **Acceptance:** posting a well-formed event with a valid secret returns 202 and appends to `raw_events`; a duplicate (same dedupe hash) is a no-op; a bad secret is 401; an unmapped field lands raw and flagged, never lost.

### T1.8 — Admin surface (config-driven, no-deploy)
Five panels: **Sources**, **Field mappings** (versioned `active_from/active_to`), **Users** (add/remove allow-list, set role), **Jobs** (trigger backfill/replay, view `reconciliation_runs`), **Raw events** (browse the append-only log). Replay = re-run a `raw_events` window through the router after a mapping fix (deterministic, never re-emits webhooks).
- **Acceptance:** an admin can add a `sources` row + a mapping and trigger a replay entirely from the UI, no deploy; a mapping edit closes the old version and opens a new one.

### T1.9 — Deploy to VPS + ops
- `docker-compose.yml` five services; Caddy TLS + `/ingest` `/webhooks/*` rate-limit; `app` ×2 start-first rolling; single `worker`.
- Backups: nightly `pg_dump -Fc` → offsite S3 (30 daily + 12 monthly), WAL archiving for PITR, and the append-only `raw_events` as the deepest replay backstop. Monthly `restore-drill` (throwaway PG, restore, run HUB assert, teardown).
- `/healthz` = DB reachable **+ fast HUB spot-check** on the pinned month, so an engine regression fails the healthcheck and the bad replica never takes traffic.
- **Deploy = forward-only migrations → rolling `app` replace (health-gated) → `worker` replace → post-deploy HUB assertion; fail ⇒ auto-rollback to previous image tag.**
- Alerts to `ALERT_WEBHOOK_URL`: reconciliation drift (critical), webhook silence, health/backup failure.
- **Acceptance:** clean deploy with no visible request errors; a deliberately-broken engine change fails `/healthz` and rolls back; restore-drill restores yesterday's dump and passes the HUB assert.

**Phase 1 exit criteria:** three dashboards + 12 tabs live on the VPS behind auth; HUB assertion green in CI, at backfill end, and nightly; the client can view; **zero Zaps touched; spend unchanged.** This buys trust before any risk.

---

# PHASE 2 — OWN THE DATA (onward capture; app survives without the sheet)

**Goal:** the app becomes a real store fed live, mirrored against the sheet nightly, so the sheet becomes *mirrored, not trusted*. **Blocked on the Zap export (BLK-1..4) and Sheets access (BLK-5) for the live key; the append + sweep path ships without them.**

### T2.1 — Resolve the key blockers (gating design task)
Pull the Zap/Close export; answer BLK-1/2/3/4. Decide per-source `natural_key_field` (`sources` row lets each source pick its own key without schema change). Document which live path each Bookings-writing Zap uses (keyed upsert vs append+sweep).
- **Acceptance:** a written finding per BLK; `sources`/`source_field_mappings` rows created for each confirmed Bookings Zap.

### T2.2 — `external_id_aliases` + adoption/reconciliation match
Because backfill rows are keyless and live rows carry a Close id, they will **not** match on key at cutover → risk of double rows. Build the **adoption step**: when a live id-bearing event content-matches an existing (backfilled) booking on `(scheduled_call_date, lead_owner, prospect_email, cash≈, lead_status)`, **adopt** the id (`external_id`, `key_source='opportunity'`), keep the newer `occurred_at` state, retire the duplicate; log every adoption. Ambiguous matches (multiple candidates) → `quarantine('update_ambiguous_no_key')`, never blind-update. Add `external_id_aliases(booking_id, external_id, source, seen_at)` so Close lead/opportunity **merges** re-link instead of inserting a second row.
- **Acceptance:** a synthetic "backfill row + later live event for the same booking" fixture adopts to one row, not two; an ambiguous 2-candidate case quarantines.

### T2.3 — Wire the parallel Zapier webhook (additive, non-destructive)  ⟵ blocked on BLK-4
Add **one** "Webhooks by Zapier → POST" action to each Bookings-relevant Zap (create + update). The Zap still writes the sheet **untouched** and **also** posts to `/ingest`. Per-source secret set as a static header.
- **Acceptance:** creating/updating a booking in Close produces a `raw_events` row within seconds; the sheet write is unchanged; capturing CREATE and UPDATE both land.

### T2.4 — Live upsert / append correctness (per resolved blockers)
Implement per T2.1: keyed rows → `occurred_at`-ordered whole-row LWW (guard `WHERE EXCLUDED.occurred_at > bookings.occurred_at OR (=... AND EXCLUDED.ingest_seq > bookings.ingest_seq)`); keyless rows → append + sweep. Handle: update-before-create (update inserts as first sighting; later create is stale, stored-not-applied), reschedule (see T2.7), soft-delete (T2.8).
- **Acceptance:** worked cases from the review pass as fixtures — double-fire no-op, out-of-order cash never regresses, update-before-create converges.

### T2.5 — Cutover (self-healing via adoption, not key-equality)
`T0` = the UTC instant the parallel webhooks go live. Backfill reads the sheet snapshot as of `T0`, marks rows `origin='backfill', occurred_at<=T0, estimated=true`. Live events carry real `occurred_at>=T0`. **Adoption (T2.2) dedups the overlap** — timestamps only order *state*, adoption prevents double *rows*. Backfill re-runnable and idempotent.
- **Acceptance:** run backfill during live capture; no booking appears twice; live truth is never overwritten by the stale snapshot.

### T2.6 — Nightly reconciliation sweep + HUB assertion (promote `tune.py` to a job)  ⟵ blocked on BLK-5
`src/reconcile/sweep.ts` runs 03:00: re-read the 12 tabs (scrubbed), diff vs `bookings` by content:
- **In sheet, not in DB** → missed webhook → repair (insert, `origin='recon_backfill'`), count + alert if over threshold. **Skip keys tombstoned by a delete event** (T2.8) so cancellations don't resurrect nightly.
- **In DB, not in sheet** → never auto-delete; flag for human.
- **Field drift** → resolve by `occurred_at`; **never overwrite a webhook-fresh row (`estimated=false`) with sheet-derived (`estimated=true`) data** (the "reconcile clobbers fresh data" hazard — a hand-edited sheet cell has no reliable timestamp).
Then run `hubAssert.ts` (T1.2 logic) against live `bookings`; write a `reconciliation_runs` row. Red assertion ⇒ page + block "green for the day". Add `statusDrift.ts`: `SELECT DISTINCT lead_status ⊆ frozen set`, alert on any new value.
- **Acceptance:** a deliberately-dropped webhook is detected and repaired overnight; a hand-edited sheet cell is reconciled without clobbering a newer webhook; HUB assertion recorded nightly.

### T2.7 — Reschedule handling (period-close snapshot)
`Scheduled Call Date (PST)` is mutable; a call moved June→July would silently leave June and turn a green closed-month assertion red. Keep LWW for the live row **but** freeze each month's per-person aggregates into `reconciliation_runs.actual` at month close; the June HUB assertion compares against the **frozen June snapshot**, not a recomputation over mutable rows. (Confirm with client: does a cross-month reschedule *move* the booking in the live view or *stay* in the original month? The append-only log supports both via a temporal query.)
- **Acceptance:** rescheduling a June booking to July does not change the frozen June assertion; live view reflects the move.

### T2.8 — Soft-delete / cancellation
Deletes are **soft** (`is_cancelled`/`is_quarantined=true`, excluded by the partial indexes), never hard — a real cancellation must *lower* the count, which soft-exclusion achieves. The sweep skips tombstoned keys when repairing "in sheet, not in DB". (Confirm from export whether cancel/delete Zaps exist at all; if Close cancellations only manifest as a `Lead Status` change, this class is moot.)
- **Acceptance:** a cancel event excludes the booking from dashboards and does not resurrect on the next sweep.

### T2.9 — Write-back socket (STUB only — do not build)
Reserve `outbound_events(id, target_hook_url, payload, status, attempts)` in the spec; `writeBack(event)` interface is a no-op that logs intent; `ZAPIER_CATCH_HOOK_URL` reserved/unset. Handler returns 501.
- **Acceptance:** the stub exists, is env-gated off, and ships no live behavior.

**Phase 2 exit criteria:** live capture on Bookings Zaps; nightly sweep + HUB assertion green against live data; adoption prevents cutover double-count; the app can serve correct numbers even if the sheet were frozen. **Spend ticks up slightly** (one extra task per already-firing Zap) — this is the temporary investment that unlocks Phase 3.

---

# PHASE 3 — CUT THE GLUE (retire/move Zaps; make the sheet optional; kill the spend)

**Goal:** collapse the Zapier overage, make the sheet optional, cut Jotform. **Blocked on per-Zap task history (BLK-6) for final assignment; bucket rules are locked.** Iron rule: **reproduce-then-retire, one bucket at a time, each step verified by the nightly HUB assertion.**

### T3.1 — Bucket all 147 Zaps  ⟵ blocked on BLK-6
Apply the four-question sort (first "yes" wins): (1) app already holds/can compute it → **RETIRE**; (2) human-facing notification we can reproduce → **RETIRE (P3)**; (3) high-volume mechanical tool↔tool sync with a native webhook/API → **MOVE-TO-FREE**; (4) genuine branching business glue, revenue-critical, no clean native path → **KEEP**. Confirm per-Zap task counts + hidden branching from the Task History export.
- **Acceptance:** every Zap assigned to a bucket with its task-count; the RETIRE/MOVE list ranked by task volume (Sheet create/update Zaps expected highest, then [Reporting], then notifications).

### T3.2 — Retire the Sheet create/update Zaps (biggest lever)
Once the app (not the sheet) is the reader, these writes serve nothing the app needs and are the #1 task multiplier (create + N updates per booking). Turn off **after** T2.6 proves the app reconciles without them. Sheet becomes optional (comfort backup or off — client's call).
- **Acceptance:** sheet-write Zaps off; nightly HUB assertion stays green; overage tasks drop measurably in the next Zapier cycle.

### T3.3 — Retire [Reporting] + notification Zaps
Reporting → app computes every metric live (reconciles to HUB). Notifications → reproduce as an in-app activity feed + one native digest post from our backend, then retire per-event Slack/email Zaps.
- **Acceptance:** reporting/notification Zaps off; no metric or alert regression; in-app feed live.

### T3.4 — Move Close/Stripe/Calendly/Elective/Manychat mirrors to free direct webhooks
Replace each mechanical Zapier hop with a native tool webhook posting straight to `/ingest` at $0/event; append-only log means no field is lost. Payment events **update the existing booking's cash / a separate `payments` table** — they must **not** create `bookings` rows (a Stripe Zap + an Elective Zap for the same deal would double-count). Until a shared key is proven (BLK-7), reconcile booking cash from the sheet's single `Total Cash Collected` on the nightly sweep, not summed live.
- **Acceptance:** at least the 2–3 highest-volume mirrors run on native webhooks; cash reconciliation unchanged; split-payment fixture does not double-count.

### T3.5 — Replace Jotform with the custom form builder (STUB→BUILD)
Phase-2 Socket A goes live: our form submit posts to `/ingest` **and** to a Zapier catch-hook so Close/downstream still fire. Retire Jotform→Close Zaps, then Jotform itself (cuts that subscription too). Ingest is already generic — this is new `sources` + `source_field_mappings` rows, **zero typed-table change**.
- **Acceptance:** a form submit lands in `raw_events` and fires the catch-hook; Close still receives the lead; Jotform Zaps retired without lead loss.

### T3.6 — Right-size the plan
Once usage is durably under allowance every month, drop Team → the smaller tier for the additional saving.
- **Acceptance:** two consecutive cycles under 100,000 tasks; plan downgraded; savings realized.

**Phase 3 exit criteria & savings (tied to $898.50 base + $0.0226/task):**
- **Conservative (quote this):** overage eliminated, bill floors at **$898.50/mo (~$10,782/yr)** → **~$7.2–9.6k/yr saved (~40–48%)**, spikes gone. Biggest single lever is retiring the Sheet create/update Zaps.
- **Optimistic (if Jotform replaced + migration finished + tier dropped):** **~$74–150/mo (~$900–1,800/yr)** → **~$16–19k/yr saved (~85–90%)**, plus Jotform subscription cut.
- **Guardrail:** never retire before reproduce; KEEP list deliberately generous (any customer-facing side effect or real branching stays); append-only log protects against unmapped-field loss; every cut verified by the nightly HUB assertion.

---

## Cross-cutting guardrails (apply to every phase)

- **The engine is a frozen unit.** No infra concern touches `src/engine/`. The HUB assertion is the proof it survived every deploy, restore, and host move.
- **Nothing is ever dropped, only quarantined.** `raw_events` (append-only) + `raw_rows` are the source of truth; typed tables are a replayable projection. Truncate + replay reconstructs current state exactly.
- **One conflict clock:** `occurred_at` + ingest_seq. No arrival-order guard anywhere.
- **Portability is a test, not a hope:** Phase-2 sockets slot into the generic ingest/mapping machinery with zero typed-table change; the Vercel + Neon lift is `DATABASE_URL` swap + env paste + convert the 4 cron jobs to Vercel Cron routes (already advisory-locked) + drop Caddy/pgbackup + run the HUB assertion once. Green = migration correct by the same standard as every deploy.

## Ground-truth files this plan is built on (absolute)

- `C:\Users\jawad\Downloads\Pavan\dashboard-build\source\dashboard.template.html` — metric engine to port verbatim: `QSET`/`SHOWN` L157–158, `buildBK` L193–199, `aggregate`/`series`/`rate`/`statusMix` L252–271, `svgCombo`/`svgDonut` L238/248, date engine L185–283, `TODAY="2026-06-30"` L145.
- `C:\Users\jawad\Downloads\Pavan\dashboard-build\pipeline\extract_site.py` — 12-tab allow-list L8–10, `conv()` L13–23, blank-row drop L53, type vocabulary (`date|num|money|pct|text`).
- `C:\Users\jawad\Downloads\Pavan\dashboard-build\pipeline\tune.py` — HUB oracle; keys on person+date+status+cash, never `Call ID`; port to the parity test + nightly assert.
- `C:\Users\jawad\Downloads\Pavan\dashboard-build\pipeline\compute_dash.py` — overview aggregate source (`new_returning`/`lead_sources`); also keys on person+date+status+cash.
- `C:\Users\jawad\Downloads\Pavan\dashboard-build\data\clean.json` — `health` L447–462 (`failed_zapier_rows=21713`, `broken_formula_cells_approx≈27000`, 7 `junk_tabs`, `bookings_rows=23385`, `leads_rows=44974`); `closers_total.cash=455674.9`; Sam Aujla scorecard.
- `C:\Users\jawad\Downloads\Pavan\dashboard-build\data\dash.json` — overview aggregates the API serves.
- `C:\Users\jawad\Downloads\Pavan\dashboard-build\README.md` — exact metric definitions ("keep these EXACT") L84–101.