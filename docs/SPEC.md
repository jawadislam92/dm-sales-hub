# Daily Mentor Sales Platform — Master Architecture Specification

**Status:** v1 build spec, ready to implement.
**Owner business:** Daily Mentor (dailymentor.co) — high-ticket DTC-founder mentorship, $1,790–2,490/mo memberships, run by a setter/closer sales floor.
**What this is:** the single authoritative spec for turning the existing read-only dashboard *prototype* into a hosted, self-updating **sales data platform** — one that reconciles to the team's HUB numbers to the dollar, and that lets the client progressively move off their Google Sheet and cut Zapier/Jotform spend without losing quality.

This document folds in the fixes surfaced by three adversarial reviews (Close-ID keying, metric-port fidelity, ingest/backfill integrity). **Every fix in those reviews is a requirement here, not an option.** Where a review's claim was checkable against the real data, it was measured directly against `data/site_data.json` (23,385 Bookings rows) before being written in — those measurements are cited inline.

---

## Table of contents

1. [Overview & goals](#1-overview--goals)
2. [Architecture](#2-architecture)
3. [Data model](#3-data-model)
4. [Ingestion, keying & reconciliation](#4-ingestion-keying--reconciliation)
5. [Metric engine port & the HUB-accuracy guarantee](#5-metric-engine-port--the-hub-accuracy-guarantee)
6. [The app, auth & admin](#6-the-app-auth--admin)
7. [Extensibility](#7-extensibility)
8. [Phase-2 sockets (designed, deferred)](#8-phase-2-sockets-designed-deferred)
9. [Deployment & portability](#9-deployment--portability)
10. [Cost audit & the 3-phase Zapier wind-down](#10-cost-audit--the-3-phase-zapier-wind-down)
11. [Open questions to confirm with the client](#11-open-questions-to-confirm-with-the-client)
12. [Open items to confirm from the Zap/Close export](#12-open-items-to-confirm-from-the-zapclose-export)
13. [Build order](#13-build-order)

---

## 1. Overview & goals

### 1.1 What exists today

The prototype is a **single self-contained HTML file** (`source/dashboard.template.html`, ~354 lines) that embeds a gzip+base64 snapshot of the "Sales | Master" Google Sheet and renders it as a navigable workspace plus three live dashboards (Overview, Closer Performance, Setter Performance). It is framework-free: hand-drawn SVG charts, a custom-virtualized grid that scrolls a 45k-row tab smoothly, and a complete in-browser metric engine (`buildBK` → `aggregate`/`series`/`rates`/`statusMix`). It is read-only and reconciles to the team's HUB tabs exactly.

**The data path today** is fragile and expensive:

```
tools (Close.com CRM, Jotform, Calendly, Elective, Stripe, Manychat, SplitIt)
   └─▶ ~147 Zapier Zaps ──▶ "Sales | Master" Google Sheet (24 tabs, messy)
                                   └─▶ one-time snapshot ──▶ prototype HTML
```

The Bookings tab (23,385 rows) is the star; the engine derives every metric from it. Verified anchors (June 2026, call-date basis): **closer-team cash = $455,674.90**; **Sam Aujla: 131 bookings / 50 shown / 43 qualified / 27 closed / 62.79% close rate**. Re-measured directly from `site_data.json` during this spec — reproduced to the dollar and the unit.

### 1.2 What we are building

A **platform, not a read-only report.** Same three dashboards and the same 12 raw-data tabs, but:

- served from **one Node/TypeScript app + Postgres**, self-hosted on the agency VPS, built **portable** (Docker + env-driven) to lift to Vercel/managed Postgres later with no rewrite;
- fed by a **hybrid ingestion**: a one-time scrubbed backfill of sheet history, then onward live capture from Zapier via a generic `POST /ingest` endpoint;
- carrying an **append-only raw event log** so any field we didn't map today can be re-mapped and *replayed* from history tomorrow — with zero re-pull;
- fronted by an **admin surface** so a non-dev can add a Zap source, add a field mapping, allow-list a user, and replay events, with no deploy.

### 1.3 Strategic goal

Let the client **progressively move OFF the sheet AND cut Zapier/Jotform spend without losing quality.** The dashboard earns trust first (Phase 1), then the platform becomes the real store (Phase 2), then the redundant/waste automations are retired one bucket at a time (Phase 3) — each step reproduce-then-retire, verified nightly against the HUB. Extensibility (generic ingest, raw event log, config-driven mappings, admin surface) is a first-class v1 requirement precisely because it is what makes that wind-down possible.

### 1.4 Non-negotiable invariants

These govern every decision below. If a design choice threatens one of them, the design choice is wrong.

1. **The metric engine is a frozen unit.** `buildBK`/`aggregate`/`series`/`rate`/`statusMix` (plus the `SHOWN`/`QSET`/`PALETTE` constants and the `svgCombo`/`svgDonut` renderers) are lifted **verbatim** from the prototype JS into one TypeScript module. Re-implementing them in another language is forbidden — it would break HUB reconciliation. No infrastructure concern (Docker, Postgres, Vercel) may touch that module; it is pure functions over in-memory records.
2. **The reconciling engine counts raw Bookings rows — it does not key or dedup.** `tune.py` does `book += 1` per raw row; `aggregate()` does `m.bookings++` per element of `BK`, and `BK` is a 1:1 map of sheet rows with no dedup. **A booking = a Bookings row. Full stop.** Therefore the DB must be a **row-faithful, append-first mirror** of Bookings; "upsert on a stable key" is a narrow live-only optimization that must be *proven not to collapse distinct rows*, never a correctness primitive.
3. **Nothing is ever dropped — only quarantined.** Every rejected sheet row and every unroutable webhook lands in the raw layer with a reason code, still queryable, still replayable.
4. **The HUB assertion is the gate on everything.** Backfill completion, every deploy, every nightly run, and every restore are all "green" only when the ported engine, run for the pinned month against live rows, equals the HUB to the dollar. A red assertion blocks the action and pages.

---

## 2. Architecture

### 2.1 The hybrid pipeline

```
                         ┌──────────────── PHASE 1: SEE IT ────────────────┐
  "Sales | Master"  ───▶ │  one-time BACKFILL (Sheets API, scrubbed)       │
   Google Sheet          │   drop failed-Zapier noise, ignore junk tabs,   │
                         │   coerce broken-formula cells, land verbatim     │
                         └───────────────────────┬─────────────────────────┘
                                                 ▼
   tools ─▶ ~147 Zaps ─▶ Sheet (untouched)       │
              │  (each relevant Zap ALSO gets                                
              │   ONE parallel "Webhooks by                                  
              ▼   Zapier → POST" action)                                     
       ┌──────────────── PHASE 2: OWN THE DATA ───────────────┐             
       │  POST /ingest  ──▶ raw_events (APPEND-ONLY spine)     │             
       │        │  router (sources + source_field_mappings)   │             
       │        ▼  coerce → project into typed tables          │──▶  Postgres
       │  bookings (row-faithful) + 11 mirror tables           │             
       └──────────────────────┬───────────────────────────────┘             
                              ▼                                              
            ┌──── nightly reconciliation sweep ────┐                        
            │  diff sheet ↔ DB (repair missed Zaps) │                        
            │  HUB assertion (tune.py, ported)      │──▶ alert on drift      
            └───────────────────────────────────────┘                        
                              ▼                                              
   read API ──▶ ported metric engine ──▶ 3 dashboards + 12 raw tabs (UI)     
                              │                                              
            ┌──── PHASE 3: CUT THE GLUE ────┐                               
            │ reproduce-then-retire Zaps by  │                               
            │ bucket; sheet becomes optional │                               
            └────────────────────────────────┘                              
```

### 2.2 Stack

- **One Node 20 + TypeScript app** (Fastify), one Postgres 16, self-hosted on the agency VPS via Docker Compose.
- Two entrypoints off the **same image**: `app` (web + read API + `POST /ingest`) and `worker` (in-process scheduler + ingest projector). Splitting them means a long backfill or nightly sweep never blocks a user request, and the web tier can restart without interrupting a running sweep. Because they share the image, the worker runs the *exact same* ported engine the dashboard serves.
- **Caddy** in front for automatic HTTPS (required so Zapier can POST to the webhook endpoint) + a one-line rate-limit on the webhook path.
- **pgbackup** sidecar for nightly offsite `pg_dump` + WAL archiving (PITR).
- DB access via Kysely or Drizzle (typed query builder, standard SQL — no Postgres-only extension beyond `pgcrypto` for `gen_random_uuid`; `citext` optional).

### 2.3 Service topology (VPS)

```
                     Internet :443
                    ┌────▼─────┐
                    │  caddy   │  TLS, reverse proxy, webhook rate-limit
                    └────┬─────┘
                         │ app:3000 (internal only)
        ┌────────────────┼───────────────────────────┐
   ┌────▼────┐     ┌─────▼──────┐              ┌──────▼──────┐
   │   app   │     │  worker    │◄─────────────┤  postgres   │
   │ web+API │     │ scheduler +│  same image  │  16 + PITR  │
   │ +/ingest│     │ projector  │              └──────┬──────┘
   └────┬────┘     └─────┬──────┘                     │
        └───────┬────────┘                      ┌─────▼──────┐
        (both mount the frozen engine module)   │  pgbackup  │
                                                └────────────┘
```

### 2.4 `/src` layout

```
/src
  /engine
    metrics.ts        # VERBATIM port of buildBK/aggregate/series/rate/statusMix + QSET/SHOWN/PALETTE
    charts.ts         # VERBATIM svgCombo/svgDonut
    dateEngine.ts     # presetRange/dateBar/daysBetween/parseD  (UTC-midnight parse — see §5)
  /read               # read API: overview, closer, setter, raw-tab pagination
  /ingest             # POST /ingest, router, coercers, upsert/insert projector
  /reconcile          # nightly sweep + HUB assertion (tune.py ported)
  /backfill           # one-time Sheets-API loader (extract_site.py scrub ported)
  /admin              # sources, mappings, users, jobs, raw-events panels
  /auth               # email allow-list, magic-link
  /config/env.ts      # env validated once at boot
  /db                 # migrations, query builder, typed row types
  server.ts           # app entrypoint
  worker.ts           # worker entrypoint (scheduler + projector)
```

---

## 3. Data model

Authoritative Postgres schema. Designed so the ported engine reads `bookings` and reconciles to the HUB to the dollar, and so the raw layer can rebuild the typed layer from history.

### 3.0 Ground-truth facts this schema is built on (measured)

| Fact | Value | Source |
|---|---|---|
| Bookings rows | 23,385 | `site_data.json` |
| Bookings columns | 38 | measured; full list below |
| `Call ID` populated | **354 / 23,385 (1.5%)** | measured — **this kills `Call ID` as a primary key** |
| Synthetic key `(bd\|cs\|email\|owner)` distinct | **13,655 / 23,385** → 9,730 rows collapse | measured — **kills the synthetic key as a merge key** |
| Collision groups with differing status/cash | 77 (of 151 groups) | measured — genuinely-distinct bookings the key would merge |
| Rows with no parseable date in either date column | 9,583 | measured — engine skips them; cash on them = **$0** |
| Rows with no email AND no date | 9,567 | measured |
| Rows with a follow-up payment | 163 | measured |
| Rows where `Total ≠ First + FollowUp` (cash>0) | **1** | measured — data-quality flag, not a bug to replicate |
| People who are BOTH a `Lead Owner` and an `Attributed Setter Full Name` | 8 | measured (AJ Abdelaal, Adam Farinaccio, Danny Le, Gunkar Singh, Ivan Merc, Jerome Schreiber, Kaitlin Nguyen, Shanice Moore) |
| Near-miss statuses (whitespace/case differing from frozen set) | 0 in this snapshot | measured — but a nightly tripwire is still required |
| Negative-cash (refund) rows | 0 in this snapshot | measured — but the `cash>0` strictness must still be preserved for future refunds |

The 38 Bookings columns, in order: `Booking Date`, `Scheduled Call Date (PST)`, `Call Time (PST)`, `Call ID`, `Lead Owner`, `UTM Attribution`, `Survey Attribution`, `Prospect Name`, `Prospect Email`, `Phone`, `Country`, `Lead Status`, `Prospect Website`, `DMPN?`, `Cash Collected (old)`, `Davie Content Notes (...)`, `Referral?`, `Referred By?`, `2nd Call?`, `Call Notes`, `Wait Time (days)`, `Optin Date`, `Date Difference`, `Close Date`, `Matched Lead UTM medium`, `Matched Lead UTM source`, `Lead Status From Close`, `Cash Collected`, `Setter Qualified Booked Call?`, `Attributed Setter Full Name`, `First Call Cash Collected`, `Follow Up Call Cash Collected`, `Follow Up Call Cash Collected Date`, `Total Cash Collected`, `New Calendly Name`, `Cash Source`, `Total Cash Collected after Fees`.

Messy realities to design *around* (coerce, don't trust): the extract mis-infers `Call Notes` as a date; the `Payments` tab's first header is blank; `Leads Over Time` has a tab-mashed header cell; HUB tabs carry leading-space duplicate headers, a `⭐` column, and `#REF!` cells; ~27,000 broken-formula cells (`#REF!`/`#N/A`/`#DIV/0!`/`#VALUE!`) exist across tabs; 21,713 rows sit in the excluded `Bookings - zapier failed` junk tab.

### 3.1 Design principles

1. **Two coexisting layers.** A **generic raw** layer (`raw_events` append-only spine + `raw_rows` per-tab landing) that is the source of truth for replay, and a **typed** layer (`bookings` + 11 mirror tables) that the engine and grids query. The typed row is a materialized projection of raw events and can always be rebuilt.
2. **Row-faithful, append-first.** Backfill **inserts** Bookings rows 1:1 with a surrogate primary key. It never upserts, because there is no trustworthy key for 98.5% of rows (§3.0). Keyed upsert is a narrow live-only path, applied only to rows carrying a proven Zap-payload id.
3. **Nothing dropped, only quarantined** (invariant #3).
4. **Config-driven mapping.** Incoming field → typed column is a row in `source_field_mappings`, not code.
5. **Portable.** Plain Postgres, Docker, env-driven; lifts to Neon/Supabase unchanged.

### 3.2 Extensions & enums

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

CREATE TYPE ingest_kind   AS ENUM ('create','update','delete','snapshot','backfill');
CREATE TYPE process_state AS ENUM ('pending','processed','quarantined','skipped','replayed');
CREATE TYPE date_basis    AS ENUM ('call','book');   -- mirrors the engine's DR.basis
CREATE TYPE key_source    AS ENUM ('opportunity','lead_call','synthetic');
```

> **Fix baked in (keying review SEV-2 / dual-role):** there is deliberately **no `person_role` enum used as a person attribute.** 8 humans act as both closer and setter (§3.0). Role is *per-row*, derived from which column the name appears in (`Lead Owner` → closer, `Attributed Setter Full Name` → setter). If a `people` dimension is ever added, role is a derived many-to-many view, never a stored column on the person.

### 3.3 Sources registry & config-driven mappings

```sql
CREATE TABLE sources (
  id                SMALLINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  slug              TEXT UNIQUE NOT NULL,     -- 'zap.bookings.update','sheet.backfill','close.webhook'
  label             TEXT NOT NULL,
  system            TEXT NOT NULL,            -- 'zapier'|'sheet'|'close'|'jotform'|'stripe'|'form_builder'(ph2)
  target_table      TEXT,                     -- 'bookings' | ... | NULL for generic
  natural_key_field TEXT,                     -- incoming field holding the natural key (per-source)
  event_kind_field  TEXT,
  secret_hash       TEXT,                     -- per-source bearer secret, hashed (§4.3)
  is_active         BOOLEAN NOT NULL DEFAULT true,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE source_field_mappings (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT NOT NULL REFERENCES sources(id),
  incoming_field TEXT NOT NULL,               -- key/path in payload jsonb
  target_column  TEXT NOT NULL,               -- normalized column, e.g. 'total_cash_collected'
  target_type    TEXT NOT NULL,               -- 'date'|'money'|'num'|'pct'|'text'|'bool' (extract vocab)
  transform      TEXT,                         -- named coercer: 'money_usd'|'date_pst'|'yesno_bool'|'trim'
  is_natural_key BOOLEAN NOT NULL DEFAULT false,
  is_required    BOOLEAN NOT NULL DEFAULT false,
  active_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_to      TIMESTAMPTZ,                  -- null = current; versioned so a re-map is auditable
  UNIQUE (source_id, incoming_field, active_from)
);
CREATE INDEX ix_sfm_source_active ON source_field_mappings(source_id) WHERE active_to IS NULL;
```

**Because `natural_key_field` lives on the source,** each source picks its own key without a schema change — the mechanism that lets a Close-opportunity source and a Close-lead source coexist (§4.1). **Versioned mappings** are what make "re-map a field and replay from history" work: close the old row (`active_to = now()`), insert a new one, re-run the router over `raw_events`.

Bookings seed mapping (`target_column ← incoming_field`, transform): `call_id ← 'Call ID'`; `booking_date ← 'Booking Date'` (date_pst); `scheduled_call_date_pst ← 'Scheduled Call Date (PST)'` (date_pst); `lead_owner ← 'Lead Owner'` (trim); `attributed_setter_full_name ← 'Attributed Setter Full Name'` (trim); `lead_status ← 'Lead Status'`; `total_cash_collected ← 'Total Cash Collected'` (money_usd); `total_cash_collected_after_fees ← 'Total Cash Collected after Fees'` (money_usd); the remaining 30 columns → typed secondary columns or `raw_extra` jsonb.

### 3.4 The append-only raw event log (the spine)

```sql
CREATE TABLE raw_events (
  id            BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,   -- ingest_seq (arrival order)
  source_id     SMALLINT NOT NULL REFERENCES sources(id),
  external_id   TEXT,                          -- stable business key as sent; nullable
  event_type    ingest_kind NOT NULL,
  occurred_at   TIMESTAMPTZ,                   -- SOURCE event time — the conflict clock (§4.4)
  occurred_at_estimated BOOLEAN NOT NULL DEFAULT false,
  payload       JSONB NOT NULL,                -- verbatim body, NEVER mutated
  dedupe_hash   BYTEA,                          -- sha256(source||external_id||event_type||occurred_at||canonical(payload))
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  process_state process_state NOT NULL DEFAULT 'pending',
  process_note  TEXT
);
REVOKE UPDATE, DELETE ON raw_events FROM app_writer;   -- append-only; outcome set via a narrow function
CREATE UNIQUE INDEX ux_raw_dedupe ON raw_events(dedupe_hash) WHERE dedupe_hash IS NOT NULL;
CREATE INDEX ix_raw_pending     ON raw_events(process_state, received_at) WHERE process_state='pending';
CREATE INDEX ix_raw_extid       ON raw_events(external_id);
CREATE INDEX ix_raw_source_time ON raw_events(source_id, occurred_at);
CREATE INDEX ix_raw_payload_gin ON raw_events USING gin (payload jsonb_path_ops);
```

Payload/identity are immutable; only `processed_at`/`process_state`/`process_note` change, and only via a stored `mark_event_processed(id, state, note)` function. `dedupe_hash` unique index makes a re-fired identical Zap a no-op (Zapier retries are common). **`occurred_at` is the single conflict-resolution clock** — see the fix in §4.4.

### 3.5 Per-tab verbatim landing (backfill staging + quarantine home)

```sql
CREATE TABLE raw_rows (
  id            BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id     SMALLINT NOT NULL REFERENCES sources(id),
  tab_name      TEXT NOT NULL,                -- 'Bookings','Leads',... exactly as in the sheet
  row_index     INTEGER,                      -- original sheet row number — first-class identity (§4.6)
  cells         JSONB NOT NULL,               -- {colname: value} verbatim, blanks kept as ""
  natural_key   TEXT,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  process_state process_state NOT NULL DEFAULT 'pending',
  quarantine_reason TEXT
);
CREATE INDEX ix_rawrows_tab ON raw_rows(tab_name, process_state);
CREATE INDEX ix_rawrows_key ON raw_rows(tab_name, natural_key);
CREATE INDEX ix_rawrows_gin ON raw_rows USING gin (cells jsonb_path_ops);
```

The one-time backfill lands **every** kept-tab row here first (verbatim, blanks preserved). Good rows project into typed tables; bad rows stay flagged. This is where the real `bookings_rows = 23385` count lives (see the gate fix in §4.6).

### 3.6 The star typed table: `bookings`

> **Fix baked in (all three reviews, SEV-0 / P0-1):** the primary key is a **surrogate `bigserial`**, not `Call ID`. `Call ID` is populated on only 354/23,385 rows; a `call_id TEXT PRIMARY KEY` would collide all 23,031 blank rows onto `''`/NULL and collapse the table to ~355 rows, zeroing every dashboard. `call_id` is a **nullable, non-unique attribute.** `source_row_index` (the sheet position) is promoted to a first-class column so identity is the thing the engine actually counts.

```sql
CREATE TABLE bookings (
  -- identity
  id                 BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,   -- surrogate PK (the fix)
  source_row_index   INTEGER,                 -- original Bookings sheet row; backfill identity
  external_id        TEXT,                    -- Close opportunity/lead id from a Zap payload; NULLABLE
  call_id            TEXT,                    -- sparse Close call id (354/23385); attribute, not key
  key_source         key_source,              -- opportunity | lead_call | synthetic
  -- engine-critical typed columns (snake_case of the exact sheet headers)
  booking_date                    DATE,       -- 'Booking Date'                        (bd)
  scheduled_call_date_pst         DATE,       -- 'Scheduled Call Date (PST)' DEFAULT basis (cs)
  lead_owner                      TEXT,       -- closer  (Person = Lead Owner)         (o)
  attributed_setter_full_name     TEXT,       -- setter                               (s)
  lead_status                     TEXT,       -- drives SHOWN/QSET                     (st)
  total_cash_collected            NUMERIC(14,2) NOT NULL DEFAULT 0,  -- closed = >0; cash = Σ  (cash)
  total_cash_collected_after_fees NUMERIC(14,2) NOT NULL DEFAULT 0,  -- after fees = Σ         (fees)
  -- secondary typed columns queried by grids/drilldowns
  call_time_pst      TEXT,
  prospect_name      TEXT,
  prospect_email     CITEXT,                  -- case-insensitive cross-tab joins
  country            TEXT,
  close_date         DATE,
  cash_collected     NUMERIC(14,2),
  first_call_cash_collected     NUMERIC(14,2),
  follow_up_call_cash_collected NUMERIC(14,2),
  -- all 38 columns verbatim so the read-only grid loses nothing
  raw_extra          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- lineage / audit / conflict clock
  source_id          SMALLINT REFERENCES sources(id),
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurred_at        TIMESTAMPTZ,             -- clock of the currently-applied event (§4.4)
  occurred_at_estimated BOOLEAN NOT NULL DEFAULT false,
  last_event_id      BIGINT REFERENCES raw_events(id),
  last_event_type    ingest_kind,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined     BOOLEAN NOT NULL DEFAULT false,   -- soft flag; excluded from engine reads
  is_cancelled       BOOLEAN NOT NULL DEFAULT false    -- soft-delete (§4.7); excluded from engine reads
);

-- partial-unique on the REAL key only where a trustworthy id exists (never on blanks/synthetics)
CREATE UNIQUE INDEX ux_bk_ext ON bookings(external_id)
  WHERE external_id IS NOT NULL AND key_source = 'opportunity';
```

**Indexes tuned to exactly what `aggregate()`/`series()`/`statusMix()` scan** — a date-range filter on the basis column, then group-by person, excluding non-engine rows:

```sql
CREATE INDEX ix_bk_call_owner  ON bookings (scheduled_call_date_pst, lead_owner)
    WHERE is_quarantined=false AND is_cancelled=false;
CREATE INDEX ix_bk_call_setter ON bookings (scheduled_call_date_pst, attributed_setter_full_name)
    WHERE is_quarantined=false AND is_cancelled=false;
CREATE INDEX ix_bk_book_owner  ON bookings (booking_date, lead_owner)
    WHERE is_quarantined=false AND is_cancelled=false;
CREATE INDEX ix_bk_book_setter ON bookings (booking_date, attributed_setter_full_name)
    WHERE is_quarantined=false AND is_cancelled=false;
CREATE INDEX ix_bk_status      ON bookings (lead_status)
    WHERE is_quarantined=false AND is_cancelled=false;
CREATE INDEX ix_bk_email       ON bookings (prospect_email);
```

Composite `(date, person)` order: the engine filters the date window first, then groups by person, so a leading date column range-scans the window and the trailing person column supports the group without a separate sort. Both basis columns get their own pair because the basis toggle is a first-class product feature. The partial `WHERE` matches the engine's read predicate so quarantined/cancelled rows never touch a scan.

### 3.7 The other 11 mirror tables

Same pattern, lighter — typed columns only where a dashboard/aggregate needs them, the rest to `raw_extra jsonb`, each with `is_quarantined`. Natural key per tab; where a tab has no stable external id, a **content-hash surrogate that includes the sheet row index** (so re-imports are idempotent *without collapsing distinct rows*).

```sql
CREATE TABLE leads (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  natural_key    TEXT UNIQUE,                -- close lead id, else content hash incl. row index
  source_row_index INTEGER,
  lead_date      DATE,
  lead_email     CITEXT,
  lead_name      TEXT,
  lead_country   TEXT,
  utm_source     TEXT,
  utm_medium     TEXT,
  mql            BOOLEAN,                    -- 'MQL?' Yes/No → bool
  raw_extra      JSONB NOT NULL DEFAULT '{}',
  source_id      SMALLINT REFERENCES sources(id),
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ix_leads_date  ON leads(lead_date) WHERE is_quarantined=false;
CREATE INDEX ix_leads_email ON leads(lead_email);
```

The remaining nine — `payments`, `refunds`, `residuals`, `elective_orders`, `jotform_closer`, `jotform_setter`, `call_dashboard`, `leads_over_time`, and the two HUB tables `hub_closers`/`hub_setters` — follow the identical shape (typed columns pulled from the real headers, `raw_extra` for the long tail, `is_quarantined`).

**HUB tables are stored as reference/assertion inputs, not dashboard truth.** The engine *derives* the HUB numbers from Bookings and reconciles; we keep `hub_closers`/`hub_setters` only so the nightly sweep can assert `engine(June) == hub`. Their messy headers go straight into `raw_extra` untouched; only the columns the assertion needs get typed.

A catalog table drives the generic raw-tab grid so the 12 raw tabs are config, not 12 hard-coded endpoints:

```sql
CREATE TABLE tab_catalog (
  tab_name      TEXT PRIMARY KEY,            -- 'Bookings'
  typed_table   TEXT NOT NULL,              -- 'bookings'
  display_order SMALLINT,
  column_order  JSONB NOT NULL,             -- ordered [{header,type}] = extract_site cols/types
  row_count     INTEGER
);
```

### 3.8 Supporting tables

```sql
-- append-only side table so a Close lead/opportunity MERGE doesn't create a duplicate row (§4.8)
CREATE TABLE external_id_aliases (
  id           BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  booking_id   BIGINT NOT NULL REFERENCES bookings(id),
  external_id  TEXT NOT NULL,
  source       TEXT,
  seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (external_id)
);

CREATE TABLE users (
  id            BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  email         CITEXT UNIQUE NOT NULL,      -- allow-list = row exists AND is_active
  full_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'viewer',   -- 'viewer' | 'admin'
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  invited_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_users_active ON users(email) WHERE is_active;

-- reference/tripwire ONLY — the engine hard-codes the frozen sets (§5)
CREATE TABLE lead_status_classes (
  status_value  TEXT PRIMARY KEY,
  is_shown      BOOLEAN NOT NULL,
  is_qualified  BOOLEAN NOT NULL,
  is_no_show    BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE quarantine (
  id            BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  origin        TEXT NOT NULL,               -- 'raw_events' | 'raw_rows'
  origin_id     BIGINT NOT NULL,
  target_table  TEXT,
  reason_code   TEXT NOT NULL,               -- 'missing_natural_key','failed_zapier','junk_tab',
                                             -- 'no_date_no_key','unmapped_field','coercion_fatal',
                                             -- 'dup_ignored','id_merge_ambiguous','update_ambiguous_no_key'
  detail        TEXT,
  natural_key   TEXT,
  resolved_at   TIMESTAMPTZ,
  resolved_by   BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_q_open ON quarantine(reason_code, created_at) WHERE resolved_at IS NULL;

CREATE TABLE reconciliation_runs (
  id       BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  run_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  scope    TEXT NOT NULL,                    -- 'hub_june_closers','hub_june_setters','sheet_diff_bookings'
  passed   BOOLEAN NOT NULL,
  expected JSONB,                            -- e.g. {"closer_cash":455674.9,"Sam Aujla":{"shown":50,...}}
  actual   JSONB,
  diff     JSONB,
  note     TEXT
);

-- phase-2 stub, reserved, NOT created/used in v1 (documented only)
-- CREATE TABLE outbound_events (...);
```

`lead_status_classes` is seeded for transparency and as a nightly tripwire (assert `DISTINCT lead_status ⊆ frozen set`; alert on any new value). It **must never become the source of aggregation** — a stray edit would silently break HUB reconciliation.

### 3.9 Coercion (transforms)

`transform` names map to a small pure-function registry mirroring `extract_site.py`'s `conv`/`infer` and the engine's `+r[ca]||0` guard. See §5 for the exact semantics these must match; coercion failures fall back (0/NULL) and the raw value is preserved in `raw_extra` so a bad coercion is visible and replayable, never silently destructive. Any Excel error literal (`#REF!`/`#N/A`/`#DIV/0!`/`#VALUE!`) is treated as blank for typed columns; the original error string is preserved in `raw_extra`, and a per-row `raw_extra.__coercion_errors__` array lists which columns were error-coerced. Broken-formula cells are **cell-level**, never row-level — they never quarantine a booking.

---

## 4. Ingestion, keying & reconciliation

This is the data plane. The engine consumes the table this section fills; nothing here may change what the engine computes. All reconciliation is anchored to: **June 2026 closer cash = $455,674.90; Sam Aujla 131/50/43/27, close rate 62.79%.**

### 4.1 The stable-key problem — resolved (the central fix)

**The prototype's design tell, missed by the original spec and confirmed here:** `tune.py` and the engine key on nothing — they count raw rows and never reference `Call ID`. And the data proves `Call ID` is populated on only **354/23,385 rows (1.5%)**, with **no Close opportunity/lead id column anywhere in the 38 Bookings columns.** So:

- **Backfill and live capture have structurally different keys and cannot share one.** Backfill rows have no trustworthy id; live webhook rows may carry a Close id (from the payload, not the sheet).
- **Backfill = insert 1:1, never upsert.** Identity = `source_row_index` (sheet position), which is exactly what the engine counts.
- **Live upsert is applied only to rows carrying a proven Zap-payload id.** `bookings.external_id` = Close **opportunity id** when present (`key_source='opportunity'`), else **lead id + `Call ID`** (`key_source='lead_call'`), else a deterministic synthetic hash (`key_source='synthetic'`). The partial-unique index (`ux_bk_ext`) enforces uniqueness **only** for `key_source='opportunity'`.

> **Gating unknown (Flag #1/#4, upgraded from "confirm" to "blocker"):** the sheet has no id column, so a live upsert key can *only* come from the Zap payload. **Until the Zap export confirms the create/update payload carries a stable Close opportunity id, there is no idempotent live key.** Absent that export, the model is **append + nightly-sweep**, and it still reconciles to $455,674.90 to the dollar (invariant #2 — the engine counts rows).

### 4.2 The `POST /ingest` contract

One endpoint, source-tagged, idempotent, append-only-backed. Every current Zap and every future form/tool posts here.

```
POST /ingest
Authorization: Bearer <SOURCE_SECRET>        # per-source secret, not a shared key
Idempotency-Key: <uuid>                        # OPTIONAL; see §4.5
Content-Type: application/json
{
  "source":      "zap.bookings.update",        // required; must exist in `sources`
  "external_id": "oppo_abc123",                // required; stable business key (§4.1)
  "event_type":  "create" | "update",          // required
  "occurred_at": "2026-07-03T18:22:05Z",       // required if source can supply it (§4.4)
  "schema":      "bookings",                    // required; target logical table
  "payload":     { ...raw source fields... }    // required; stored verbatim BEFORE any mapping
}
```

Responses: `202 Accepted` (logged + projected); `202 {duplicate:true}` (idempotent no-op); `400` malformed; `401` bad secret; `403` unknown/disabled source; `409` stale update (older `occurred_at` — **stored, not applied**); `422` valid envelope but payload fails mapping validation (**logged raw, flagged `needs_mapping`, alert**); `429/5xx` transient (retry with backoff). We return `202` not `200/201` because ingestion is **write-behind**: the raw event commits synchronously (durability), the projection can be synchronous or queued — never make a Zap wait on projection. The payload is stored **raw and untouched** in `raw_events` *before* any mapping runs — the replay guarantee.

### 4.3 Auth on ingest

Per-source bearer secret (`SOURCE_SECRET`), stored hashed in `sources.secret_hash`, rotatable from the admin surface (accept old+new during a rotation window). Per-source, so a leaked setter-Zap secret can't forge closer-cash events. An unauthenticated ingest endpoint is a data-poisoning hole; every rejected call is logged.

### 4.4 The upsert / conflict model — single clock (fix)

A booking is **mutable**: created as a booked call, then its `Lead Status` changes (No Show → Qualified Showed Call → Closed) and `Total Cash Collected` lands (0 → 2490 → possibly more on a follow-up). We reflect the **latest truth per booking** while surviving double-fires and out-of-order delivery.

> **Fix baked in (all three reviews, SEV-1 / P1-1):** the original two spec drafts used **two different, incompatible conflict resolvers** — one gated on `last_event_id` (arrival serial), one on `occurred_at` (event time). Arrival order is wrong: a replayed or late event gets a *higher* serial and would clobber newer state. **Resolution: one clock, event-time, everywhere.** Gate the upsert on `occurred_at`, tiebroken by ingest serial. Delete the `last_event_id >` guard.

```sql
INSERT INTO bookings (external_id, key_source, booking_date, scheduled_call_date_pst,
    lead_owner, attributed_setter_full_name, lead_status, total_cash_collected,
    total_cash_collected_after_fees, raw_extra, source_id, occurred_at,
    occurred_at_estimated, last_event_id, last_event_type)
VALUES (...)
ON CONFLICT (external_id) WHERE key_source='opportunity' DO UPDATE SET
    booking_date = EXCLUDED.booking_date,
    scheduled_call_date_pst = EXCLUDED.scheduled_call_date_pst,
    lead_owner = EXCLUDED.lead_owner,
    attributed_setter_full_name = EXCLUDED.attributed_setter_full_name,
    lead_status = EXCLUDED.lead_status,
    total_cash_collected = EXCLUDED.total_cash_collected,
    total_cash_collected_after_fees = EXCLUDED.total_cash_collected_after_fees,
    raw_extra = bookings.raw_extra || EXCLUDED.raw_extra,   -- merge, keep prior unmapped fields
    occurred_at = EXCLUDED.occurred_at,
    last_event_id = EXCLUDED.last_event_id,
    last_event_type = EXCLUDED.last_event_type,
    updated_at = now()
WHERE EXCLUDED.occurred_at >  bookings.occurred_at
   OR (EXCLUDED.occurred_at = bookings.occurred_at
       AND EXCLUDED.last_event_id > bookings.last_event_id);   -- event-time first, serial only as tiebreak
```

Algorithm: on event `E(external_id=X, occurred_at=T)` — if no row, INSERT (`first_seen_at=T`); else if `T` newer, UPDATE; else **stored-not-applied** (`409`, the raw event is already in `raw_events` for audit/replay). Whole-row last-writer-wins is the atomic unit **because the sheet-update Zaps write the full booking row** (Flag #2 — strong prior; confirm from export). If the export shows Close sends *partial deltas*, fall back to field-level handling for cash: never regress cash downward without an explicit `refund` event (a downward correction requires the latest source timestamp, not a blind whole-row overwrite).

Worked double-fire correctness: identical event twice → transport dedupe no-op ✅; two Zaps for one create → same `external_id`, second is dedupe no-op or equal-time identical upsert ✅; update-before-create race → update INSERTs as first sighting, later create arrives older → stored-not-applied ✅; cash correction → newer `occurred_at` wins, `closed` recomputes from the new cash in the engine ✅.

### 4.5 Idempotency & replay

Two layers: **transport** (`Idempotency-Key`, or `sha256(source|external_id|event_type|occurred_at|canonical(payload))`, unique in `raw_events.dedupe_hash`) kills Zapier retry storms; **business** (the upsert is naturally idempotent). **Replay** = re-running any window of `raw_events` (ordered by `occurred_at`, tiebreak `id`) back through the mapper — deterministic, side-effect-free (**never re-emits webhooks**). Replay is how we adopt a newly-mapped field, rebuild `bookings` after a mapping bug, or re-point at a corrected mapping.

### 4.6 One-time backfill (extract_site.py ported) + the count-gate fix

Backfill loads all history from the sheet once, scrubbed, via the **Google Sheets API** (so the nightly sweep reuses the reader), then hands off to live capture at a clean cutover.

**Scrub rules (exact, from the health audit):**
1. **Tab allow-list** — keep exactly the 12 tabs `extract_site.py` lists; ignore all 7 junk/old tabs. Never read `Bookings - zapier failed`.
2. **Drop blank rows** — `if all cells == "" → skip` (`extract_site.py` line 53 verbatim).
3. **Re-scoped drop rule (fix, P1-3):** the 21,713 failed-Zapier rows live in the *excluded* `Bookings - zapier failed` tab and are handled by rule 1 — do **not** attribute them to Bookings-row rules. The real in-tab noise is the **9,583 Bookings rows with no parseable date in either date column** (measured). Drop those to `raw_rows` with `quarantine_reason='no_date_no_key'`; they can never enter a metric (engine requires a date) and carry **$0 cash** (measured), so they don't move reconciliation.
4. **Coerce broken-formula cells** — `#REF!`/`#N/A`/`#VALUE!`/`#DIV/0!` → `""` for text, `0.0` for money/num (`data_only=True` resolves most; this is the safety net for the ~27k). Money coercion mirrors the engine (`+r[ca]||0`).
5. **Type coercion = `conv()` verbatim** (`extract_site.py` lines 13–23): dates → `YYYY-MM-DD` (drop midnight time), bools → `Yes`/`No`, integer floats → int, else round(4). **Load-bearing** — the engine does `(''+r[cs]).slice(0,10)` and exact-string status matching; any drift breaks membership tests.
6. **Trim** `Lead Owner`/`Attributed Setter Full Name` — the engine trims, so store trimmed or person-grouping splits `"Sam Aujla"` from `"Sam Aujla "`.

> **Fix baked in (keying + integrity reviews, SEV-0 / P0-2):** **there is no dedup-merge at backfill.** The original "on synthetic-key collision keep the latest-date row" rule is **deleted** — it silently merges genuinely-distinct bookings. Measured: the synthetic key `(bd|cs|email|owner)` produces only 13,655 distinct keys from 23,385 rows (9,730 collapse), and 77 collision groups contain rows with *different* status/cash — e.g. one lead with a `Closed / $5,000` row and a `$0 booked-call` row on the same day/owner. Merging them would delete the $5,000 deal and drop Sam Aujla from 131 to 130 June bookings, failing the HUB assertion. **Backfill rows are 1:1 with sheet rows by `source_row_index`; there is nothing to merge.** If an idempotent re-run key is wanted, it must include `source_row_index` (which makes it pure row-identity).

> **Gate fix (integrity review, P0-3):** the go-live gate is **not** `count(bookings)==23385`. Split it: assert `count(raw_rows WHERE tab='Bookings') == 23385` (verbatim landing) AND `count(bookings metric-eligible) == expected` where metric-eligible = has a parseable date in the basis column and the expected count is frozen from the `extract_site` output (≈13,818 after the 9,583 dateless rows are quarantined). The **true** gate is the §4.9 HUB assertion; the count is advisory.

**Cutover (no double-count):**
1. **T0** = the UTC instant the parallel webhook action goes live on the Bookings Zaps. Live events flow into `raw_events` and project into `bookings`.
2. Backfill reads the sheet **as of T0**, inserts by `source_row_index`, marks every backfill row `origin='backfill'`, `occurred_at <= T0`, `occurred_at_estimated=true`.
3. **Adoption resolves the overlap (fix, P1-2):** because backfill rows are `synthetic`-keyed and live rows are `opportunity`-keyed, they **do not match by key** — occurred_at alone does not prevent a double *row*. An explicit **adoption step** (run at end of backfill and nightly, §4.9) matches a live `opportunity`-keyed row to a `synthetic` backfill row on the natural tuple `(scheduled_call_date, lead_owner, prospect_email, ≈total_cash, lead_status)`; on a confident single match it **merges** (adopt `external_id`, set `key_source='opportunity'`, keep the newer `occurred_at` state, retire the synthetic duplicate, log the adoption); on ambiguity (multiple matches) it quarantines `id_merge_ambiguous` for human confirm — **never auto-merge two cash-bearing rows.**
4. Idempotent, re-runnable — insert-by-row-position + adoption never double-counts.

### 4.7 Deletions / cancellations (fix)

> **Fix baked in (keying review SEV-2):** deletes are **soft**, never hard. A cancel/delete event sets `is_cancelled=true` (excluded from engine reads by the partial indexes) so the count legitimately drops. The nightly "in sheet, not in DB → repair" rule **must skip keys tombstoned by a later delete event** (check `raw_events` for a `delete` before re-inserting) — otherwise a booking cancelled in Close but still present in the sheet resurrects every night in an oscillation. Confirm from the Zap export whether cancel/delete Zaps even exist; if Close cancellations only ever manifest as a `Lead Status` change, there are no delete events and this class is moot (the status change flows through normally).

### 4.8 Close lead/opportunity merges (fix)

> **Fix baked in (keying review SEV-3):** when Close merges two leads/opportunities the surviving id changes; a post-merge UPDATE under the new id would create a second `bookings` row. `external_id_aliases` (§3.8) stores every id a booking was ever seen under; on a new event whose id doesn't match but whose content (email + scheduled date + owner) matches an existing booking, **link the alias** rather than insert. Ambiguous id-changes route to `quarantine('id_merge_ambiguous')`. The sheet remains the reconciliation oracle — `tune.py` keys on nothing, so merges in Close never perturb the asserted numbers; the nightly sweep catches merge drift as a `db_only`/`field_drift` discrepancy.

### 4.9 Nightly reconciliation sweep + HUB assertion

Runs 03:00 VPS-local as an in-worker job. Two stages.

**Stage 1 — diff & repair (sheet ↔ DB):** re-read the 12 allow-listed tabs via Sheets API, apply the §4.6 scrub → `sheet_bookings` keyed by the natural tuple (there is no shared id for 98.5% of rows). Diff vs `bookings`:
- **In sheet, not in DB** → a missed webhook. Repair: insert, `occurred_at = row date @00:00 estimated`, tag `origin='recon_backfill'`, count in alert — **but skip keys tombstoned by a delete (§4.7).**
- **In DB, not in sheet** → do **not** delete; flag for human review (the sheet is messy, not authoritative on deletes).
- **In both, load-bearing fields differ** → resolve by `occurred_at`; **never overwrite a row whose `occurred_at_estimated=false` (webhook-fresh) with sheet-derived data (`estimated=true`)** — a hand-edited sheet cell has no reliable timestamp, and the original §6.1 wording could regress fresh live data. Log `drift` / `expected_lag` accordingly.
- Run the **adoption step** (§4.6) to merge live `opportunity` rows into `synthetic` backfill rows.
Emit a recon report (`missed_webhooks`, `db_only`, `field_drift`, `dedup_collisions`, `adoptions`) + alert if `missed_webhooks > threshold` (a broken Zap).

**Stage 2 — HUB assertion (`tune.py` ported, promoted to a gate):** recompute the pinned month (`2026-06`, call-date basis) **through the verbatim engine** against live `bookings`, and assert per-closer *and* per-setter (not just closers — the original `tune.py` only checks closers, letting setter-side attribution drift through):
- `bookings == HUB.bookings`, `shown == HUB.showed`, `qual == HUB.qual`, `closed == HUB.dmpn + HUB.dma` (None→0), `round(cash) == round(HUB.cash)` (integer dollars).
- **Grand-total assertions too** (a per-person loop can have two people swapped and still total-match, and a total can match while a person is wrong): `sum(closer.cash) == 455674.90` to the dollar; sum of bookings/shown/qual/closed == HUB totals.
- **Named regression anchors:** Sam Aujla → 131/50/43/27, close rate 62.79%.
- **Tolerance:** cash to the dollar (`abs(mine−hub) < 0.5`); counts exact.
- **Fail → page + block.** A red assertion means a mapping regression, a scrub-rule change, or genuine drift — all release-blocking. Write a `reconciliation_runs` row every night regardless.

The same assertion runs at (a) end of backfill, (b) CI on every deploy against a fixture snapshot, (c) nightly against live, (d) after every restore. Four tripwires, one function.

**Status tripwire:** assert `SELECT DISTINCT lead_status FROM bookings ⊆` the frozen set; alert on any new value (0 near-misses today, but a future typo/trailing-space would silently drop from `shown`/`qual`).

### 4.10 Which tabs feed which tables

Rule: a tab gets **live capture** only when (a) a dashboard reads it and (b) a Zap already writes it. Only **Bookings** meets both in v1 (`bookings`, live-upserted where a payload id exists, else insert). Payments/Refunds/Elective are Phase-1.5 (their Zaps exist). Leads/Jotform/Residuals are backfill-only in v1. Call Dashboard / Leads Over Time are sheet-side rollups we recompute, not ingest. HUB - Closers / HUB - Setters are **not ingested as dashboard data** — they are the reconciliation oracle.

**Split payments (fix, SEV-1):** the sheet already collapses split payments into one row's `Total Cash Collected` (measured: `Total == First + FollowUp` in all but 1 of 23,385 rows; 163 follow-up rows), and the engine sums that single field. So one booking = one `Total Cash Collected` regardless of how many tools/instalments produced it. Live payment events (a Stripe Zap and an Elective Zap for the same deal) must **not** create `bookings` rows — they route to `payments` and the booking's cash is reconciled from the sheet's `Total Cash Collected` on the nightly sweep, not summed live, until a shared key is proven. Nightly assertion: `total_cash_collected == first_call_cash + follow_up_cash` (the 1 mismatch is a data-quality flag).

---

## 5. Metric engine port & the HUB-accuracy guarantee

The engine is a **frozen unit** (invariant #1), lifted verbatim from `source/dashboard.template.html` into `/src/engine/`. The load-bearing rule for the read API: **reproduce `buildBK()`'s record shape (`cs/bd/o/s/st/cash/fees`) as a SQL projection** so the ported `aggregate/series/statusMix` run unchanged over the same rows the prototype's `BK` array held.

The seven load-bearing Bookings columns → engine fields:

| engine field | Bookings column (exact) | type | rule |
|---|---|---|---|
| `cs` | `Scheduled Call Date (PST)` | date `YYYY-MM-DD` | default basis |
| `bd` | `Booking Date` | date `YYYY-MM-DD` | toggle basis |
| `o` | `Lead Owner` | text, trimmed | Person = closer |
| `s` | `Attributed Setter Full Name` | text, trimmed | Person = setter |
| `st` | `Lead Status` | text, **not trimmed** | exact-case set membership |
| `cash` | `Total Cash Collected` | money → float | `closed = cash>0`; `cash = Σ` |
| `fees` | `Total Cash Collected after Fees` | money → float | `after fees = Σ` |

Frozen status sets (template lines 157–158): `QSET = {Qualified Showed Call, Closed, Call Completed - Deposit, Call Completed - 1 Week Trial, Closed Within 30 Days}`; `SHOWN = QSET ∪ {Call Completed - Disqualified}`. `closed` is a **cash test, not a status.** An ingestion path that sets a closed flag from status would silently diverge — forbidden.

### 5.1 Must-preserve-verbatim checklist (metric-port fidelity review — every item is a requirement)

A "reasonable" TS reimplementation silently diverges at each of these. Port each **exactly**, and the parity test (§5.2) must assert each.

1. **Date `.slice(0,10)` on a raw string, never a parsed Date** (line 196: `cs:(''+(r[cs]||'')).slice(0,10)`). The date key is the literal first 10 chars of whatever string the sheet holds — no timezone conversion. **The single highest-risk drift:** ingesting the date into a `timestamptz` and re-serializing can shift a `2026-06-30T23:00:00-07:00` call to `2026-07-01` UTC, moving it out of June. **Store/compare the date as the leading 10-char text of the source cell; do not normalize to a DB date type before the engine sees it.** (The DB `DATE` columns in `bookings` are for indexing/grids; the engine reads the string-truncated value — the projection must feed the engine the 10-char string, and the parity test §5.2/B3 asserts the two paths agree.)
2. **Range compare is string, inclusive both ends** (line 254: `if(!dk||dk<from||dk>to)continue`). Lexicographic `"YYYY-MM-DD"`. Port as string `>=from && <=to`, not Date-object compare (a `<= to` at `00:00:00` would exclude the whole `to` day). `tune.py` uses the equivalent `d[:7]=='2026-06'`.
3. **Person key = `.trim()` only** (line 196). No case-fold, no internal-whitespace collapse, no Unicode NFC, no alias merge. Match **JS `String.prototype.trim`** semantics (ground truth), and make the HUB assertion use the *same* trim (not Python `.strip()`, whose Unicode-whitespace set differs). Empty name after trim → row dropped.
4. **`closed = cash>0`, strictly greater, never `>=`, never status-based** (line 254). A negative-cash refund row → not closed, but its negative cash **is summed into `cash`** (refunds lower cash, never touch closed count). `cash===0` → not closed. Never add "closed implies qualified."
5. **`cash = +r[ca] || 0`** — JS unary-plus then `||0`. `+"$1,790"` = NaN → 0. The engine assumes cash cells are already bare numerics. **The ingest coercer must strip `$`/commas so the value is a clean number before the engine, and the engine does `Number(x)||0`** (use `Number`, not `parseFloat` — `parseFloat("")`=NaN vs `+""`=0). Do not "improve" with a locale currency parser that would parse `"$1,790"`→1790 where the prototype yields 0 — that would make the dashboard disagree with the HUB basis.
6. **Status is `r[st]||''` — NOT trimmed, NOT coerced** (line 196). Membership tests run against the raw string. A `"Closed "` with a trailing space would not match `'Closed'`. Do not trim/normalize status before the QSET/SHOWN check. (Measured: 0 near-misses today; the §4.9 tripwire guards the future.)
7. **QSET/SHOWN exact membership, byte-for-byte** (`Set.has`). `" - "` = space-hyphen-space; case-exact; `'Closed Within 30 Days'` exact. Define QSET once, `SHOWN = QSET ∪ {'Call Completed - Disqualified'}` (union-derived, never a hand-listed 6th element).
8. **`shown`/`qual` independent of cash; `closed` independent of status** (line 254 — four counters increment independently). Close rate can exceed 100% for an individual; do not guard against it.
9. **`≤ 92` daily-vs-monthly threshold, inclusive** (line 261: `span=daysBetween(from,to)+1, daily=span<=92`). Exactly-92-day span → daily; 93 → monthly. `daysBetween` (line 188) parses UTC-midnight (`parseD = new Date(s+'T00:00:00Z')`) — the port **must** parse as UTC to avoid DST rounding errors.
10. **Month bucketing `.slice(0,7)` + UTC month walk** (lines 262–266) — port the UTC month increment exactly; a local-time walk can skip/duplicate a month across DST.
11. **`TODAY = "2026-06-30"` is hard-coded and load-bearing** (line 145) — gates DMAX (`if(d<=TODAY && d>mx)`) and all presets. In the hosted app, **make TODAY an injected config value**, defined as the **PST calendar date** (not UTC — at 5pm PST it's already tomorrow UTC). **Pin it to `2026-06-30` in the parity/HUB fixtures** or the golden output won't match; for live UI it can advance, but reconciliation for closed months is unaffected.
12. **`buildBK` DMIN/DMAX regex gate** `^\d{4}-` (line 197) — only 4-digit-prefixed dates set range bounds; preserve.
13. **Leaderboard sort** `cash desc, bookings desc` (line 255), stable — affects Top-N and the default-selected person; port the comparator and keep the sort stable.
14. **Column lookup = trim + lowercase exact match** (line 194; `tune.py` 4–7). **Port must fail LOUDLY on a −1 index**, not silently produce zeros — a renamed/dropped column (e.g. `(PST)` removed) would otherwise blank all dates. Startup assertion: all 7 required columns resolve to ≥0.
15. **Fees summed unconditionally** with the same `+||0` coercion (line 254).

### 5.2 The parity gate (HUB assertion converted to hard assertions)

The current `tune.py` **prints but asserts nothing** — it can drift green forever. The ported TS test (CI + backfill + nightly + restore) converts every printed pair into a hard assertion and adds:

- **B1 per-closer + B10 per-setter** exact five-metric equality for June 2026 (cash to the dollar, counts exact); named anchor Sam Aujla 131/50/43/27, 62.79%.
- **B2 grand totals** (`sum closer cash == 455674.90`; sum bookings/shown/qual/closed == HUB) — catches offsetting per-person errors.
- **B3 date-basis drift guard** — compute the date key two ways (string-prefix vs the server's stored/returned date) and assert identical; explicit boundary rows (`2026-06-30T23:59:59-07:00` → June; `2026-07-01T00:00:01-07:00` → July).
- **B4 `cash>0` vs refunds** — assert `closed == count(cash>0)` strictly and `closed != count(cash>=0)`; a `cash==0` row is not closed. (Synthesize a negative-cash fixture — the live snapshot has 0 refund rows, so this is fixture-driven.)
- **B5 status exactness** — hash-assert QSET/SHOWN equal the frozen literals; assert `SHOWN == QSET | {'Call Completed - Disqualified'}`; whitespace/case near-miss canary over all `Lead Status` values.
- **B6 name trim** — assert the port's trim equals JS `.trim` over all distinct owner/setter values; assert every HUB closer name matches ≥1 row.
- **B7 money coercion** — assert `Σ engine_coerce(cell) == Σ (+cell || 0)` over all cash cells; fail loudly if ingest introduced `$`/comma formatting.
- **B8 threshold boundary** — 92-day span → daily, 93 → monthly; `daysBetween('2026-06-01','2026-06-30')==29`.
- **B9 column resolution** — all 7 required columns resolve ≥0, fail loudly on −1.

### 5.3 Reusing the framework-free prototype

Keep all ~354 lines of markup/CSS/SVG charts/virtualized grid/date engine. **Delete only** the embedded `payload`/`dash` `<script>` blobs and the `DecompressionStream` inflate in `boot()`, replaced with `fetch()`. Untouched: `svgCombo`, `svgDonut`, `dateBar`, `presetRange`, the CSS tokens, the grid virtualizer. For the 12 raw tabs, keep the `total * 34px` spacer and add a fetch-on-scroll shim rather than rewriting `renderRows()` — paginate the API, don't embed the dataset.

---

## 6. The app, auth & admin

### 6.1 Service topology

One Fastify + Node 20 + Postgres (Kysely/Drizzle) image serving three request classes from one origin: static UI, read API, ingest+admin API. `/engine/metrics.ts` is the verbatim port; the read API is a thin projection+serialization layer around it.

### 6.2 Read API + engine boundary

Endpoints: `GET /api/overview`, `GET /api/closer/:name`, `GET /api/setter/:name`, `GET /api/people?role=`, `GET /api/tabs/:tab?page=&size=` (paginated raw grids). Each dashboard endpoint SQL-projects the seven `buildBK` fields (feeding the engine the **10-char date string**, per §5.1 item 1) for the requested range, runs the frozen engine, returns JSON. The parity gate (§5.2) is a CI test on this exact path.

### 6.3 Auth

Email allow-list + **magic-link passwordless** (no passwords for reps to leak). Flow: email → if allow-listed and active, emailed a signed one-time link (via `SMTP_URL`) → one `HttpOnly / Secure / SameSite=Lax` signed cookie (`SESSION_SECRET`). Not on the list → generic "ask an admin" (no user enumeration). **Read-only is enforced structurally**: no write routes exist for viewers; the request-handler Postgres role has only `SELECT` on typed tables (writes go through the ingest worker's separate role). `requireAdmin` 404s the admin surface for viewers. `/ingest` is HMAC/per-source-secret, not session.

### 6.4 Admin surface

Five panels, `role='admin'` only — the only write path in the app:
1. **Sources** — add/disable a Zap source tag, set its schema + secret (rotatable).
2. **Field mappings** — add/version a `payload_path → column, type, transform`; adding a Zap = a `sources` row + a `source_field_mappings` row, **no deploy**.
3. **Users** — add/remove allow-listed users, set role.
4. **Jobs** — trigger a **replay** of `raw_events` for a source after a mapping change; view backfill/reconcile status.
5. **Raw events / ops panel** — the append-only log as the replayable source of truth; last N `reconciliation_runs`, webhook freshness per source, last backup timestamp, current allow-list — so a non-dev can self-serve "is the data fresh and correct today?"

Onboarding a rep = one admin action (type email → rep gets a magic link). No SSH, no env edit, no redeploy.

---

## 7. Extensibility

The platform pitch depends on four extensibility primitives, all v1:

1. **Generic `POST /ingest`** — source tag + stable external id + event_type + payload; every current Zap and future tool/form posts here.
2. **Append-only raw event log** — `raw_events` is the real source of truth; typed tables are a projection. A field we didn't map today can be mapped and **replayed** from history tomorrow with zero re-pull.
3. **Config-driven, versioned field mappings** — `source_field_mappings`; re-map + replay is auditable (`active_from`/`active_to`).
4. **Admin surface** — a non-dev adds a source, a mapping, a user, or triggers a replay without a deploy.

Together these are the test that v1 is genuinely extensible: **a new source slots into the machinery with zero changes to typed tables.**

---

## 8. Phase-2 sockets (designed, deferred)

Reserved so v1 doesn't paint us into a corner; **no logic ships in v1.**

- **Socket A — inbound custom form builder** (retires Jotform): a form submit POSTs to our `/ingest` **and** to a Zapier catch-hook so Close/downstream still fire. Because ingest is generic, no schema change is needed later — just a `sources` row `system='form_builder'` + mappings. v1 stubs the form UI + dual-post behind a disabled admin toggle; `ZAPIER_CATCH_HOOK_URL` reserved in env, unset. The `forms`/`form_submissions` tables are documented, not created.
- **Socket B — outbound write-back** (cut Zapier/Jotform spend without losing quality): our app POSTs to a Zapier Catch-Hook that fans out to tools. Stub the `writeBack(event)` interface (no-op that logs intent); the `outbound_events` table is reserved in the spec, uncreated in v1. The append-only `raw_events` already gives the trigger source.

Both slot into the existing generic ingest/mapping machinery with zero changes to typed tables.

---

## 9. Deployment & portability

### 9.1 Runtime (VPS today)

Five services, one `docker-compose.yml`, one network; only Caddy is internet-exposed. `app` (stateless, 2 replicas for rolling restart), `worker` (single-replica scheduler + projector — exactly one scheduler; advisory-lock backstop), `postgres` (16, WAL archiving on for PITR), `pgbackup` (nightly `pg_dump -Fc` → offsite S3-compatible bucket + WAL ship), `caddy` (auto-HTTPS, webhook rate-limit + IP-allowlist, security headers). The webhook path (`/ingest`, `/webhooks/*`) requires the per-source secret or is rejected `401` and logged; every accepted call is written to `raw_events` before any mapping runs.

### 9.2 Scheduler (portability-critical)

All scheduling lives **in the `worker` process** via an in-process scheduler, **not host crontab and not a shell-script cron container** — host cron doesn't move to Vercel. Every job takes a Postgres advisory lock (`pg_try_advisory_lock`) before running, so even if two schedulers ever exist each job runs once. On Vercel the same job bodies are invoked by **Vercel Cron** hitting internal `/cron/<job>` routes; the advisory lock makes overlapping invocations safe. **One job body, two triggers, zero rewrite.** Four jobs: one-time backfill (manual, idempotent, gated on the HUB assertion), nightly reconciliation + HUB assertion (§4.9 — the most important), webhook-health sweep (every 15 min; alerts on a source gone silent — a dead Zap is otherwise invisible because the sheet keeps working), monthly restore-drill.

### 9.3 Env & secrets

Single git-ignored `.env` on the VPS (`chmod 600`), plus a committed `.env.example` as the portability checklist. Every secret injected via `process.env`, never baked into the image, never committed. Key vars: `DATABASE_URL` (**the only thing that changes** moving to Neon), `APP_BASE_URL`, `SESSION_SECRET`, per-source ingest secrets, `GOOGLE_SA_JSON` + `SHEETS_SPREADSHEET_ID` (backfill + nightly sheet-diff), `HUB_ASSERT_MONTH=2026-06`, `HUB_ASSERT_CLOSER_CASH=455675`, `ALERT_WEBHOOK_URL` (Slack/Discord), `SMTP_URL`, `BACKUP_S3_*`, `LOG_LEVEL`, `ZAPIER_CATCH_HOOK_URL` (Phase-2 stub, unset in v1), `TODAY` (pinned `2026-06-30` in fixtures; PST-current in prod).

### 9.4 Backups & restore

Three layers because `raw_events` is unrecoverable if lost: (1) nightly logical dump offsite (30 daily + 12 monthly); (2) WAL archiving / PITR (rewinds a bad mid-day ingest to the minute); (3) the append-only log itself — a total `bookings` loss is recoverable by **replaying `raw_events`** through the mappers. A restore is "done" only when the HUB assertion passes; a monthly `restore-drill` job restores yesterday's dump into a throwaway Postgres, runs the assertion, tears down, alerts on failure. An untested backup is not a backup.

### 9.5 Zero-downtime-ish deploy

`git pull` → `docker build` tagged with the git SHA → **forward-only, backward-compatible migrations** in a one-shot container (never drop a column the old replica reads) → rolling replace of `app` (`replicas:2`, `order:start-first`; `/healthz` = DB reachable **and** a fast HUB spot-check on the pinned month) → replace `worker` last → post-deploy gate: the new worker runs the full HUB assertion on boot; **failure rolls back** to the previous image. A deploy that would break HUB reconciliation cannot go live — the operational teeth behind "the engine is frozen."

### 9.6 Lift-and-shift to Vercel + managed Postgres (no rewrite)

A config move, not a rewrite: `app` container → Vercel (stateless Node, unchanged); `postgres` → Neon/Supabase (swap `DATABASE_URL`); `worker` scheduler → Vercel Cron hitting existing `/cron/*` routes (job bodies unchanged, advisory-lock already safe); `caddy` → Vercel edge (delete; keep the webhook rate-limit as middleware); `pgbackup` → managed backups + PITR (delete; keep the restore-drill); `.env` → Vercel env vars. Guardrails that keep the lift honest: no Postgres-only extension features; no host-filesystem writes (exports go to object storage via env-configured client); **the engine module imports nothing from `pg`/`fs`/the web framework** — pure functions over in-memory records, which is what guarantees identical numbers on VPS and Vercel; migrations forward-only + platform-neutral SQL. Run the HUB assertion once on the new host — green by the same standard that governs every deploy = migration correct.

---

## 10. Cost audit & the 3-phase Zapier wind-down

### 10.1 Diagnosis

Billing (client screenshots): Team plan, base $898.50/mo incl. 100,000 tasks; overage $0.0226/task up to +200,000. Every invoice decomposes as **base + overage(tasks × $0.0226)**. Reverse-engineering overage tasks: 05-09 $3,261 → ~104,500 overage tasks; 06-09 $1,918 → ~45,100; 04-09 $1,742 → ~37,300; 02-09 $658 → **below base**. **The base plan is fine; the overage is the disease** — and overage tracks high-volume, low-decision Zaps (reporting rollups, Slack fan-outs, sheet create+update writes, per-event tool mirrors), not the ~23k lifetime bookings. Tasks compound multiplicatively: one lead can trigger Jotform→Close, Close→Sheet create, a status-change Sheet update, a Slack notify, a reporting Zap, an SMS step — 5–6 tasks per lead across 44,974 lead rows and ~147 Zaps.

### 10.2 Bucketing (four questions per Zap; first "yes" wins)

1. **App already holds/can trivially compute this?** (sheet writes, [Reporting] rollups, dashboards, scorecards) → **RETIRE.**
2. **Human-facing notification we can reproduce?** (Slack pings, internal FYI emails) → **RETIRE (P3)** as an in-app feed / digest / one native Slack post from our backend.
3. **High-volume mechanical tool↔tool sync with a native webhook/API?** (Close↔Stripe, Calendly→Close, Jotform→Close, Manychat→Close) → **MOVE-TO-FREE** — direct webhook into `/ingest` at $0/event.
4. **Genuine multi-tool business glue with real branching, no clean native path?** (financing approval → update Close + SMS + Stripe subscription) → **KEEP.** Quality first.

Biggest lever: **retiring the Sheet create/update Zaps** — the largest task multiplier, and the app makes the sheet optional anyway.

### 10.3 Savings model (`bill = 898.50 + max(0, tasks−100,000) × 0.0226`)

| Scenario | What's done | Steady-state /mo | Annual | Saved vs ~$18–20k/yr |
|---|---|---|---|---|
| **Today** | nothing | $1,500–1,700 (spikes $3,261) | ~$18–20k | — |
| **Conservative (quote this)** | retire Reporting + Sheet-writes + notifications; move 2–3 biggest mirrors to free; stay on Team base | **$898.50** | **$10,782** | **~$7.2–9.6k/yr (40–48%)** |
| **Optimistic** | + Jotform replaced by our form builder + remaining mirrors on free webhooks; downgrade Team→Professional | ~$74–150 | ~$0.9–1.8k | **~$16–19k/yr (85–90%)** |

Secondary savings (out of the Zapier line): retiring Jotform in P3 cuts the Jotform subscription too.

### 10.4 The 3 phases (what happens to the sheet + spend)

- **Phase 1 — SEE IT.** Dashboards live from a snapshot; all 147 Zaps untouched; sheet is source of truth. **Spend unchanged.** Buys trust — numbers reconcile to HUB, zero risk.
- **Phase 2 — OWN THE DATA.** One parallel `Webhooks → POST` action per relevant Zap (sheet still written untouched, event also posted to `/ingest`); capture CREATE + UPDATE; append-only log; nightly sweep + HUB assertion. Sheet now **mirrored, not trusted.** **Spend ticks up slightly** (+1 task per firing Zap) — the temporary investment phase.
- **Phase 3 — CUT THE GLUE.** Reproduce-then-retire by bucket, one bucket at a time, each verified by the nightly HUB assertion; move mirrors to free webhooks; keep genuine glue. Sheet becomes **optional** (comfort backup or off — client chooses). **Overage collapses → $898.50 floor; possibly a tier downgrade.**

**Guardrail (quality-first): never retire before reproduce.** A RETIRE Zap is switched off only after the app or a direct webhook demonstrably produces the same result, verified by the nightly assertion. The KEEP list is deliberately generous — cutting waste, not corners.

---

## 11. Open questions to confirm with the client

1. **Setter "cash" — total vs new-customer only?** The engine sums `Total Cash Collected` per person by column; if setters should be credited only new-customer cash, that's a metric-definition change (would need a new-vs-returning flag on the row) and must be decided before the setter dashboard is trusted. (README's own open question.)
2. **Split-payment attribution** — confirmed the sheet already collapses split payments into one `Total Cash Collected` (measured), so the engine is correct today; confirm the client is happy attributing the whole deal to the one booking row rather than splitting across tools.
3. **Per-rep vs everyone visibility** — should a rep see only their own scorecard, or the whole floor? Affects the read API's row-level filter and the allow-list role model.
4. **Who logs in** — the exact allow-list (reps, managers, Pavan/Davie), and who gets `admin`.
5. **Reschedule across a month boundary — move the booking (live view) or keep it in the original month (HUB parity)?** A call rescheduled June→July under whole-row LWW silently leaves June, and a closed month's HUB number must not move. Decision drives whether the nightly assertion compares against a **frozen period-close snapshot** (recommended — freeze each month's per-person aggregates into `reconciliation_runs` when it closes) or a live recompute. Both views can be read off the same append-only log via a temporal query.
6. **Refresh cadence** — nightly sweep is the correctness floor; if the client wants near-real-time, the live projection already gives it, and the sweep stays nightly as the reconciler.

---

## 12. Open items to confirm from the Zap/Close export

Full Zap exports are not yet available. These are **blockers/flags**, not assumptions:

1. **[BLOCKER] Does the create/update payload carry a stable Close `opportunity_id`?** The sheet has no id column (measured), so a live upsert key can only come from the payload. If no id, the live model is **append + nightly-sweep** (still reconciles to the dollar), and every live event's identity resolution falls to content-match + adoption (§4.6/§4.8).
2. **Do update-Zaps send the full booking row or a partial delta?** Determines whether whole-row LWW (§4.4) is safe (it is if full-row — the sheet-update Zaps strongly imply this).
3. **Is a source event timestamp (`occurred_at`) exposed?** If not, ordering falls to `received_at` (received-time, not event-time) and out-of-order delivery needs Close's `date_updated` pulled explicitly. Hard dependency on the export.
4. **Which of the ~147 Zaps write Bookings** (create vs update vs the failed-Zapier producers) — needed to know exactly which Zaps get the parallel POST action.
5. **Do cancel/delete Zaps exist?** If Close cancellations only manifest as a `Lead Status` change, the delete class (§4.7) is moot.
6. **Per-Zap task counts + hidden branching** (Zapier Task-History export) — the bucket *rules* (§10.2) are final; the per-Zap *assignment* is "confirm from export."

---

## 13. Build order

1. **Port the engine + write the parity test first.** `/src/engine/*` verbatim; the §5.2 assertions must go green against a fixture snapshot (June cash $455,675, Sam 131/50/43/27) before anything else is trusted.
2. Migrations: `pgcrypto`, enums, `sources`, `users`, `lead_status_classes`, `tab_catalog` (seed from `extract_site` cols/types); then `raw_events`, `raw_rows`, `quarantine`, `source_field_mappings`, `reconciliation_runs`, `external_id_aliases`; then typed tables (`bookings` first, then the 11 mirrors); indexes **after** bulk-load, then `ANALYZE`.
3. Backfill: stage all 12 kept tabs into `raw_rows` → **insert** Bookings 1:1 by `source_row_index` (no merge) → quarantine the 9,583 dateless rows → run the §4.9 assertion; **must reproduce $455,674.90 to the dollar** before go-live.
4. Read API + engine boundary; wire the three dashboards + 12 paginated raw tabs to the API (delete the embedded blob + `DecompressionStream`).
5. Auth (magic-link allow-list) + admin surface (sources, mappings, users, jobs, raw events).
6. Wire the parallel Zapier webhook → `/ingest` for CREATE + UPDATE on the Bookings Zaps (upsert only where a proven payload id exists; else insert + nightly adoption). *(Which Zaps carry the id = confirm from export.)*
7. Nightly reconciliation sweep + HUB assertion as a scheduled worker job; alerting on drift/dead-Zap; then deploy/ops (Compose, backups, restore-drill) and the portability guardrails.

**The one thing to do before any code:** get the Zap/Close export and confirm a stable live key + event timestamp (§12 #1, #3). Both are the seam between backfill and live; absent them, the design is append + nightly-sweep and still reconciles to $455,674.90 — but the upsert path stays off until the export proves a key exists.