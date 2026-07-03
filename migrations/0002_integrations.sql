-- Integrations: how a data source connects. Two kinds:
--   webhook  = the tool pushes to /ingest (we hand out a URL + secret)
--   api_poll = we pull from an API on a schedule (store base_url/path/auth/interval)
-- Credentials live in `secret` (api key/token) or config.auth.token. Plaintext on
-- PGlite/local; in prod use an encrypted column / secret manager (noted in .env.example).
CREATE TABLE IF NOT EXISTS integrations (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL,                 -- 'webhook' | 'api_poll'
  source_key text NOT NULL,           -- ties captured events to sources/mappings
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}', -- api_poll: {base_url, path, method, auth:{type,header,token}, result_path, headers}
  secret text,                        -- webhook: incoming shared secret; api_poll: token (if not in config)
  interval_seconds integer,           -- api_poll cadence
  last_run_at timestamptz,
  last_status text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integrations_due_idx ON integrations(enabled, kind);
