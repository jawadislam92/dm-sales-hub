# Daily Mentor Sales Platform — GitHub Issues

Ready-to-paste issue backlog for the hosted rebuild of the Daily Mentor sales dashboard. Every issue is anchored to the locked decisions and the adversarial reviews; each carries context, acceptance criteria, labels, and a rough size.

**The non-negotiable acceptance gate for the whole project:** the ported metric engine, run over the loaded `bookings` data for June 2026 on the call-date basis, must reconcile to the HUB **to the dollar** — closer-team cash `= $455,674.90` and Sam Aujla `shown 50 / qual 43 / closed 27 / close rate 62.79%`. Any issue that could move those numbers must prove it does not.

## Label legend

- `phase-1` — v1 full-parity build (3 dashboards + 12 read-only tabs + allow-list auth).
- `phase-2` — onward capture / platform seams (form builder, write-back) — **design as stubs in v1, do not build**.
- `phase-3` — cost-cutting rollout (retire/move Zaps).
- `blocked-on-export` — cannot be finalized until the Zapier Task-History / Zap-step / Close-payload export is available.
- `foundation`, `data`, `ingestion`, `engine`, `api`, `frontend`, `auth`, `deploy`, `cost`, `security`, `p0`/`p1`/`p2`/`p3` (severity from the reviews).

**Size:** XS (≤0.5d) · S (~1d) · M (2–3d) · L (~1wk) · XL (>1wk).

---

# EPIC 1 — Foundation / Repo

Scaffold the one Node/TypeScript app + Postgres, portable (Docker + env-driven), so every later epic has a home. Stack is locked; do not relitigate.

---

### 1.1 Scaffold the mono-service repo (Fastify + Node 20 + TypeScript + Postgres)

**Context.** Locked stack: one Node/TS app + Postgres, self-hosted on the agency VPS now, built portable to Vercel/managed Postgres later. Fastify web server serving three request classes from one origin (static UI, read API, ingest+admin API). The metric engine lives in an infra-free module (`/src/engine/metrics.ts`) imported by both the web app and the worker.

**Acceptance criteria.**
- `/src` layout exists: `engine/` (verbatim port target), `api/`, `ingest/`, `worker/`, `db/`, `config/`, `web/` (static prototype assets).
- `pnpm`/`npm` build compiles TS → `dist/`; `node dist/server.js` boots and serves `/healthz`.
- `config/env.ts` validates all env vars **once at boot** and exits on missing required keys.
- Engine module imports nothing from `pg`, `fs`, or the web framework (enforced by a lint rule / dependency-cruiser check).
- README section: how to run locally, how to run tests.

**Labels:** `phase-1` `foundation` **Size:** M

---

### 1.2 Postgres migration framework (forward-only, platform-neutral SQL)

**Context.** Deploy design requires forward-only, backward-compatible migrations (never drop a column the old replica still reads) so rolling restarts are safe, and platform-neutral SQL so the lift to Neon/Supabase is a connection-string change.

**Acceptance criteria.**
- `dist/migrate.js up` runs pending migrations idempotently; tracked in a `schema_migrations` table.
- Migrations are plain SQL / query-builder DDL — no Postgres extension beyond `pgcrypto` (`gen_random_uuid`); `citext` optional and feature-detected.
- CI runs migrations against a throwaway Postgres and fails on error.
- Documented rule in-repo: additive-only; no destructive change in the same release that ships code depending on the new shape.

**Labels:** `phase-1` `foundation` **Size:** S

---

### 1.3 Dockerize: one image, three entrypoints (app / worker / backup)

**Context.** `app`, `worker`, and `pgbackup` all run the **same image**, different entrypoints, so the HUB assertion in the worker runs the exact code the dashboard serves. Multi-stage build (compile TS + build front-end → slim runtime).

**Acceptance criteria.**
- Single `Dockerfile`, multi-stage, slim runtime image.
- `docker compose up` brings up `caddy`, `app` (2 replicas), `worker` (1), `postgres`, `pgbackup`.
- `command:` overrides select `node dist/server.js` / `dist/worker.js` / `dist/backup.js`.
- Image reads all secrets from `process.env` only — nothing baked in.

**Labels:** `phase-1` `foundation` `deploy` **Size:** M

---

### 1.4 `.env.example` + secret contract

**Context.** Deploy design enumerates every env var (DB DSN, session/webhook/source secrets, Google SA JSON, Sheets id, HUB-assert constants, alert webhook, SMTP, backup S3, log level, reserved phase-2 catch-hook). `.env.example` is the portability checklist.

**Acceptance criteria.**
- `.env.example` lists every key with a placeholder and a one-line comment.
- `HUB_ASSERT_MONTH=2026-06`, `HUB_ASSERT_CLOSER_CASH=455675`, and a Sam-Aujla close-rate constant are present as pinned fixtures.
- `ZAPIER_CATCH_HOOK_URL` reserved but unset (phase-2 stub).
- No secret is ever read from anywhere but `process.env`.

**Labels:** `phase-1` `foundation` `deploy` `security` **Size:** XS

---

# EPIC 2 — Data & Backfill

Get 23,385 Bookings rows (+ the other 11 kept tabs) into Postgres, scrubbed, with a schema that reconciles to the dollar. **This epic contains the P0s that block go-live** — the `Call ID` key does not exist on 98.5% of rows, and the synthetic fallback key merges distinct bookings.

---

### 2.1 [P0] Surrogate PK on `bookings`; `call_id`/`external_id` nullable, non-unique

**Context.** The schema spec declared `bookings.call_id TEXT PRIMARY KEY` on the assumption `Call ID` is the Close natural key. **Measured against `data/site_data.json`: `Call ID` is populated on only 354 of 23,385 rows (1.5%); 23,031 are blank.** A `TEXT PRIMARY KEY` on it is unloadable (NULLs forbidden, all blanks collide). June window: only 184/816 rows carry a `Call ID`; Sam Aujla June 28/131. The reconciling engine keys on nothing — `tune.py` counts raw rows by person+date+status+cash and never references `Call ID`.

**Acceptance criteria.**
- `bookings.id bigserial PRIMARY KEY` (surrogate).
- `call_id` and `external_id` are nullable, non-unique attributes.
- Partial unique index only where a real key exists: `CREATE UNIQUE INDEX ux_bk_ext ON bookings(external_id) WHERE external_id IS NOT NULL AND key_source='opportunity'`.
- `key_source` enum column present (`opportunity | lead_call | synthetic`).
- Backfill can load all 23,385 rows without a PK/unique violation.

**Labels:** `phase-1` `data` `p0` **Size:** S

---

### 2.2 [P0] Backfill inserts row-faithful; NO merge/upsert on a synthetic key

**Context.** With `Call ID` absent on 98.5% of rows, the spec's synthetic key `sha1(booking_date|scheduled_call_date|email|lead_owner)` is what actually runs. **Measured: it yields only 13,655 distinct keys from 23,385 rows → 9,730 rows would silently merge; 77 collision groups contain rows with *different* status/cash.** Worked example (`cuic.me.re@hotmail`, cs=2026-05-19, owner Billy Cummings): one row `Closed / $5000`, one `Setter Qualified Booked Call / $0` share the key — last-writer-wins with the same date arbitrarily keeps one and can silently delete a $5,000 closed deal. The engine counts raw sheet rows; a booking = a sheet row.

**Acceptance criteria.**
- Backfill **inserts** each cleaned Bookings row 1:1; it never upserts/merges on a synthetic key.
- `bookings.source_row_index` (original sheet row position) is stored as the stable per-row identity.
- If an idempotent-re-run dedupe key is used at all, it includes `source_row_index` + `lead_status` + `total_cash_collected` so no two distinct sheet rows collide.
- The old §5.1 "on collision keep latest date" dedupe rule is deleted for synthetic keys.
- Regression test: the `cuic.me.re@hotmail` group loads as **two** rows; the $5,000 deal survives.

**Labels:** `phase-1` `data` `ingestion` `p0` **Size:** M

---

### 2.3 [P0] Two-count backfill gate: `raw_rows==23385` AND HUB assertion — not `bookings==23385`

**Context.** **Measured: 9,567 Bookings rows have blank email AND no parseable date in either date column (cash on all = $0).** The engine skips them (`if(!dk)continue`). A gate asserting `count(bookings)==23385` fails on healthy data (real metric-eligible count ≈ 13,818) or forces keeping un-keyable rows that the nightly sweep re-flags forever. The true gate is the HUB assertion, not a row count.

**Acceptance criteria.**
- Gate part A: `count(raw_rows WHERE tab='Bookings') == 23385` (verbatim landing).
- Gate part B: the June HUB assertion passes (`$455,674.90`, Sam 50/43/27).
- Metric-eligible count (rows with a parseable basis date) is derived once and frozen as an advisory check, not `23385`.
- Dateless/keyless rows land in `raw_rows` with `quarantine_reason='no_date_no_key'`, excluded from `bookings` and from the sweep's "missing webhook" alert.

**Labels:** `phase-1` `data` `p0` **Size:** S

---

### 2.4 Schema: `raw_events` append-only spine + `mark_event_processed` function

**Context.** Append-only raw event log is a locked decision — the replayable source of truth. One row per webhook POST and one synthetic event per backfilled sheet row. Only `processed_at`/`process_state` are mutable, via a narrow stored function; payload/identity immutable.

**Acceptance criteria.**
- `raw_events(id, source_id, external_id, event_type, payload jsonb, dedupe_hash bytea, received_at, occurred_at, processed_at, process_state, process_note)`.
- App writer role has INSERT only; UPDATE/DELETE revoked; outcome set only via `mark_event_processed(id,state,note)`.
- Unique index on `dedupe_hash` (partial, where not null); indexes on `(process_state,received_at) WHERE pending`, `external_id`, `(source_id,received_at)`, and a GIN on payload.
- Truncating a typed table and replaying `raw_events` in order reconstructs current state.

**Labels:** `phase-1` `data` `ingestion` **Size:** M

---

### 2.5 Schema: `raw_rows` per-tab verbatim landing + `quarantine`

**Context.** Every backfilled sheet row lands verbatim in `raw_rows` first; good rows project to typed tables, bad rows stay flagged. Quarantine is a pointer + reason, never a delete — the data always still lives in `raw_events`/`raw_rows`.

**Acceptance criteria.**
- `raw_rows(id, source_id, tab_name, row_index, cells jsonb, natural_key, ingested_at, process_state, quarantine_reason)` + GIN on `cells`.
- `quarantine(id, origin, origin_id, target_table, reason_code, detail, natural_key, resolved_at, resolved_by, created_at)`; partial index on open rows.
- Reason codes include `no_date_no_key`, `failed_zapier`, `junk_tab`, `unmapped_field`, `coercion_fatal`, `dup_ignored`, `id_merge_ambiguous`, `update_ambiguous_no_key`.
- Resolving a quarantine row stamps `resolved_at` and re-routes; nothing is deleted.

**Labels:** `phase-1` `data` `ingestion` **Size:** M

---

### 2.6 Schema: `bookings` typed table with the 7 load-bearing columns + `raw_extra`

**Context.** The engine maps each Bookings row to `{cs, bd, o, s, st, cash, fees}`. The typed table must mirror the 7 columns byte-faithfully; the full 38-column payload is preserved in `raw_extra jsonb` so the raw-tab grid loses nothing.

**Acceptance criteria.**
- Typed columns: `scheduled_call_date_pst`, `booking_date` (stored as the **leading 10-char text of the source cell**, see 4.x — do NOT normalize to a tz-aware instant), `lead_owner` (trimmed), `attributed_setter_full_name` (trimmed), `lead_status` (raw, untrimmed), `total_cash_collected numeric(14,2)`, `total_cash_collected_after_fees numeric(14,2)`.
- Secondary typed columns (email `citext`, country, close_date, first/follow-up cash) + `raw_extra jsonb` for the remaining columns.
- Lineage: `source_id`, `first_seen_at`, `last_event_id`, `occurred_at`, `updated_at`, `is_quarantined`, `source_row_index`, `key_source`.
- `is_quarantined=false` rows only are engine-visible.

**Labels:** `phase-1` `data` `engine` **Size:** M

---

### 2.7 Indexes tuned to `aggregate`/`series`/`statusMix` scans

**Context.** The engine filters by basis date range then groups by person. Composite `(date, person)` partial indexes on `is_quarantined=false` match the read predicate and keep the index small. Both basis columns get their own pair because the basis toggle is first-class.

**Acceptance criteria.**
- `(scheduled_call_date_pst, lead_owner)`, `(scheduled_call_date_pst, attributed_setter_full_name)`, `(booking_date, lead_owner)`, `(booking_date, attributed_setter_full_name)` — all partial `WHERE is_quarantined=false`.
- `(lead_status)` and `(prospect_email)` indexes.
- Indexes created **after** backfill bulk-load, then `ANALYZE`.

**Labels:** `phase-1` `data` **Size:** S

---

### 2.8 The 11 mirror tables + `tab_catalog` + `lead_status_classes`

**Context.** `leads`, `payments`, `refunds`, `residuals`, `elective_orders`, `jotform_closer`, `jotform_setter`, `call_dashboard`, `leads_over_time`, `hub_closers`, `hub_setters` follow the same pattern (natural or content-hash key, a few typed columns, `raw_extra`, `is_quarantined`). HUB tables are stored as **reference/assertion inputs, not dashboard truth**. `tab_catalog` drives the generic raw-tab grid. `lead_status_classes` is display/tripwire only — the engine hard-codes the frozen sets.

**Acceptance criteria.**
- 11 mirror tables created; HUB tables' messy headers (leading-space dups, star column, `#REF!`) go to `raw_extra` untouched; only assertion columns typed.
- `tab_catalog(tab_name, typed_table, display_order, column_order jsonb, row_count)` seeded from `extract_site.py` `cols`/`types`.
- `lead_status_classes` seeded from the frozen QSET/SHOWN; a comment/CI note forbids the engine ever reading it as logic.

**Labels:** `phase-1` `data` **Size:** M

---

### 2.9 Backfill job: port `extract_site.py` scrub, read via Sheets API

**Context.** One-time backfill loads history once, scrubbed, then hands off to live capture at a clean cutover. Ported from `extract_site.py` but reading via the Google Sheets API (the nightly sweep reuses the reader). Scrub facts from `clean.json.health`: `failed_zapier_rows=21713`, `broken_formula_cells_approx≈27000`, 7 junk tabs, target `bookings_rows=23385`.

**Acceptance criteria.**
- Tab allow-list = the exact 12 tabs in `extract_site.py`; never reads the 7 junk/old tabs (incl. `Bookings - zapier failed`).
- Blank-row drop (`extract_site.py` line 53) reproduced; Bookings rows with no date in **either** basis AND no key → `raw_rows` quarantine `no_date_no_key`.
- Broken-formula literals (`#REF!`, `#N/A`, `#VALUE!`, `#DIV/0!`, `#ERROR!`) → `""`/`0` per §6; original preserved in `raw_extra`, listed in `raw_extra.__coercion_errors__`.
- Type coercion = `conv()` verbatim (dates→`YYYY-MM-DD`, bool→`Yes/No`, int floats→int, else round(4)); names trimmed.
- Idempotent, re-runnable; on completion runs the HUB assertion and rejects itself if it fails.

**Labels:** `phase-1` `data` `ingestion` **Size:** L

---

### 2.10 [P1] Split-payment handling: one booking, one `Total Cash Collected`

**Context.** **Measured: `Total Cash Collected` = `First Call Cash` + `Follow Up Call Cash` in all but 1 of the cash-bearing rows; 163 rows have a follow-up payment; mixed Stripe/Whop/SplitIt/Elective/BankTransfer sources.** The sheet already collapses split payments into one row's one field, and the engine sums that single field. The danger is on the live side — a Stripe Zap and an Elective Zap for the same deal firing as two `/ingest` events must not create two `bookings` rows.

**Acceptance criteria.**
- Backfill: booking cash = the single `Total Cash Collected` field; never re-summed from sub-fields.
- Nightly assertion: `total_cash_collected == first_call_cash + follow_up_cash` (the 1 mismatch flagged, not "fixed").
- Live payment events do NOT create `bookings` rows (see Epic 3); until a shared key is proven, booking cash reconciles from the sheet nightly, not summed live.

**Labels:** `phase-1` `data` `p1` `blocked-on-export` **Size:** S

---

# EPIC 3 — Ingestion & Reconciliation

Onward capture from Zapier (parallel POST), idempotent upsert, out-of-order safety, cutover, nightly sweep + HUB assertion. **Several P0/P1s here are gated on the Zap/Close export** — the live stable key is unconfirmed.

---

### 3.1 Generic `POST /ingest` contract (source-tagged, idempotent, append-first)

**Context.** One endpoint; every current Zap and future form/tool posts here. Envelope: `source`, `external_id`, `event_type`, `occurred_at`, `schema`, `payload`. Payload stored raw in `raw_events` **before** any mapping (replay guarantee). Response `202` (write-behind — never make a Zap wait on projection).

**Acceptance criteria.**
- Endpoint validates envelope; unknown/disabled `source` → 403; malformed → 400.
- Raw event committed synchronously to `raw_events`; projection may be queued.
- Response codes per spec: `202` / `202 duplicate:true` / `400` / `401` / `403` / `409 stale` / `422 needs_mapping` / `429/5xx transient`.
- `422` payloads still land raw, flagged `needs_mapping`, alerted.

**Labels:** `phase-1` `ingestion` **Size:** M

---

### 3.2 Per-source auth (bearer secret) + transport idempotency

**Context.** Per-source bearer secret stored hashed in `sources`, rotatable (accept old+new during a window). Transport idempotency via `Idempotency-Key` or `sha256(source|external_id|event_type|occurred_at|canonical(payload))`, unique in `raw_events.dedupe_hash` — kills Zapier retry storms.

**Acceptance criteria.**
- Missing/bad secret → 401, logged. A leaked setter-Zap secret cannot forge closer-cash events.
- Duplicate within retention window → `202 duplicate:true`, zero work.
- Secret rotation documented and tested.

**Labels:** `phase-1` `ingestion` `security` **Size:** S

---

### 3.3 Config-driven field mappings (`sources` + `source_field_mappings`, versioned)

**Context.** Incoming field → normalized column is a row in `source_field_mappings`, not code. Versioned (`active_from`/`active_to`) so a re-map is auditable and history can be replayed. Seed the Bookings mapping with the exact engine column names.

**Acceptance criteria.**
- `sources(slug, label, system, target_table, natural_key_field, event_kind_field, is_active, …)`.
- `source_field_mappings(source_id, incoming_field, target_column, target_type, transform, is_natural_key, is_required, active_from, active_to)` + partial index on active rows.
- Adding a Zap = insert `sources` + mapping rows via admin, no deploy.
- Closing a mapping + re-running the router over `raw_events` surfaces the re-mapped value retroactively.

**Labels:** `phase-1` `ingestion` **Size:** M

---

### 3.4 Router + coercion registry (`money_usd`, `date_pst`, `yesno_bool`, `trim`)

**Context.** Router reads `sources`+`source_field_mappings`, coerces via a small pure-function registry mirroring `extract_site.py`'s `conv`/`infer` and the engine's guards. Coercion failures fall back (0/NULL) and preserve the raw value — never destructive.

**Acceptance criteria.**
- `money_usd`: strip `$`,`,`,spaces; `#REF!`/`#N/A`/blank → 0 (matches `+r[ca]||0`).
- `date_pst`: slice to leading 10 chars; anything not matching `^\d{4}-` → NULL (matches `buildBK`).
- `yesno_bool`, `trim` per `conv`.
- Bad coercion preserved in `raw_extra`; `raw_extra.__coercion_errors__` lists error-coerced columns.

**Labels:** `phase-1` `ingestion` `engine` **Size:** S

---

### 3.5 [P0] Upsert model: single watermark = `occurred_at` + ingest-seq tiebreak

**Context.** A booking is mutable (status No Show→Qualified→Closed; cash 0→2490). **The two spec docs specified two different, incompatible resolvers:** schema §4 guards on `last_event_id` (arrival serial — a replayed old event gets a *higher* id and wrongly wins), ingestion §3.2 guards on `occurred_at` (event time). Pick one: event time.

**Acceptance criteria.**
- Upsert guard: `WHERE EXCLUDED.occurred_at > bookings.occurred_at OR (EXCLUDED.occurred_at = bookings.occurred_at AND EXCLUDED.ingest_seq > bookings.ingest_seq)`.
- The `last_event_id >` guard is removed everywhere.
- `raw_extra` merges (`||`) so prior unmapped fields survive.
- Worked cases pass: same event twice (no-op); update-before-create (update inserts, later create stored-not-applied); downward cash correction (newer wins).

**Labels:** `phase-1` `ingestion` `p0` **Size:** M

---

### 3.6 [P1] Whole-row LWW safety when `occurred_at` is coarse/missing

**Context.** Under Zapier, delivery order ≠ event order and multiple Zaps fire per change. If `occurred_at` is unavailable (Flag #3) the gateway stamps `received_at`, and whole-row LWW can clobber fresh cash with a stale status-only re-fire. Whole-row is only safe if update-Zaps send the **full** booking row (the sheet-update Zaps do) AND ordering is by true event time.

**Acceptance criteria.**
- Confirm from export whether `occurred_at` is in the payload and whether update-Zaps send full rows (Flags #2, #3).
- If `occurred_at` unavailable: cash never regresses downward without an explicit `refund` event_type; otherwise take the value from the event with the latest source timestamp.
- Test: stale status-only re-fire arriving after a cash update does not zero the cash.

**Labels:** `phase-1` `ingestion` `p1` `blocked-on-export` **Size:** M

---

### 3.7 [P1] Reschedule / closed-month integrity: assert against frozen period snapshots

**Context.** Default basis is `Scheduled Call Date (PST)`, which is mutable. A June call rescheduled to July, under whole-row LWW, silently leaves June — a previously-green June HUB assertion goes red with no code change. Live view wants the move; HUB parity wants June frozen. Same log, two reads.

**Acceptance criteria.**
- On month close, freeze that month's per-person aggregates into `reconciliation_runs.actual`.
- The nightly HUB assertion for June compares against the **frozen snapshot**, not a recomputation over mutable rows.
- Effective-dated reconstruction ("June as it stood on July 1") available from the append-only log for audit.
- Client confirms desired reschedule-across-month behavior (move vs stay); both reads implemented off one log.

**Labels:** `phase-1` `ingestion` `p1` **Size:** M

---

### 3.8 [P1] Cutover: adoption/merge of synthetic backfill rows by live opportunity id

**Context.** The spec claimed the overlap "self-heals" because backfill upserts by key. **It does not** — backfill rows are `synthetic`-keyed, live rows are `opportunity`-keyed; the same booking inserts twice → double-count. Only an explicit adoption step dedups the window.

**Acceptance criteria.**
- T0 = the UTC instant the parallel webhook action goes live; backfill reads the sheet snapshot as of T0; backfill rows `origin='backfill'`, `occurred_at<=T0`; live events `occurred_at>=T0`.
- Adoption step (end of backfill + nightly): a live `oppo_X` row matched on `(scheduled_call_date, lead_owner, prospect_email, cash≈, lead_status)` to a `synthetic` row → adopt `external_id=oppo_X`, `key_source='opportunity'`, keep newer state, retire the synthetic duplicate; log every adoption.
- Ambiguous match (multiple candidates) → `quarantine('id_merge_ambiguous' / 'update_ambiguous_no_key')`, never blind-merge two cash-bearing rows.

**Labels:** `phase-1` `ingestion` `p1` `blocked-on-export` **Size:** L

---

### 3.9 [P2] Soft-delete / cancellation handling (stop nightly resurrection)

**Context.** If a cancel/delete Zap fires, the DB removes the row but the sheet keeps it; next sweep sees "in sheet, not in DB" and re-inserts it → the booking resurrects every night. `ingest_kind` has `delete` but no rule says what it does.

**Acceptance criteria.**
- Deletes are **soft**: set `is_cancelled`/`is_quarantined=true`; excluded from engine reads (partial index already filters).
- Sweep's "in sheet, not in DB → repair" skips keys tombstoned by a later `delete` event in `raw_events`.
- Confirm from export whether cancel/delete Zaps exist at all (Close cancellations may only be a `Lead Status` change, making this moot).

**Labels:** `phase-1` `ingestion` `p2` `blocked-on-export` **Size:** S

---

### 3.10 [P2] Person dual-role: role is per-row, never a person attribute

**Context.** **Measured: 8 people are both a `Lead Owner` and an `Attributed Setter Full Name`** (AJ Abdelaal, Adam Farinaccio, Danny Le, Gunkar Singh, Ivan Merc, Jerome Schreiber, Kaitlin Nguyen, Shanice Moore). The engine handles this correctly by grouping on the column. A `people` table with unique `(name)` + single `role` (hinted by the `person_role` enum) would break it.

**Acceptance criteria.**
- Role is derived per-row from which column the name appears in; never stored as a person attribute.
- `person_role` enum dropped/repurposed; any `people` dimension uses a many-to-many derived view.
- Person matching stores trimmed names (JS `.trim()` semantics) so setter/closer grouping matches the engine.

**Labels:** `phase-1` `ingestion` `p2` **Size:** S

---

### 3.11 [P3] Close lead/opportunity merge handling (`external_id_aliases`)

**Context.** When Close merges leads/opportunities the surviving id changes; a post-merge UPDATE under the new id creates a second `bookings` row → double-count. Rare (few rows are id-keyed) but real for the 354 keyed rows and all future live rows.

**Acceptance criteria.**
- `external_id_aliases(booking_id, external_id, source, seen_at)` records every id a row was seen under.
- New event whose id doesn't match but whose content matches an existing booking → link alias, don't insert.
- Ambiguous id-change → `quarantine('id_merge_ambiguous')`; never auto-merge two cash-bearing rows.
- The nightly sweep (keyed on nothing) catches id-merge drift as `field_drift`/`db_only`.

**Labels:** `phase-2` `ingestion` `p3` `blocked-on-export` **Size:** M

---

### 3.12 Nightly sheet-diff & repair sweep

**Context.** Re-read the 12 tabs, scrub, diff vs `bookings` by key. In-sheet-not-in-DB → missed webhook, repair + alert. In-DB-not-in-sheet → never auto-delete, flag for human. Load-bearing fields differ → resolve by `occurred_at`, log drift. **Guard: never overwrite a webhook-fresh row (`occurred_at_estimated=false`) with sheet-derived data (`=true`)** — the original §6.1 "sheet is newer → repair toward sheet" can regress fresh data because a hand-edited cell has no reliable timestamp.

**Acceptance criteria.**
- Emits a recon report: `missed_webhooks`, `db_only`, `field_drift`, `dedup_collisions`, `adoptions`, counts + sample keys.
- Repair never clobbers a row with `occurred_at_estimated=false`.
- Alert when `missed_webhooks > threshold` (a broken Zap).
- Dateless/keyless rows excluded from the "missing webhook" population.

**Labels:** `phase-1` `ingestion` **Size:** L

---

### 3.13 Which tabs get live capture in v1 (rule of thumb)

**Context.** A tab gets live capture only when (a) a dashboard reads it and (b) a Zap already writes it. Only **Bookings** meets both in v1. Payments/Refunds/Elective = phase-1.5. Leads/Jotform/Residuals = backfill only. Call Dashboard / Leads Over Time = recomputed, not ingested. HUB = reconciliation oracle, not ingested as data.

**Acceptance criteria.**
- `sources` seeded: `zap_bookings_create`, `zap_bookings_update`, `sheet.backfill`.
- Payments/Refunds/Elective sources defined but inactive in v1.
- HUB tabs loaded read-only for assertions only.
- Documented which of the 147 Zaps carry Bookings create/update (confirm from export).

**Labels:** `phase-1` `ingestion` `blocked-on-export` **Size:** S

---

# EPIC 4 — Metric Engine + HUB Test

Port `buildBK`/`aggregate`/`series`/`rate`/`statusMix` + `svgCombo`/`svgDonut` and the `SHOWN`/`QSET`/`PALETTE` constants **verbatim**. Re-implementing in another language is forbidden. Then convert `tune.py` into hard assertions.

---

### 4.1 Verbatim port of the metric engine to `/src/engine/metrics.ts`

**Context.** The frozen unit: `buildBK` (line 193), `aggregate` (252), `series` (260), `rate` (259), `statusMix` (268), `QSET`/`SHOWN` (157–158). It takes an in-memory array shaped like `buildBK`'s output (`{cs, bd, o, s, st, cash, fees}`) and returns numbers. Zero infra dependencies.

**Acceptance criteria.**
- Functions ported character-faithful; behavior identical to the prototype.
- `SHOWN` derived as `QSET ∪ {'Call Completed - Disqualified'}` (union, not a hand-listed 6th element).
- `closed = cash > 0` (strict), computed at query time only; **no stored `is_closed` boolean anywhere** (CI asserts no such column/view exists).
- `shown`/`qual`/`closed`/`cash` counted fully decoupled (a `closed` row need not be `qual`; do not add "closed implies qualified").
- Engine imports nothing from `pg`/`fs`/framework.

**Labels:** `phase-1` `engine` `p0` **Size:** M

---

### 4.2 [P0] Preserve date handling: leading 10-char text, never a tz-aware instant

**Context.** The single highest-risk port drift. `buildBK` does `(''+(r[cs]||'')).slice(0,10)` — a raw string prefix, never a parsed `Date`. Range compare is **string** `>=from && <=to`, inclusive both ends. If ingest stores the date as `timestamptz` and re-serializes, a `2026-06-30T23:00-07:00` call shifts to `2026-07-01Z` and leaves June — reconciliation breaks silently.

**Acceptance criteria.**
- Dates stored/compared as the leading 10-char text of the source cell; never normalized to a DB tz-aware instant before the engine sees them.
- `|| ''` coalesce preserved (null/blank → excluded by the `if(!dk)` guard).
- Range filter is lexicographic string compare, inclusive both ends — not a `Date` `<= to` at `00:00`.
- Boundary test: `2026-06-30T23:59:59-07:00` → June; `2026-07-01T00:00:01-07:00` → July.

**Labels:** `phase-1` `engine` `p0` **Size:** S

---

### 4.3 Preserve name trim, status exactness, money coercion

**Context.** Names use `.trim()` only — no case-fold, no whitespace collapse (`"Sam Aujla"` ≠ `"sam aujla"`; double-space is a third person). Status is `r[st]||''` — **untrimmed**, exact-case `Set.has` (a trailing space on `"Closed "` drops it from every rate denominator; en-dash vs `" - "` breaks match). Cash is `+r[ca]||0` (`Number(x)` semantics, not `parseFloat`) — `"$1,790"` → NaN → 0, so ingest must deliver bare numbers.

**Acceptance criteria.**
- TS trim matches JS `String.prototype.trim` on the full set of distinct owner/setter values (diff test).
- Status not trimmed/normalized before QSET/SHOWN check; QSET/SHOWN literals hashed and asserted byte-exact.
- Money coercion = `Number(x)||0` (not `parseFloat`); ingest strips `$`/`,` so values parse; assert `Σ engine_coerce == Σ (+cell||0)`.

**Labels:** `phase-1` `engine` **Size:** S

---

### 4.4 Preserve trend granularity, month bucketing, sort, column resolution, TODAY

**Context.** `daily = span <= 92` where `span = daysBetween(from,to)+1` (92 inclusive → daily, 93 → monthly); `daysBetween` parses UTC midnight. Monthly key = `.slice(0,7)` with a guarded UTC month walk. Leaderboard sort = desc cash, tiebreak desc bookings (stable). Column lookup = trim+lowercase exact; a missing column returns -1 → must fail loudly, not zero silently. `TODAY='2026-06-30'` is load-bearing (clamps DMAX/presets) — make it injectable and pin it in fixtures.

**Acceptance criteria.**
- `daysBetween('2026-06-01','2026-06-30')==29`; span-92 → daily, span-93 → monthly.
- Month walk parses `s+'-01'` as UTC; no skipped/duplicated month across DST.
- Sort comparator ported; sort is stable.
- Startup assertion: all 7 required columns resolve to index ≥ 0, else the process fails loudly.
- `TODAY` is a config value, pinned to `2026-06-30` in parity/HUB fixtures; defined as a PST calendar date if made dynamic.

**Labels:** `phase-1` `engine` **Size:** S

---

### 4.5 [P0] Port `tune.py` to a hard-assertion HUB test (closers + setters)

**Context.** `tune.py` currently only **prints** — it can drift green forever. The port must assert every pair and add the union/whitespace/coercion guards. It runs as (a) end-of-backfill gate, (b) CI on every deploy against a fixture, (c) nightly against live.

**Acceptance criteria.**
- Per-closer June-2026 exact equality: `bookings`, `shown==showed`, `qual`, `closed==dmpn+dma` (None→0), `round(cash)==round(HUB.cash)`.
- Named anchors: Sam Aujla `50/43/27`, close rate `62.79%`; **team cash `== 455674.90` to the dollar** (integer-dollar tolerance).
- Grand-total assertions (catch offsetting per-person errors).
- **Setter-side** reconciliation with the identical five-metric check (tune.py checks only closers).
- Guards: `SHOWN == QSET ∪ {Disqualified}`; whitespace canary (no status differs from a set member only by case/whitespace); name-trim diff vs JS; money `Σ` equality; `closed == count(cash>0)` and `!= count(cash>=0)`; refund row excluded from `closed` but included in `cash`; column-resolution ≥0; date-basis computed two ways (string-prefix vs server path) must match.
- Fail → non-zero exit / page / block deploy.

**Labels:** `phase-1` `engine` `p0` **Size:** M

---

### 4.6 [P2] Status-drift tripwire: `DISTINCT lead_status ⊆ frozen 7`

**Context.** A broken formula or sheet edit can introduce a new/typo'd status that the exact-match engine silently drops from `shown`/`qual` without failing the cash assertion. `lead_status_classes` is the tripwire, used only for this.

**Acceptance criteria.**
- Nightly: assert `SELECT DISTINCT lead_status FROM bookings` ⊆ the frozen set; alert and name any new value.
- Never used as aggregation logic.

**Labels:** `phase-1` `engine` `p2` **Size:** XS

---

# EPIC 5 — Read API

Serve the three dashboards + 12 paginated raw tabs from typed tables, feeding the engine the exact `buildBK` record shape.

---

### 5.1 SQL projection matching `buildBK`'s record shape

**Context.** The load-bearing boundary: reproduce `{cs, bd, o, s, st, cash, fees}` as a SQL projection so ported `aggregate/series/statusMix` run unchanged over the returned rows.

**Acceptance criteria.**
- A query returns exactly the 7 fields (dates as 10-char text, names trimmed, status raw, cash/fees numeric), filtered `is_quarantined=false`.
- The engine consumes the result with no adapter/reshaping.
- Parity test: engine over API rows == engine over the prototype's embedded `BK` for June.

**Labels:** `phase-1` `api` `engine` **Size:** S

---

### 5.2 Dashboard endpoints (Overview / Closer / Setter) with date-range + basis

**Context.** Three dashboards compute live from Bookings for the selected range; basis toggle (`call`/`book`) is first-class. Overview also reads `overview.new_returning` and `overview.lead_sources` (all-time context) from precomputed aggregates.

**Acceptance criteria.**
- `GET` endpoints accept `from`, `to`, `basis`, and (for person views) role/name.
- Server runs the engine and returns KPIs + series + status mix + leaderboards.
- Overview endpoint supplies new-vs-returning + lead-sources context.
- Response matches the prototype's numbers for the same params.

**Labels:** `phase-1` `api` **Size:** M

---

### 5.3 Paginated read-only raw-tab API (12 tabs, config-driven)

**Context.** All 12 raw tabs paginated, read-only, rendered from `tab_catalog.column_order` so the grid shows all 38 Bookings columns like the prototype — while the engine touches only 7. Don't embed the full dataset in the client.

**Acceptance criteria.**
- One generic endpoint driven by `tab_catalog` (not 12 hard-coded routes).
- Server-side pagination (offset/limit or keyset) sized for the 45k-row tabs.
- Read-only: no write route exists for these.
- Column order/types come from `tab_catalog`.

**Labels:** `phase-1` `api` `frontend` **Size:** M

---

# EPIC 6 — Frontend Port

Reuse the framework-free prototype (354 lines of markup/CSS/SVG/virtualized grid/date engine). Delete only the embedded data blob + inflate; fetch from the API.

---

### 6.1 Rewire `boot()` from embedded blob to `fetch()`

**Context.** Keep all markup/CSS/`svgCombo`/`svgDonut`/`dateBar`/`presetRange`/CSS tokens. Delete the `payload`/`dash` `<script>` blobs and the `DecompressionStream` inflate; replace with `fetch()`.

**Acceptance criteria.**
- `boot()` fetches dashboard data from the API instead of inflating the embedded blob.
- All SVG charts, date engine, CSS tokens unchanged.
- Prototype renders identically against live API data.

**Labels:** `phase-1` `frontend` **Size:** M

---

### 6.2 Paginate the virtualized raw-tab grid (fetch-on-scroll shim)

**Context.** Keep the `total * 34px` spacer and the custom virtualizer; add a fetch-on-scroll shim rather than rewriting `renderRows()`. The grid must not require the whole tab in memory.

**Acceptance criteria.**
- Grid requests pages as the user scrolls; spacer height reflects `total` row count from the API.
- 45k-row tabs scroll smoothly without loading all rows.
- `renderRows()` largely unchanged.

**Labels:** `phase-1` `frontend` **Size:** M

---

### 6.3 Keep date-basis toggle + per-day/per-month trend behavior

**Context.** Date-basis toggle and the ≤92-day daily / else monthly trend are locked product behaviors.

**Acceptance criteria.**
- Basis toggle drives the `basis` API param and re-renders.
- Trend granularity flips at the 92/93-day boundary exactly as the engine computes.
- Presets (`presetRange`) behave against the injected `TODAY`/`DMAX`.

**Labels:** `phase-1` `frontend` **Size:** S

---

# EPIC 7 — Auth & Admin

Email allow-list, magic-link, structurally read-only for viewers; admin surface is the only in-app write path.

---

### 7.1 Email allow-list + passwordless magic-link auth

**Context.** Allow-list = "row exists AND is_active". Magic-link (signed one-time link via SMTP), one `HttpOnly/Secure/SameSite=Lax` signed cookie. Not-on-list → generic "ask an admin" (no user enumeration). Bootstrapped from `ALLOWLIST_BOOTSTRAP`.

**Acceptance criteria.**
- `users(email citext unique, full_name, role, is_active, last_login_at, invited_by, created_at)`; partial index on active emails.
- Magic-link flow works end to end; cookie signed with `SESSION_SECRET`.
- Unknown email → generic response, no enumeration.
- Admins seeded from `ALLOWLIST_BOOTSTRAP` on first boot.

**Labels:** `phase-1` `auth` **Size:** M

---

### 7.2 Structural read-only + admin gating

**Context.** Read-only enforced two ways: no write routes exist for viewers, and the request-handler Postgres role has `SELECT` only on typed tables (writes go through the worker's separate role). `requireAdmin` 404s the admin surface for viewers. `/ingest` is HMAC/secret, not session.

**Acceptance criteria.**
- Request-handler DB role: `SELECT` only on typed tables.
- No write route reachable by a `viewer`.
- Admin routes 404 for non-admins (not 403 — no surface disclosure).
- `/ingest` auth is per-source secret, independent of sessions.

**Labels:** `phase-1` `auth` `security` **Size:** S

---

### 7.3 Admin surface: Sources / Mappings / Users / Jobs / Raw events

**Context.** Five panels; the append-only `raw_events` log is the replayable source of truth, typed tables a projection. A non-dev admin can add a Zap source + field→column mapping (no deploy), trigger a **replay** of `raw_events` after a mapping change, add/remove allow-listed users, and view the ops panel.

**Acceptance criteria.**
- Panels: Sources, Field mappings, Users, Jobs, Raw events.
- Add source + mapping persists to `sources`/`source_field_mappings`; no deploy needed.
- Replay button re-runs the router over a source's `raw_events`.
- User add/remove issues/revokes access immediately (no SSH, no redeploy).

**Labels:** `phase-1` `auth` `ingestion` **Size:** L

---

# EPIC 8 — Deployment & Ops

Docker Compose on the VPS, cron/worker, backups/PITR, logging/alerting, near-zero-downtime deploy, portability path.

---

### 8.1 Compose topology: caddy / app×2 / worker / postgres / pgbackup

**Context.** Caddy (auto-HTTPS, webhook rate-limit) is the only internet-exposed service; `app` 2 replicas for start-first rolling restart; `worker` single-instance (one scheduler); Postgres 16 with WAL archiving; `pgbackup` sidecar.

**Acceptance criteria.**
- `docker-compose.yml` + `Caddyfile` per spec; webhook path rate-limited and HTTPS-only.
- `app` healthcheck hits `/healthz` (DB reachable + fast HUB spot-check); Caddy routes only to healthy upstreams.
- `worker` not replicated.
- Postgres `wal_level=replica`, `archive_mode=on` to a `pgwal` volume.

**Labels:** `phase-1` `deploy` **Size:** M

---

### 8.2 In-app scheduler with Postgres advisory locks (portable cron)

**Context.** Scheduling lives in `worker` via an in-process scheduler (not host crontab / not a cron container) so it lifts to Vercel Cron unchanged. Every job takes `pg_try_advisory_lock(<job_id>)` so overlapping invocations run once — safe on multi-instance Vercel.

**Acceptance criteria.**
- Four jobs registered: backfill (manual), nightly reconcile+HUB (03:00), webhook-health (15 min), monthly restore-drill.
- Each job wrapped in an advisory lock; a second scheduler cannot double-run it.
- Same job bodies invokable via `/cron/<job>` routes for the Vercel path.

**Labels:** `phase-1` `deploy` **Size:** M

---

### 8.3 Backups: nightly `pg_dump` offsite + WAL PITR + replay backstop

**Context.** Three layers because `raw_events` is unrecoverable if lost: nightly `pg_dump -Fc` → offsite S3-compatible bucket (30 daily + 12 monthly); WAL archiving → PITR to the minute; and replay of the append-only log as the deepest backstop. Restore is "done" only when the HUB assertion passes.

**Acceptance criteria.**
- Nightly dump uploads offsite; retention enforced.
- WAL shipped; documented PITR restore runbook.
- Monthly `restore-drill` job restores yesterday's dump to a throwaway Postgres, runs the HUB assertion, alerts on failure.
- Restore runbook ends with the HUB assertion as the verification step.

**Labels:** `phase-1` `deploy` **Size:** M

---

### 8.4 Structured logging + drift/webhook/health alerting

**Context.** pino JSON logs to stdout (Docker json-file rotation; Vercel drain later). Alerts POST to `ALERT_WEBHOOK_URL` in three classes: reconciliation drift (critical, `@here`, with $ delta + failing rep), webhook silence (names the dead source), app/DB/backup health. Alert history persisted in an `alerts` table. Inbound `/ingest`/`/webhooks/*` must present the shared/source secret or 401.

**Acceptance criteria.**
- pino structured logs; container log rotation configured.
- Three alert classes wired to `ALERT_WEBHOOK_URL`.
- `reconciliation_runs` + `alerts` tables persist run outcomes and alert history.
- Admin ops panel shows last runs, webhook freshness per source, last backup, current allow-list.

**Labels:** `phase-1` `deploy` **Size:** M

---

### 8.5 Near-zero-downtime deploy with HUB post-deploy gate + rollback

**Context.** Build image tagged by git SHA → forward-only migrations in a one-shot → start-first rolling replace of `app` (healthcheck includes a HUB spot-check so a regressed replica never gets traffic) → replace `worker` → post-deploy full HUB assertion; **fail → roll back** to the cached previous image + alert. A deploy that would break HUB reconciliation cannot go live.

**Acceptance criteria.**
- `deploy.sh` performs the ordered steps; migrations run before the rollout.
- `/healthz` includes a pinned-month HUB spot-check.
- New `worker` runs the full HUB assertion on boot; failure triggers automatic rollback + alert.

**Labels:** `phase-1` `deploy` **Size:** M

---

### 8.6 Portability path documented + guardrails enforced

**Context.** Lift to Vercel + Neon = config move: swap `DATABASE_URL`, import repo + paste env, convert 4 crons to Vercel Cron hitting `/cron/*`, delete Caddy + pgbackup, run the HUB assertion once. Guardrails: engine imports nothing from `pg`/`fs`/framework; no host-filesystem writes (object storage via env client); all background work idempotent + advisory-locked; forward-only platform-neutral SQL.

**Acceptance criteria.**
- `docs/PORTABILITY.md` with the VPS→Vercel mapping table.
- CI check: engine module has no forbidden imports; no code writes to local disk for uploads/exports.
- The four jobs are discrete idempotent advisory-locked routes.

**Labels:** `phase-1` `deploy` **Size:** S

---

### 8.7 `reconciliation_runs` durable record

**Context.** The nightly sweep + HUB assertion needs a durable record (this is `tune.py` promoted to a scheduled job): scope, passed, expected/actual/diff jsonb, note. Drives the ops panel and gives an audit trail.

**Acceptance criteria.**
- `reconciliation_runs(id, run_at, scope, passed, expected jsonb, actual jsonb, diff jsonb, note)`.
- Every backfill/nightly/CI assertion writes a row.
- Ops panel reads the last N rows.

**Labels:** `phase-1` `deploy` `engine` **Size:** XS

---

# EPIC 9 — Cost Audit (Zapier)

Bucket all 147 Zaps, model the savings against the real billing, sequence the retire/move rollout. Bucket **rules** are locked; per-Zap **assignment** needs the export.

---

### 9.1 Ingest the Zapier Task-History + Zap-step exports

**Context.** The whole per-Zap cost picture needs exports not yet available: per-Zap task counts, create-vs-update split on Sheet Zaps, which "integration" Zaps hide branching, which Zaps produce the 21,713 failed rows, and whether the Bookings Zaps carry a stable Close id + event timestamp (gates Epics 2–3).

**Acceptance criteria.**
- Task-History export loaded and per-Zap task counts tabulated.
- Zap-step config export loaded; branching Zaps identified.
- Close/opportunity-id presence + `occurred_at` presence confirmed on the Bookings create/update Zaps.

**Labels:** `phase-3` `cost` `blocked-on-export` **Size:** S

---

### 9.2 Bucket all 147 Zaps (RETIRE / RETIRE-P3 / MOVE-TO-FREE / KEEP)

**Context.** Four-question decision tree; first "yes" wins. RETIRE = app already holds/computes it (Reporting, Sheet-writes). RETIRE-P3 = reproducible notifications (Slack/FYI). MOVE-TO-FREE = mechanical tool↔tool sync with a native webhook (Close/Stripe/Calendly/Jotform/Manychat). KEEP = real branching / customer-facing glue. Rules are final; assignment confirmed from the export.

**Acceptance criteria.**
- Every Zap assigned to exactly one bucket with a one-line rationale.
- Biggest task multiplier (Sheet create/update Zaps) flagged as the top lever.
- KEEP list deliberately generous (anything customer-facing or branching stays).

**Labels:** `phase-3` `cost` `blocked-on-export` **Size:** M

---

### 9.3 Savings model + 3-phase rollout plan

**Context.** Bill = `898.50 + max(0, tasks−100,000)×0.0226`. Conservative (quote this): retire Reporting/Sheet-writes/notifications + move top mirrors → floor at **$898.50/mo, ~$7.2–9.6k/yr saved, spikes gone**. Optimistic: + replace Jotform + downgrade tier → **~$16–19k/yr saved**. Rollout: Phase 1 see-it (no change), Phase 2 own-the-data (small temporary bump), Phase 3 cut-the-glue (reproduce-then-retire, verified nightly by the HUB assertion).

**Acceptance criteria.**
- Model spreadsheet/doc reproducing the invoice decomposition and both scenarios.
- Rollout ordered: never retire a Zap before its replacement is proven by the nightly HUB assertion.
- Client one-pager (plain English, quality-first) produced alongside the internal audit.

**Labels:** `phase-3` `cost` **Size:** S

---

# EPIC 10 — Phase-2: Jotform-replacement Form Builder (STUB ONLY in v1)

Reserve the seam; ship no logic in v1.

---

### 10.1 Reserve the inbound form seam (design-only)

**Context.** A custom form submit will POST to our `/ingest` AND to a Zapier catch-hook so Close/downstream still fire — eventually retiring Jotform. Because `/ingest` is generic, no schema change is needed later — just new `sources` + `source_field_mappings` rows. `forms`/`form_submissions` are *documented*, not created in v1; the form UI + dual-post sit behind a disabled admin toggle.

**Acceptance criteria.**
- `docs/PHASE2_FORMS.md` describes the dual-post flow and the `sources` rows it will add.
- Admin toggle exists but is disabled; handler returns 501.
- No `forms`/`form_submissions` tables created in v1.

**Labels:** `phase-2` `ingestion` **Size:** XS

---

# EPIC 11 — Phase-2: Outbound Write-Back (STUB ONLY in v1)

Reserve the seam; ship no logic in v1.

---

### 11.1 Reserve the outbound write-back seam (design-only)

**Context.** Our app will POST to a Zapier Catch-Hook that fans out to tools — the seam that eventually lets the client cut Zapier/Jotform spend without losing quality. Stub `writeBack(event)` as a no-op that logs intent; reserve `outbound_events(id, target_hook_url, payload, status, attempts)` in the spec (uncreated in v1). `ZAPIER_CATCH_HOOK_URL` reserved/unset.

**Acceptance criteria.**
- `docs/PHASE2_WRITEBACK.md` describes the fan-out and the `outbound_events` shape.
- `writeBack(event)` interface exists as a logging no-op; route returns 501.
- No `outbound_events` table created in v1; env key reserved and unset.

**Labels:** `phase-2` `ingestion` **Size:** XS

---

# Build order (recommended)

1. **Engine port + HUB assertion first** (4.1–4.5) — the parity gate that governs everything else.
2. Foundation (Epic 1) + schema (2.1, 2.4–2.8).
3. Backfill with the P0 fixes (2.2, 2.3, 2.9) → must reproduce **$455,674.90** before anything is "green".
4. Read API + frontend port (Epics 5, 6).
5. Auth + admin (Epic 7).
6. Ingestion/reconciliation (Epic 3) — after the export unblocks the key questions (3.5, 3.6, 3.8, 3.9, 3.11, 3.13).
7. Deploy/ops (Epic 8).
8. Cost audit (Epic 9) in parallel once the export lands.
9. Phase-2 stubs (Epics 10, 11) last, as documentation + 501 handlers.

**The one thing before any ingestion code:** get the Zap/Close export and confirm the live payload carries a stable Close opportunity id + an event timestamp. Both spec docs were built on `Call ID` as the key; the data proves `Call ID` is 98.5% empty. Until the export confirms the live stable key, the model is **append + nightly-sweep**, and it still reconciles to $455,674.90 to the dollar.
