-- Normalized bookings replicated live from Close (leads that booked a call).
-- Keyed on the Close lead id (stable) so re-pulls update in place.
CREATE TABLE IF NOT EXISTS close_bookings (
  lead_id text PRIMARY KEY,
  status text,
  program text,
  scheduled_date text,   -- 10-char YYYY-MM-DD parsed from "Meeting Date and Time"
  closer text,
  prospect text,
  country text,
  date_created text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS close_bookings_closer_idx ON close_bookings(closer);
CREATE INDEX IF NOT EXISTS close_bookings_sched_idx ON close_bookings(scheduled_date);

-- Generic resumable-job progress (survives restart: the job resumes from cursor).
CREATE TABLE IF NOT EXISTS jobs (
  name text PRIMARY KEY,
  state text NOT NULL DEFAULT 'idle',   -- idle | running | done | error
  cursor integer NOT NULL DEFAULT 0,    -- _skip position, for resume
  processed integer NOT NULL DEFAULT 0,
  kept integer NOT NULL DEFAULT 0,
  message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
