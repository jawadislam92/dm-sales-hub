// Minimal env for the interim snapshot-backed server. The full zod-validated
// config (DB DSN, secrets, HUB assert pins, SMTP, S3…) lands with the Docker/
// config task; keep this narrow until then.
export const env = {
  PORT: Number(process.env.PORT ?? 8080),
  HOST: process.env.HOST ?? '127.0.0.1',
  // Interim data source = the prototype snapshot. Replaced by Postgres later.
  DATA_DIR: process.env.DATA_DIR ?? 'C:/Users/jawad/Downloads/Pavan/dashboard-build/data',
}
