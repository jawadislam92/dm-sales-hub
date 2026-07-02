-- =====================================================================
-- Daily Mentor Sales Platform — Initial Postgres Schema (v1)
-- =====================================================================
-- Self-hosted Node/TypeScript + Postgres. Portable (Docker + env-driven);
-- lifts to Neon/Supabase unchanged (only pgcrypto + optional citext used).
--
-- Design contract (verified against the real data + the ported engine):
--   * The reconciling engine (dashboard.template.html buildBK/aggregate/
--     series/statusMix and pipeline/tune.py) COUNTS RAW BOOKINGS ROWS.
--     A booking == a sheet row. buildBK does t.data.map(...) with NO dedup;
--     tune.py does book+=1 per raw row. Therefore the DB must be a
--     ROW-FAITHFUL append of Bookings rows. "Upsert on a stable Close key"
--     is a narrow LIVE-only optimization, NOT the correctness primitive.
--   * MEASURED on data/site_data.json (23,385 Bookings rows):
--       - `Call ID` populated on only 354 / 23,385 rows (1.5%).  ==> it
--         CANNOT be a PRIMARY KEY (NULL on 98.5% of rows) and CANNOT be the
--         upsert key for backfill. PK is a surrogate bigint; call_id is a
--         nullable, non-unique attribute.
--       - The synthetic tuple (booking_date|scheduled_call_date|email|
--         lead_owner) collides across 151 groups / 9,881 rows, 77 groups
--         holding genuinely-distinct bookings (e.g. one "Closed/$5000" +
--         one "Setter Qualified Booked Call/$0" share the tuple). ==> NEVER
--         merge on that tuple. Backfill INSERTS 1:1 by sheet row position.
--       - ~9,567 Bookings rows have no email AND no parseable date (cash=$0);
--         they are metric-ineligible. The go-live gate is the HUB assertion
--         ($455,674.90; Sam Aujla shown 50 / qual 43 / closed 27), NOT a
--         bookings row count.
--   * Engine-critical Bookings columns (exact headers) confirmed present:
--       Booking Date, Scheduled Call Date (PST), Lead Owner,
--       Attributed Setter Full Name, Lead Status, Total Cash Collected,
--       Total Cash Collected after Fees  (note lowercase "after").
--   * Frozen status sets (template lines 157-158) live in a REFERENCE table
--     for humans; the engine still HARD-CODES them. closed == cash>0 ALWAYS,
--     computed at query time; never a stored boolean.
--
-- Migration ordering (see bottom of file for detail):
--   1) extensions, enums, sources, users, lead_status_classes, tab_catalog
--   2) raw_events, raw_rows, quarantine, source_field_mappings, recon_runs
--   3) typed tables (bookings first, then 11 mirrors)
--   4) indexes (created here; for a cold backfill, defer the heavy bookings
--      indexes until after bulk load, then ANALYZE — noted inline)
--   5) roles/grants (append-only + read-only enforcement)
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email joins across tabs
                                           -- (optional: if unavailable on the
                                           -- target host, swap CITEXT -> TEXT and
                                           -- lower() the join keys.)

-- ---------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------
-- ingest_kind: what a raw event represents. 'backfill' = a synthetic event
-- minted per historical sheet row; 'snapshot' = a full-state re-post.
CREATE TYPE ingest_kind   AS ENUM ('create','update','delete','snapshot','backfill');

-- process_state: lifecycle of a raw event / raw row through the router.
CREATE TYPE process_state AS ENUM ('pending','processed','quarantined','skipped','replayed');

-- key_source: how a typed row's identity was established. 'row_position' =
-- backfill sheet-row identity (the common case, 98.5%). 'opportunity' =
-- a proven Close opportunity/call id from a live Zap payload. 'content_link'
-- = a live event adopted onto a backfill row via content match.
CREATE TYPE key_source    AS ENUM ('row_position','opportunity','call_id','content_link','synthetic');

-- date_basis mirrors the engine's DR.basis toggle: 'call' = Scheduled Call
-- Date (PST) [DEFAULT], 'book' = Booking Date.
CREATE TYPE date_basis    AS ENUM ('call','book');

-- =====================================================================
-- 2. CONFIG / REGISTRY LAYER
-- =====================================================================

-- sources: every ingest path (backfill, each wired Zap, future form builder)
-- declares a source slug. The router reads target_table + natural_key_field
-- here — routing is data, not hard-coded.
CREATE TABLE sources (
  id                SMALLINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  slug              TEXT UNIQUE NOT NULL,     -- 'sheet.backfill','zapier.bookings.update','close.webhook'
  label             TEXT NOT NULL,
  system            TEXT NOT NULL,            -- 'sheet'|'zapier'|'close'|'jotform'|'stripe'|'elective'|'form_builder'(ph2)
  target_table      TEXT,                     -- 'bookings'|'leads'|... ; NULL for a generic/unrouted source
  natural_key_field TEXT,                     -- payload field holding the stable id, e.g. 'opportunity_id' or 'Call ID'
  event_kind_field  TEXT,                     -- payload field naming create/update, if any
  occurred_at_field TEXT,                     -- payload field holding the true event time (Close date_updated), if exposed
  is_active         BOOLEAN NOT NULL DEFAULT true,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE sources IS
  'Registry of ingest paths. Router looks up target_table / natural_key_field / occurred_at_field per source — no hard-coded routing. Junk tabs simply have no active row here so backfill never lands them.';

-- source_field_mappings: incoming field -> normalized column, VERSIONED so a
-- re-map is auditable and history can be REPLAYED from raw_events with the
-- corrected mapping (the core "platform, not a report" guarantee).
CREATE TABLE source_field_mappings (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT NOT NULL REFERENCES sources(id),
  incoming_field TEXT NOT NULL,              -- key/path in payload jsonb, e.g. 'Total Cash Collected'
  target_column  TEXT NOT NULL,              -- normalized column, e.g. 'total_cash_collected'
  target_type    TEXT NOT NULL,              -- 'date'|'money'|'num'|'pct'|'text'|'bool' (== extract_site.infer vocab)
  transform      TEXT,                        -- named coercer: 'money_usd'|'date_pst'|'yesno_bool'|'trim' (see §Coercion note)
  is_natural_key BOOLEAN NOT NULL DEFAULT false,
  is_required    BOOLEAN NOT NULL DEFAULT false,
  active_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_to      TIMESTAMPTZ,                 -- NULL = current; close-and-insert on a re-map
  UNIQUE (source_id, incoming_field, active_from)
);
COMMENT ON TABLE source_field_mappings IS
  'Config-driven field->column mapping, versioned. On a re-map: set active_to=now() on the old row, insert a new one, then re-run the router over raw_events to surface previously-unmapped fields with zero re-pull.';
-- Only the CURRENT mappings for a source are hot on the ingest path.
CREATE INDEX ix_sfm_source_active ON source_field_mappings(source_id) WHERE active_to IS NULL;

-- tab_catalog: drives the generic read-only "12 raw tabs" grid so the
-- explorer is config, not 12 hard-coded endpoints. column_order preserves
-- the exact extract_site.py cols/types so the grid renders identically
-- (incl. blank headers and the tab-mashed 'Leads Over Time' last column).
CREATE TABLE tab_catalog (
  tab_name      TEXT PRIMARY KEY,            -- 'Bookings','Leads',... exactly as in the sheet
  typed_table   TEXT NOT NULL,              -- 'bookings','leads',...
  display_order SMALLINT,
  column_order  JSONB NOT NULL,             -- ordered [{header,type}] from extract_site cols/types
  row_count     INTEGER
);
COMMENT ON TABLE tab_catalog IS
  'Config for the read-only raw-tab explorer. column_order == extract_site.py cols/types so the grid renders every column (incl. blank/duplicate/mashed headers) exactly like the prototype.';

-- =====================================================================
-- 3. AUTH / ALLOW-LIST
-- =====================================================================

-- users: the email allow-list IS "a row exists AND is_active". Read-only is
-- the default; the admin surface (add user / source / mapping) is admin-only
-- and is the ONLY write path in the request app.
CREATE TABLE users (
  id            BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  email         CITEXT UNIQUE NOT NULL,      -- allow-list key (case-insensitive)
  full_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'viewer',  -- 'viewer' (read-only) | 'admin'
  is_active     BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  invited_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_users_role CHECK (role IN ('viewer','admin'))
);
CREATE INDEX ix_users_active ON users(email) WHERE is_active;

-- lead_status_classes: REFERENCE ONLY. Seeded from template lines 157-158 so a
-- non-dev can SEE the classification and the nightly sweep can flag any NEW
-- status value the sheet introduces. The engine STILL hard-codes QSET/SHOWN —
-- this table must never become the aggregation source, or a stray edit would
-- silently break HUB reconciliation.
CREATE TABLE lead_status_classes (
  status_value  TEXT PRIMARY KEY,           -- 'Qualified Showed Call', ...
  is_shown      BOOLEAN NOT NULL,           -- membership in SHOWN
  is_qualified  BOOLEAN NOT NULL,           -- membership in QSET
  is_no_show    BOOLEAN NOT NULL DEFAULT false
);
COMMENT ON TABLE lead_status_classes IS
  'DISPLAY/TRIPWIRE ONLY. Frozen QSET/SHOWN from the engine. Never the source of aggregation. Nightly sweep asserts DISTINCT bookings.lead_status is a subset of these values and alerts on drift.';

-- =====================================================================
-- 4. RAW / APPEND-ONLY SPINE
-- =====================================================================

-- raw_events: the append-only source of truth. One row per webhook POST and
-- one synthetic 'backfill' event per historical sheet row. IMMUTABLE payload
-- and identity; only process_state/processed_at mutate, and only via a narrow
-- stored function (see §7 grants). Truncating a typed table and replaying
-- raw_events in (occurred_at, id) order reconstructs current state exactly.
CREATE TABLE raw_events (
  id            BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,  -- ingest arrival order (tiebreak clock only)
  source_id     SMALLINT NOT NULL REFERENCES sources(id),
  external_id   TEXT,                        -- Close opportunity/call id as sent; NULL when source omits it
  event_type    ingest_kind NOT NULL,
  occurred_at   TIMESTAMPTZ,                 -- TRUE event time from payload (Close date_updated). NULL if source
                                             -- cannot supply it -> router falls back to received_at, and
                                             -- occurred_at_estimated is stamped true on the typed row.
  payload       JSONB NOT NULL,              -- verbatim body, never mutated
  dedupe_hash   BYTEA,                        -- sha256(source_id||external_id||event_type||canonical(payload))
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  process_state process_state NOT NULL DEFAULT 'pending',
  process_note  TEXT                          -- reason if quarantined/skipped
);
COMMENT ON TABLE raw_events IS
  'APPEND-ONLY spine. Immutable payload/identity. One event per webhook + one synthetic backfill event per sheet row. Replaying (occurred_at,id) rebuilds any typed table. Idempotency: dedupe_hash unique makes a re-fired identical Zap a no-op.';
COMMENT ON COLUMN raw_events.occurred_at IS
  'Canonical LWW clock (event time), NOT arrival. Upserts order by occurred_at, tiebroken by id. If NULL (source lacks it), typed row is flagged occurred_at_estimated. This resolves the two-specs conflict: id/last_event_id is arrival order and must NOT gate LWW.';

-- Idempotency: an identical re-fired Zap (Zapier retries are common) is a no-op.
CREATE UNIQUE INDEX ux_raw_dedupe    ON raw_events(dedupe_hash) WHERE dedupe_hash IS NOT NULL;
-- Worker pulls the pending queue in arrival order.
CREATE INDEX ix_raw_pending          ON raw_events(process_state, received_at) WHERE process_state = 'pending';
-- Adoption / lineage lookups by Close id.
CREATE INDEX ix_raw_extid            ON raw_events(external_id) WHERE external_id IS NOT NULL;
-- Per-source replay windows.
CREATE INDEX ix_raw_source_time      ON raw_events(source_id, occurred_at);
-- Ad-hoc payload search (audit).
CREATE INDEX ix_raw_payload_gin      ON raw_events USING gin (payload jsonb_path_ops);

-- raw_rows: per-tab VERBATIM landing for the one-time backfill. Mirrors the
-- extract_site.py output shape ({name,cols,data} -> one row per data row).
-- row_index is the ORIGINAL sheet row number == the engine's unit of identity
-- (buildBK counts rows by position). This is where metric-ineligible and
-- quarantined rows live, fully queryable and replayable. Nothing is dropped.
CREATE TABLE raw_rows (
  id                BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id         SMALLINT NOT NULL REFERENCES sources(id),
  tab_name          TEXT NOT NULL,           -- 'Bookings','Leads',... exactly as in the sheet
  row_index         INTEGER NOT NULL,        -- original sheet row number (stable per-row identity)
  cells             JSONB NOT NULL,          -- {colname: value} verbatim, blanks kept as ""
  natural_key       TEXT,                     -- extracted Call ID etc., NULL if absent/unresolved
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  process_state     process_state NOT NULL DEFAULT 'pending',
  quarantine_reason TEXT,                     -- 'no_date_no_key'|'failed_zapier'|'junk_tab'|...
  UNIQUE (source_id, tab_name, row_index)     -- backfill re-run is idempotent by sheet position
);
COMMENT ON TABLE raw_rows IS
  'Verbatim per-tab landing for the one-time backfill. row_index == sheet row == engine identity unit. Good rows project into typed tables; metric-ineligible / junk rows stay here flagged. The count gate asserts COUNT(*) WHERE tab=Bookings == 23385, separate from metric-eligible rows.';
CREATE INDEX ix_rawrows_tab   ON raw_rows(tab_name, process_state);
CREATE INDEX ix_rawrows_key   ON raw_rows(tab_name, natural_key) WHERE natural_key IS NOT NULL;
CREATE INDEX ix_rawrows_gin   ON raw_rows USING gin (cells jsonb_path_ops);

-- quarantine: a POINTER + reason, never a delete. The actual data always still
-- lives in immutable raw_events or in raw_rows. "Fix a mapping and replay"
-- re-runs the router and stamps resolved_at here. This is the audit trail for
-- the 21,713 failed-Zapier rows, the ~9,567 dateless rows, unmapped fields,
-- and ambiguous id merges.
CREATE TABLE quarantine (
  id            BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  origin        TEXT NOT NULL,               -- 'raw_events' | 'raw_rows'
  origin_id     BIGINT NOT NULL,             -- pointer to the held record
  target_table  TEXT,                        -- intended destination if known
  reason_code   TEXT NOT NULL,               -- 'no_date_no_key'|'missing_natural_key'|'failed_zapier'|'junk_tab'
                                             --  |'unmapped_field'|'coercion_fatal'|'dup_ignored'|'id_merge_ambiguous'
                                             --  |'update_ambiguous_no_key'
  detail        TEXT,
  natural_key   TEXT,
  resolved_at   TIMESTAMPTZ,                 -- set when re-routed/replayed
  resolved_by   BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_q_origin CHECK (origin IN ('raw_events','raw_rows'))
);
COMMENT ON TABLE quarantine IS
  'Non-destructive hold: a pointer + reason_code into immutable raw_events/raw_rows. Never a delete. Replay resolves it. Home of the 21,713 failed-Zapier rows and the ~9,567 dateless/keyless Bookings rows.';
CREATE INDEX ix_q_open ON quarantine(reason_code, created_at) WHERE resolved_at IS NULL;

-- =====================================================================
-- 5. TYPED STAR TABLE — bookings
-- =====================================================================
-- The projection the metric engine + grids query. SURROGATE bigint PK (NOT
-- call_id — 98.5% blank). Backfill INSERTS one row per sheet row keyed by
-- (source_id, source_row_index); live events UPSERT only when a proven Close
-- id is present. All 38 sheet columns preserved: the 7 engine-critical ones
-- (+ useful secondaries) are typed; the long tail lives in raw_extra jsonb so
-- the read-only grid loses nothing.
CREATE TABLE bookings (
  -- identity ---------------------------------------------------------
  id                 BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id          SMALLINT REFERENCES sources(id),
  source_row_index   INTEGER,                -- original Bookings sheet row (backfill identity)
  call_id            TEXT,                   -- 'Call ID' — NULLABLE, NON-UNIQUE (blank on 23,031/23,385 rows)
  external_id        TEXT,                   -- proven Close opportunity/lead id from a live payload, when present
  key_source         key_source NOT NULL DEFAULT 'row_position',

  -- engine-critical typed columns (snake_case of the EXACT sheet headers) --
  booking_date                    DATE,      -- 'Booking Date'                       (basis toggle: 'book')
  scheduled_call_date_pst         DATE,      -- 'Scheduled Call Date (PST)'          (basis DEFAULT: 'call')
  lead_owner                      TEXT,      -- 'Lead Owner'  (closer; Person for kind='closer'). STORE TRIMMED.
  attributed_setter_full_name     TEXT,      -- 'Attributed Setter Full Name' (setter). STORE TRIMMED.
  lead_status                     TEXT,      -- 'Lead Status' — drives SHOWN/QSET membership
  total_cash_collected            NUMERIC(14,2) NOT NULL DEFAULT 0,  -- 'Total Cash Collected'; closed == >0; cash == SUM
  total_cash_collected_after_fees NUMERIC(14,2) NOT NULL DEFAULT 0,  -- 'Total Cash Collected after Fees'; afterFees == SUM

  -- useful secondary typed columns (drill-downs / grids; cheap to keep) ---
  call_time_pst                 TEXT,        -- 'Call Time (PST)'
  prospect_name                 TEXT,        -- 'Prospect Name'
  prospect_email                CITEXT,      -- 'Prospect Email' (case-insensitive cross-tab joins)
  phone                         TEXT,        -- 'Phone'
  country                       TEXT,        -- 'Country'
  close_date                    DATE,        -- 'Close Date'
  cash_collected                NUMERIC(14,2),  -- 'Cash Collected' (pre-total)
  first_call_cash_collected     NUMERIC(14,2),  -- 'First Call Cash Collected'
  follow_up_call_cash_collected NUMERIC(14,2),  -- 'Follow Up Call Cash Collected'
  cash_source                   TEXT,        -- 'Cash Source' (Stripe/Whop/SplitIt/Elective/BankTransfer)
  is_second_call                TEXT,        -- '2nd Call?'  (kept as-is; not booleanized)

  -- long tail: ALL 38 columns verbatim so the grid renders identically -----
  raw_extra          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- unmapped headers + __coercion_errors__ array

  -- lineage / audit / conflict-resolution --------------------------------
  occurred_at            TIMESTAMPTZ,        -- TRUE event time of the state currently stored (LWW clock)
  occurred_at_estimated  BOOLEAN NOT NULL DEFAULT false,  -- true for backfill (date@00:00) or occurred_at-less sources
  last_event_id          BIGINT REFERENCES raw_events(id),  -- which event produced current state (lineage, NOT ordering)
  last_event_type        ingest_kind,
  first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- soft lifecycle -------------------------------------------------------
  is_quarantined     BOOLEAN NOT NULL DEFAULT false,  -- excluded from every engine read (see partial indexes)
  is_cancelled       BOOLEAN NOT NULL DEFAULT false,  -- soft-delete: a cancel/delete event lowers the count w/o hard delete

  -- Backfill identity is (source_id, source_row_index): one typed row per
  -- sheet row, so no two distinct Bookings rows can collapse.
  CONSTRAINT ux_bk_rowpos UNIQUE (source_id, source_row_index)
);
COMMENT ON TABLE bookings IS
  'Star table the engine reads. Surrogate PK; call_id nullable/non-unique. Backfill = 1 row per sheet row (ux_bk_rowpos). Live upsert only on a proven Close id. closed is NEVER stored — computed at query time as total_cash_collected>0.';
COMMENT ON COLUMN bookings.call_id IS
  'Close Call ID. MEASURED populated on 354/23,385 rows. NOT a key. A partial-unique index enforces uniqueness only where a real Close opportunity key exists (see ux_bk_external).';
COMMENT ON COLUMN bookings.occurred_at IS
  'LWW clock. Live upserts apply only when EXCLUDED.occurred_at > bookings.occurred_at (tiebreak last_event_id). Never let arrival order (id) win — a replayed old event has a higher id but older occurred_at.';

-- Partial-unique on the real Close key ONLY where one exists and is proven.
-- Backfill rows (external_id NULL) never collide here.
CREATE UNIQUE INDEX ux_bk_external ON bookings(external_id)
    WHERE external_id IS NOT NULL AND key_source IN ('opportunity','call_id');

-- ---- engine-tuned indexes -------------------------------------------
-- aggregate()/series()/statusMix() always filter `dk >= from AND dk <= to`
-- on the basis column, THEN group by person. Leading date column enables a
-- range scan of the window; trailing person column serves the group without a
-- separate sort. Partial WHERE mirrors the engine read predicate (excludes
-- quarantined/cancelled) so those rows never touch a scan and indexes stay lean.
-- Both basis columns get their own pair because the basis toggle (DR.basis) is
-- a first-class product feature and both must be fast.
--
-- NOTE for cold backfill: for speed, create these five index pairs AFTER the
-- initial bulk INSERT of ~23k rows, then run ANALYZE bookings; (see §Migration).
CREATE INDEX ix_bk_call_owner  ON bookings (scheduled_call_date_pst, lead_owner)
    WHERE is_quarantined = false AND is_cancelled = false;   -- default basis + closer
CREATE INDEX ix_bk_call_setter ON bookings (scheduled_call_date_pst, attributed_setter_full_name)
    WHERE is_quarantined = false AND is_cancelled = false;   -- default basis + setter
CREATE INDEX ix_bk_book_owner  ON bookings (booking_date, lead_owner)
    WHERE is_quarantined = false AND is_cancelled = false;   -- toggle basis + closer
CREATE INDEX ix_bk_book_setter ON bookings (booking_date, attributed_setter_full_name)
    WHERE is_quarantined = false AND is_cancelled = false;   -- toggle basis + setter
CREATE INDEX ix_bk_status      ON bookings (lead_status)
    WHERE is_quarantined = false AND is_cancelled = false;   -- status distribution / drift tripwire
CREATE INDEX ix_bk_email       ON bookings (prospect_email);  -- cross-tab joins by email
CREATE INDEX ix_bk_callid      ON bookings (call_id) WHERE call_id IS NOT NULL;  -- lineage lookups on the sparse key

-- =====================================================================
-- 6. THE OTHER 11 TYPED MIRROR TABLES
-- =====================================================================
-- Same pattern, lighter: typed columns only where a dashboard/aggregate needs
-- them; the rest to raw_extra jsonb. Each has a natural_key (or content-hash
-- surrogate) so re-imports are idempotent, plus is_quarantined for engine
-- exclusion and lineage back to raw_events. All headers are the EXACT strings
-- from data/site_data.json.

-- ---- Leads (44,892 rows) — overview lead_sources / new-vs-returning ----
CREATE TABLE leads (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT REFERENCES sources(id),
  source_row_index INTEGER,
  natural_key    TEXT,                       -- Close lead id if present, else content hash (email|date)
  lead_date      DATE,                       -- 'Date'
  opt_in         TEXT,                       -- 'Opt-In'
  lead_name      TEXT,                       -- 'Lead Name'
  lead_email     CITEXT,                     -- 'Lead Email'
  lead_phone     TEXT,                       -- 'Lead Phone'
  lead_brand     TEXT,                       -- 'Lead Brand'
  lead_country   TEXT,                       -- 'Lead Country'
  size           TEXT,                       -- 'Size'
  mql            TEXT,                       -- 'MQL?'  (kept as text Yes/No; not booleanized to avoid coercion loss)
  utm_medium     TEXT,                       -- 'UTM Medium'
  utm_source     TEXT,                       -- 'UTM Source'
  raw_extra      JSONB NOT NULL DEFAULT '{}',
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ux_leads_key UNIQUE (source_id, source_row_index)
);
CREATE INDEX ix_leads_date  ON leads(lead_date) WHERE is_quarantined = false;
CREATE INDEX ix_leads_email ON leads(lead_email);
CREATE INDEX ix_leads_natkey ON leads(natural_key) WHERE natural_key IS NOT NULL;

-- ---- Payments (5,422 rows) — True Rev / fees / package / new-vs-returning.
-- NOTE: first sheet header is BLANK (a date column); mapped to payment_date.
CREATE TABLE payments (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT REFERENCES sources(id),
  source_row_index INTEGER,
  natural_key    TEXT,                       -- content hash (email|date|count) — no stable id in sheet
  payment_date   DATE,                       -- '' (blank header, inferred date)
  payment_email  CITEXT,                     -- 'Payment Email'
  payment_phone  TEXT,                       -- 'Payment Phone' (kept text; it is not money math)
  payment_name   TEXT,                       -- 'Payment Name'
  payment_country TEXT,                      -- 'Payment Country'
  package        TEXT,                       -- 'Package'
  new_returning  TEXT,                       -- 'New / Returning'
  payment_count  NUMERIC(12,2),              -- 'Payment Count'
  closer         TEXT,                       -- 'Closer'
  currency       TEXT,                       -- 'Currency'
  true_rev_usd   NUMERIC(14,2),              -- 'True Rev (USD)'
  non_converted_rev NUMERIC(14,2),           -- 'Non-Converted Rev'
  fees           NUMERIC(14,2),              -- 'Fees'
  raw_extra      JSONB NOT NULL DEFAULT '{}',
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ux_payments_key UNIQUE (source_id, source_row_index)
);
COMMENT ON TABLE payments IS
  'Payments. First sheet column header is blank -> payment_date. LIVE payment events (Stripe/Elective) route HERE, never create bookings rows — split payments already collapse into one bookings.total_cash_collected in the sheet, so summing payment events live would double-count. Booking cash is reconciled from the sheet nightly until a shared key is proven.';
CREATE INDEX ix_pay_date  ON payments(payment_date) WHERE is_quarantined = false;
CREATE INDEX ix_pay_email ON payments(payment_email);
CREATE INDEX ix_pay_closer ON payments(closer) WHERE is_quarantined = false;

-- ---- Refunds (330 rows) ----
CREATE TABLE refunds (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT REFERENCES sources(id),
  source_row_index INTEGER,
  natural_key    TEXT,
  refund_date              DATE,             -- 'Refund Date'
  original_payment_date    DATE,             -- 'Original Payment Date'
  payment_email            CITEXT,           -- 'Payment Email'
  original_payment_count   TEXT,             -- 'Original Payment Count'
  closer                   TEXT,             -- 'Closer'
  amount_refunded          NUMERIC(14,2),    -- 'Amount Refunded'
  original_payment_amount  NUMERIC(14,2),    -- 'Original Payment Amount'
  currency                 TEXT,             -- 'Currency'
  amount_refunded_nonconv  NUMERIC(14,2),    -- 'Amount Refunded (non-converted)'
  original_amount_nonconv  NUMERIC(14,2),    -- 'Original Payment Amount (Non-Converted)'
  notes                    TEXT,             -- 'Notes'
  raw_extra      JSONB NOT NULL DEFAULT '{}',
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ux_refunds_key UNIQUE (source_id, source_row_index)
);
CREATE INDEX ix_ref_date  ON refunds(refund_date) WHERE is_quarantined = false;
CREATE INDEX ix_ref_email ON refunds(payment_email);

-- ---- Residuals (438 rows) ----
CREATE TABLE residuals (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT REFERENCES sources(id),
  source_row_index INTEGER,
  natural_key    TEXT,
  residual_date  DATE,                        -- 'Date'
  email          CITEXT,                      -- 'Email'
  currency       TEXT,                        -- 'Currency'
  amount         NUMERIC(14,2),               -- 'Amount'
  fees           NUMERIC(14,2),               -- 'Fees'
  closer         TEXT,                        -- 'Closer'
  processor      TEXT,                        -- 'Processor'
  raw_extra      JSONB NOT NULL DEFAULT '{}',
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ux_residuals_key UNIQUE (source_id, source_row_index)
);
CREATE INDEX ix_resid_date  ON residuals(residual_date) WHERE is_quarantined = false;
CREATE INDEX ix_resid_email ON residuals(email);

-- ---- Elective Orders Completed (77 rows) ----
CREATE TABLE elective_orders (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT REFERENCES sources(id),
  source_row_index INTEGER,
  natural_key    TEXT,
  original_date_utc        DATE,             -- 'Original Date (UTC)'
  date_in_pst              DATE,             -- 'Date in (PST)'
  name                     TEXT,             -- 'Name'
  email                    CITEXT,           -- 'Email'
  type                     TEXT,             -- 'Type'
  total_amount             NUMERIC(14,2),    -- 'Total Amount'
  total_amount_after_fees  NUMERIC(14,2),    -- 'Total Amount after Fees'
  total_fees               NUMERIC(14,2),    -- 'Total Fees'
  raw_extra      JSONB NOT NULL DEFAULT '{}',
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ux_elective_key UNIQUE (source_id, source_row_index)
);
CREATE INDEX ix_elec_date  ON elective_orders(date_in_pst) WHERE is_quarantined = false;
CREATE INDEX ix_elec_email ON elective_orders(email);

-- ---- Jotform Closer (2,551 rows, 41 cols) — heavy tail -> raw_extra ----
CREATE TABLE jotform_closer (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT REFERENCES sources(id),
  source_row_index INTEGER,
  natural_key    TEXT,
  submission_date   DATE,                     -- 'Submission Date'
  submission_time   TEXT,                     -- 'Submission Time'
  call_booking_date DATE,                     -- 'Call Booking Date'
  closer            TEXT,                     -- 'Closer'
  name              TEXT,                     -- 'Name'
  email             CITEXT,                   -- 'Email'
  mentorship_program TEXT,                    -- 'Mentorship Program'
  country           TEXT,                     -- 'Country'
  showed            TEXT,                     -- 'Showed?'
  call_completed_status TEXT,                 -- 'Call Completed Status'
  cash_collected_amount NUMERIC(14,2),        -- 'Cash Collected Amount'
  raw_extra      JSONB NOT NULL DEFAULT '{}', -- the other ~30 form fields verbatim
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ux_jfc_key UNIQUE (source_id, source_row_index)
);
CREATE INDEX ix_jfc_date  ON jotform_closer(submission_date) WHERE is_quarantined = false;
CREATE INDEX ix_jfc_email ON jotform_closer(email);
CREATE INDEX ix_jfc_closer ON jotform_closer(closer) WHERE is_quarantined = false;

-- ---- Jotform Setter (5,686 rows, 22 cols) ----
CREATE TABLE jotform_setter (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT REFERENCES sources(id),
  source_row_index INTEGER,
  natural_key    TEXT,
  submission_date   DATE,                     -- 'Submission Date'
  submission_time   TEXT,                     -- 'Submission Time'
  name              TEXT,                     -- 'Name'
  email             CITEXT,                   -- 'Email'
  country           TEXT,                     -- 'Country'
  call_booking_date DATE,                     -- 'Call Booking Date'
  status            TEXT,                     -- 'Status ' (note trailing space in sheet header)
  call_completed_status TEXT,                 -- 'Call Completed Status'
  setter            TEXT,                     -- 'Setter'
  raw_extra      JSONB NOT NULL DEFAULT '{}',
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ux_jfs_key UNIQUE (source_id, source_row_index)
);
CREATE INDEX ix_jfs_date   ON jotform_setter(submission_date) WHERE is_quarantined = false;
CREATE INDEX ix_jfs_email  ON jotform_setter(email);
CREATE INDEX ix_jfs_setter ON jotform_setter(setter) WHERE is_quarantined = false;

-- ---- Call Dashboard (603 rows) — setter call-volume/duration ----
CREATE TABLE call_dashboard (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT REFERENCES sources(id),
  source_row_index INTEGER,
  natural_key    TEXT,
  date_start                DATE,             -- 'Date Start'
  date_end                  DATE,             -- 'Date End'
  setter_name               TEXT,             -- 'Setter Name'
  all_calls_all_types       NUMERIC(12,2),    -- 'All Calls All Types'
  all_calls_total_seconds   NUMERIC(14,2),    -- 'All Calls Total Duration (Seconds)'
  all_calls_total_formatted TEXT,             -- 'All Calls Total Duration Formatted'
  run_date_utc              DATE,             -- 'Run Date UTC'
  run_time_utc              TEXT,             -- 'Run Time UTC'
  raw_extra      JSONB NOT NULL DEFAULT '{}',
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ux_calldash_key UNIQUE (source_id, source_row_index)
);
CREATE INDEX ix_calldash_start  ON call_dashboard(date_start) WHERE is_quarantined = false;
CREATE INDEX ix_calldash_setter ON call_dashboard(setter_name) WHERE is_quarantined = false;

-- ---- Leads Over Time (160 rows) — daily lead/booking trend.
-- NOTE: the sheet's LAST "column" is four tab-mashed headers in one cell
-- ('Total Leads\tTotal Bookings\tTotal Leads (7d avg)\tTotal Bookings (7d avg)').
-- Kept verbatim in raw_extra under its literal key; the four typed columns
-- below are populated by SPLITTING that cell in the router (transform='tab_split').
CREATE TABLE leads_over_time (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT REFERENCES sources(id),
  source_row_index INTEGER,
  natural_key    TEXT,
  lot_date               DATE,               -- 'Date'
  leads_apply_form       NUMERIC(12,2),      -- 'Leads (Apply-Form)'
  leads_ai_funnel        NUMERIC(12,2),      -- 'Leads (AI-Funnel)'
  calls_booked_apply_form NUMERIC(12,2),     -- 'Calls Booked (Apply-Form)'
  calls_booked_ai_funnel  NUMERIC(12,2),     -- 'Calls Booked (AI-Funnel)'
  leads_af_7d_avg        NUMERIC(12,4),      -- 'Leads AF (7d avg)'
  leads_ai_7d_avg        NUMERIC(12,4),      -- 'Leads AI (7d avg)'
  calls_af_7d_avg        NUMERIC(12,4),      -- 'Calls AF (7d avg)'
  calls_ai_7d_avg        NUMERIC(12,4),      -- 'Calls AI (7d avg)'
  total_leads            NUMERIC(12,2),      -- split from the tab-mashed last cell
  total_bookings         NUMERIC(12,2),      --   "
  total_leads_7d_avg     NUMERIC(12,4),      --   "
  total_bookings_7d_avg  NUMERIC(12,4),      --   "
  raw_extra      JSONB NOT NULL DEFAULT '{}',
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ux_lot_key UNIQUE (source_id, source_row_index)
);
CREATE INDEX ix_lot_date ON leads_over_time(lot_date) WHERE is_quarantined = false;

-- ---- HUB - Closers (10 rows) — REFERENCE / ASSERTION INPUT ONLY ----
-- Stored so the nightly sweep can assert engine(month) == hub the way tune.py
-- does. NOT a source of dashboard truth — the engine DERIVES these numbers
-- from bookings. Messy headers (leading-space dups, the ⭐ column, #REF!
-- cells, the '(COLUMN Z - BOOKINGS TAB)' variants) go straight to raw_extra
-- untouched; only assertion-needed columns are typed.
CREATE TABLE hub_closers (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT REFERENCES sources(id),
  source_row_index INTEGER,
  closer                   TEXT,             -- 'Closer'
  total_bookings           NUMERIC(12,2),    -- 'Total Bookings'
  qualified_showed_calls   NUMERIC(12,2),    -- ' Qualified Showed Calls' (leading space in sheet)
  showed_calls             NUMERIC(12,2),    -- 'Showed Calls'
  dmpn_close_deals         NUMERIC(12,2),    -- 'DMPN Close Deals'
  dma_close_deals          NUMERIC(12,2),    -- 'DMA Close Deals'
  total_cash_collected     NUMERIC(14,2),    -- ' Total Cash Collected' (leading space in sheet)
  total_cash_after_fees    NUMERIC(14,2),    -- 'Total Cash Collected After Fees'
  raw_extra      JSONB NOT NULL DEFAULT '{}', -- all other 26 HUB columns verbatim, incl. ⭐ / #REF! cells
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ux_hubc_key UNIQUE (source_id, source_row_index)
);
COMMENT ON TABLE hub_closers IS
  'HUB closer scorecards. REFERENCE/ASSERTION ONLY (not dashboard truth — engine derives these from bookings). Reconciliation oracle for the nightly sweep: June 2026 team cash = 455674.90; Sam Aujla shown 50 / qual 43 / closed 27.';

-- ---- HUB - Setters (8 rows) — REFERENCE / ASSERTION INPUT ONLY ----
CREATE TABLE hub_setters (
  id             BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  source_id      SMALLINT REFERENCES sources(id),
  source_row_index INTEGER,
  setters                    TEXT,           -- 'Setters'
  total_bookings             NUMERIC(12,2),  -- 'Total Bookings'
  setter_qualified_bookings  NUMERIC(12,2),  -- 'Setter Qualified Bookings'
  showed_calls               NUMERIC(12,2),  -- 'Showed Calls'
  qualified_showed_by_closer NUMERIC(12,2),  -- 'Qualified Showed Call By Closer'
  closed_sets                NUMERIC(12,2),  -- 'Closed Sets'
  new_cash_collected         NUMERIC(14,2),  -- 'New Cash Collected'
  new_cash_after_fees        NUMERIC(14,2),  -- 'New Cash Collected After Fees'
  raw_extra      JSONB NOT NULL DEFAULT '{}',
  last_event_id  BIGINT REFERENCES raw_events(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_quarantined BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT ux_hubs_key UNIQUE (source_id, source_row_index)
);
COMMENT ON TABLE hub_setters IS
  'HUB setter scorecards. REFERENCE/ASSERTION ONLY. Note: a name legitimately appears as BOTH a Lead Owner (closer) and an Attributed Setter — role is per-ROW (which column the name is in), never a person attribute. No people/role table is created; that would break the 8 dual-role humans.';

-- =====================================================================
-- 7. RECONCILIATION SWEEP RECORD
-- =====================================================================
-- The nightly sheet-diff + HUB assertion (tune.py promoted to a scheduled job)
-- records durable results here. A failed run is a data-integrity ALARM, not a
-- silent drift. Reschedule handling: because a booking's scheduled_call_date is
-- MUTABLE (reschedules move a call across a month boundary), a CLOSED month is
-- asserted against its FROZEN snapshot stored in `actual`, not against a live
-- recompute over mutable rows — otherwise a June-to-July reschedule would turn
-- a previously-green June assertion red with no code change.
CREATE TABLE reconciliation_runs (
  id            BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  scope         TEXT NOT NULL,               -- 'hub_june_closers'|'sheet_diff_bookings'|'status_drift'|'cash_split_check'
  period        TEXT,                        -- e.g. '2026-06' for a month-close snapshot
  is_frozen     BOOLEAN NOT NULL DEFAULT false,  -- true once a closed month's snapshot is locked
  passed        BOOLEAN NOT NULL,
  expected      JSONB,                       -- {"closer_cash":455674.9,"Sam Aujla":{"shown":50,"qual":43,"closed":27}}
  actual        JSONB,                       -- the computed figures (and the frozen snapshot when is_frozen)
  diff          JSONB,
  note          TEXT
);
COMMENT ON TABLE reconciliation_runs IS
  'Durable record of the nightly HUB assertion + sheet diff. Month-close snapshots (is_frozen) are the immutable reference a closed month is re-asserted against, so mutable reschedules cannot retroactively fail a closed period.';
CREATE INDEX ix_recon_scope ON reconciliation_runs(scope, run_at DESC);
CREATE INDEX ix_recon_frozen ON reconciliation_runs(period) WHERE is_frozen;

-- external_id_aliases: every Close id a booking was ever seen under. Handles
-- Close lead/opportunity MERGES (surviving id changes; a post-merge UPDATE
-- arriving under a new id would otherwise create a duplicate booking). On a new
-- event whose id doesn't match but whose content (email+scheduled date+owner)
-- matches an existing booking, LINK the alias rather than insert. Truly
-- ambiguous id changes route to quarantine('id_merge_ambiguous'), never
-- auto-merge two cash-bearing rows.
CREATE TABLE external_id_aliases (
  id            BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  booking_id    BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL,
  source        TEXT,                        -- which system/source supplied this id
  seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (external_id)                        -- one live id maps to exactly one booking
);
COMMENT ON TABLE external_id_aliases IS
  'Alias map so a Close merge (id changes) does not spawn a duplicate booking. A new event under a new id but matching content links here instead of inserting.';
CREATE INDEX ix_alias_booking ON external_id_aliases(booking_id);

-- =====================================================================
-- 8. PHASE-2 STUBS — schema-reserved, NOT created in v1
-- =====================================================================
-- Intentionally NOT built. Documented so v1 does not paint us into a corner;
-- both slot into the existing generic ingest/mapping machinery with ZERO
-- changes to typed tables (the test that v1's data model is genuinely
-- extensible):
--   * Custom form builder  -> forms submit to the same POST /ingest with a
--       sources row system='form_builder'; a forms / form_submissions pair
--       would be added then. No typed-table change needed — new sources +
--       source_field_mappings rows suffice.
--   * Outbound write-back  -> an outbound_events(id, target_hook_url, payload,
--       status, attempts, ...) table would be added; our app POSTs to a Zapier
--       Catch-Hook that fans out to tools. raw_events already provides the
--       trigger source.

COMMIT;

-- =====================================================================
-- 9. ROLES & GRANTS — append-only + read-only enforcement (run once)
-- =====================================================================
-- Two DB roles enforce the platform's guarantees at the engine level, not just
-- in app code:
--   * app_reader  — request handlers. SELECT only on typed tables + catalog.
--                   Cannot write anything; read-only dashboards are enforced by
--                   the grant, not merely by role='viewer' checks.
--   * app_writer  — the ingest worker. INSERT into raw_events/raw_rows and the
--                   typed tables, but NO UPDATE/DELETE on raw_events (payload &
--                   identity immutable). It flips process_state ONLY via the
--                   mark_event_processed() SECURITY DEFINER function below.
--
-- Wrap in DO blocks so re-running the file does not error if roles pre-exist.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_reader') THEN
    CREATE ROLE app_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_writer') THEN
    CREATE ROLE app_writer NOLOGIN;
  END IF;
END $$;

-- app_reader: read-only across typed tables + config the UI needs.
GRANT SELECT ON bookings, leads, payments, refunds, residuals, elective_orders,
               jotform_closer, jotform_setter, call_dashboard, leads_over_time,
               hub_closers, hub_setters,
               tab_catalog, lead_status_classes, sources, users,
               reconciliation_runs
  TO app_reader;

-- app_writer: full write on typed + raw_rows; INSERT-only on raw_events; may
-- resolve quarantine + record recon runs. Explicitly REVOKE mutation of the
-- append-only spine.
GRANT SELECT, INSERT, UPDATE ON bookings, leads, payments, refunds, residuals,
               elective_orders, jotform_closer, jotform_setter, call_dashboard,
               leads_over_time, hub_closers, hub_setters,
               raw_rows, quarantine, reconciliation_runs, external_id_aliases,
               source_field_mappings
  TO app_writer;
GRANT INSERT ON raw_events TO app_writer;                 -- append only
REVOKE UPDATE, DELETE, TRUNCATE ON raw_events FROM app_writer;  -- payload/identity immutable
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_writer;

-- Narrow, audited way to flip a raw_event's outcome without touching identity/
-- payload. This is the ONLY sanctioned mutation of raw_events, and it can only
-- move the mutable lifecycle fields.
CREATE OR REPLACE FUNCTION mark_event_processed(p_id BIGINT, p_state process_state, p_note TEXT)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE raw_events
     SET process_state = p_state,
         processed_at  = now(),
         process_note  = COALESCE(p_note, process_note)
   WHERE id = p_id;
$$;
COMMENT ON FUNCTION mark_event_processed IS
  'ONLY sanctioned mutation of the append-only raw_events: flips process_state/processed_at/process_note. SECURITY DEFINER so app_writer (which lacks UPDATE on raw_events) can record an outcome without being able to alter payload or identity.';
REVOKE ALL ON FUNCTION mark_event_processed(BIGINT, process_state, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_event_processed(BIGINT, process_state, TEXT) TO app_writer;

-- =====================================================================
-- 10. THE BOOKINGS LIVE UPSERT (reference — executed by the ingest worker)
-- =====================================================================
-- Backfill does NOT use this: backfill INSERTs one row per sheet row
-- (ON CONFLICT (source_id, source_row_index) DO NOTHING for idempotent
-- re-runs). This upsert is the LIVE path, applied ONLY to rows carrying a
-- proven Close id (external_id). It orders strictly by occurred_at (event
-- time), tiebroken by last_event_id, so a replayed/late/out-of-order event
-- never regresses newer state. The old `last_event_id >` guard (arrival order)
-- is intentionally NOT used — arrival order is the wrong clock.
--
--   INSERT INTO bookings (external_id, key_source, call_id, booking_date,
--       scheduled_call_date_pst, lead_owner, attributed_setter_full_name,
--       lead_status, total_cash_collected, total_cash_collected_after_fees,
--       raw_extra, source_id, occurred_at, occurred_at_estimated,
--       last_event_id, last_event_type)
--   VALUES ($1,'opportunity',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
--   ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
--       booking_date                    = EXCLUDED.booking_date,
--       scheduled_call_date_pst         = EXCLUDED.scheduled_call_date_pst,
--       lead_owner                      = EXCLUDED.lead_owner,
--       attributed_setter_full_name     = EXCLUDED.attributed_setter_full_name,
--       lead_status                     = EXCLUDED.lead_status,
--       total_cash_collected            = EXCLUDED.total_cash_collected,
--       total_cash_collected_after_fees = EXCLUDED.total_cash_collected_after_fees,
--       raw_extra   = bookings.raw_extra || EXCLUDED.raw_extra,  -- merge; keep prior unmapped fields
--       occurred_at = EXCLUDED.occurred_at,
--       last_event_id = EXCLUDED.last_event_id,
--       last_event_type = EXCLUDED.last_event_type,
--       updated_at = now()
--   WHERE EXCLUDED.occurred_at IS NOT NULL
--     AND (bookings.occurred_at IS NULL
--          OR EXCLUDED.occurred_at > bookings.occurred_at
--          OR (EXCLUDED.occurred_at = bookings.occurred_at
--              AND EXCLUDED.last_event_id > bookings.last_event_id));
--
-- If occurred_at is unavailable from the payload (confirm from Zap export),
-- whole-row LWW is unsafe; the worker must NOT regress total_cash_collected
-- downward without an explicit refund/delete event_type.

-- =====================================================================
-- 11. MIGRATION / OPERATIONAL NOTES
-- =====================================================================
-- 1) Apply this file (extensions -> enums -> config/auth -> raw spine ->
--    typed tables). Seed: sources (one per kept tab + one per wired Zap),
--    lead_status_classes (from template 157-158), tab_catalog (from
--    extract_site.py cols/types), source_field_mappings (Bookings seed maps
--    the 7 engine columns + 31 tail columns).
-- 2) COLD BACKFILL SPEED: optionally drop the five ix_bk_* index pairs before
--    the bulk INSERT of ~23k Bookings rows, recreate them after, then:
--        ANALYZE bookings;
--    (For a 23k-row table the difference is small; matters more if history
--    grows via replay.)
-- 3) BACKFILL PROCEDURE:
--    a. Stage all 12 kept tabs into raw_rows (verbatim, blanks kept),
--       row_index = sheet row. Junk tabs are excluded (no active source).
--    b. Route Bookings 1:1 into bookings by (source_id, source_row_index).
--       Metric-INELIGIBLE rows (no parseable date in EITHER date column) are
--       NOT projected; they stay in raw_rows with quarantine_reason
--       'no_date_no_key'. Cell-level broken formulas (#REF!/#N/A/#DIV/0!/
--       #VALUE!) do NOT quarantine a row: coerce to 0/NULL, preserve the
--       original string in raw_extra, and list affected columns in
--       raw_extra.__coercion_errors__.
--    c. GO-LIVE GATE (two independent checks):
--         - raw_rows COUNT(*) WHERE tab_name='Bookings' == 23385   (verbatim landing)
--         - Run the ported engine for 2026-06 against bookings and assert it
--           EQUALS the HUB: team closer cash == 455674.90, Sam Aujla shown 50
--           / qual 43 / closed 27 / close 62.79%. Assert PER-CLOSER, not just a
--           total — a total can pass even if a merge silently moved rows.
--       The HUB assertion is the real gate; the row count is advisory.
-- 4) LIVE CUTOVER (T0 = the UTC instant the parallel webhook action goes live
--    on the Zaps): backfill reads the sheet snapshot as of T0. Live events
--    carry occurred_at >= T0. Backfill/live overlap is de-duplicated by an
--    ADOPTION step (end-of-backfill + nightly), NOT by key equality — backfill
--    rows are key_source='row_position', live rows are 'opportunity', so they
--    do not share a key. When a live 'opportunity' event content-matches a
--    'row_position' booking (scheduled_call_date + lead_owner + prospect_email
--    + cash/status consistent), adopt: set external_id, key_source
--    ='content_link', record the alias, keep the newer occurred_at state.
--    Ambiguous matches -> quarantine('update_ambiguous_no_key').
-- 5) NIGHTLY SWEEP: sheet-diff + HUB assertion into reconciliation_runs. On a
--    'in sheet, not in DB' row, DO re-insert as a missed webhook UNLESS a later
--    delete/cancel event tombstoned the key (skip it, to stop the resurrection
--    oscillation). NEVER overwrite a row whose occurred_at_estimated=false with
--    sheet-derived (estimated) data. Assert DISTINCT bookings.lead_status is a
--    subset of lead_status_classes and alert on any new value (status drift can
--    break shown/qual without failing the cash assertion).
--
-- OPEN CONFIRMATIONS FROM ARTIFACTS NOT YET AVAILABLE (block the live upsert,
-- not the backfill):
--   (1) Which Zaps carry a stable Close opportunity/call id in the payload
--       (the sheet has NO id column populated on 98.5% of rows; the live key
--       can ONLY come from the payload). Until confirmed, there is no idempotent
--       LIVE upsert key and the model is append + nightly-sweep.
--   (2) Whether the payload exposes a true event timestamp (Close date_updated)
--       for occurred_at. If not, out-of-order delivery is unresolvable by clock
--       and cash must never regress without an explicit refund/delete event.
-- =====================================================================