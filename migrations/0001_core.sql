-- Core runnable schema (valid on PGlite for local dev AND real Postgres for prod).
-- Prod-only concerns (SELECT-only app role, WAL/backup) live in a separate deploy
-- step, not here, so the same migrations run everywhere. db/schema.sql holds the
-- fuller design reference; this is the subset the app actually runs against.

CREATE TABLE IF NOT EXISTS sources (
  id bigserial PRIMARY KEY,
  key text UNIQUE NOT NULL,
  label text,
  natural_key_field text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_field_mappings (
  id bigserial PRIMARY KEY,
  source_key text NOT NULL,
  incoming_field text NOT NULL,
  target_column text NOT NULL,
  coercer text,
  active_from timestamptz NOT NULL DEFAULT now(),
  active_to timestamptz
);

CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY,
  email text UNIQUE NOT NULL,
  role text NOT NULL DEFAULT 'viewer',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only spine. Every inbound webhook lands here verbatim before any mapping,
-- so a field we didn't map today can be re-mapped and replayed tomorrow.
CREATE TABLE IF NOT EXISTS raw_events (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  external_id text,
  event_type text NOT NULL,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  dedupe_hash text,
  payload jsonb NOT NULL,
  process_state text NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS raw_events_source_idx ON raw_events(source, received_at);
CREATE UNIQUE INDEX IF NOT EXISTS raw_events_dedupe_idx ON raw_events(dedupe_hash) WHERE dedupe_hash IS NOT NULL;

-- Verbatim landing of the sheet tabs, for the raw-data grids.
CREATE TABLE IF NOT EXISTS tab_catalog (
  name text PRIMARY KEY,
  cols jsonb NOT NULL,
  types jsonb NOT NULL,
  n integer NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tab_rows (
  tab text NOT NULL,
  row_index integer NOT NULL,
  cells jsonb NOT NULL,
  PRIMARY KEY (tab, row_index)
);

-- Typed, ROW-FAITHFUL Bookings — the engine's input. Surrogate PK; backfill inserts
-- 1:1 by sheet row position; NEVER upsert/merge (Call ID is on only 1.5% of rows and
-- the "natural key" collides on ~9,900 distinct rows — see PLAN.md correction).
-- Dates stored as 10-char TEXT so no timezone round-trip can shift a June call to July.
CREATE TABLE IF NOT EXISTS bookings (
  id bigserial PRIMARY KEY,
  source_row_index integer,
  scheduled_call_date text,
  booking_date text,
  lead_owner text,
  attributed_setter text,
  lead_status text,
  cash double precision NOT NULL DEFAULT 0,
  fees double precision NOT NULL DEFAULT 0,
  external_id text,
  occurred_at timestamptz,
  is_quarantined boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookings_call_owner_idx ON bookings(scheduled_call_date, lead_owner) WHERE is_quarantined = false;
CREATE INDEX IF NOT EXISTS bookings_call_setter_idx ON bookings(scheduled_call_date, attributed_setter) WHERE is_quarantined = false;
CREATE INDEX IF NOT EXISTS bookings_book_owner_idx ON bookings(booking_date, lead_owner) WHERE is_quarantined = false;

-- Precomputed all-time overview context the dashboards show.
CREATE TABLE IF NOT EXISTS overview_extra (
  id integer PRIMARY KEY DEFAULT 1,
  new_returning jsonb NOT NULL DEFAULT '{}',
  lead_sources jsonb NOT NULL DEFAULT '[]'
);
