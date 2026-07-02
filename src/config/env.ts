import { z } from 'zod'

// Validate-once config. Core server settings are parsed + validated here and the
// process crashes loud on bad input. Runtime feature flags read at request time
// (AUTH_ENABLED, AUTH_DEV, WEBHOOK_SHARED_SECRET, SESSION_SECRET, SMTP_URL) stay in
// their own modules so they can be toggled without a reboot / for tests.
const Env = z.object({
  HOST: z.string().default('127.0.0.1'),
  DATA_DIR: z.string().default('C:/Users/jawad/Downloads/Pavan/dashboard-build/data'),
  DATA_BACKEND: z.enum(['snapshot', 'pg']).default('snapshot'),
  PGDATA_DIR: z.string().default('./.pgdata'),
  ALLOWLIST_BOOTSTRAP: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8080),
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

// Port precedence: PORT env > CLI arg (used by the preview launcher) > default.
const argvPort = Number(process.argv[2])
const port = process.env.PORT
  ? parsed.data.PORT
  : (Number.isFinite(argvPort) && argvPort > 0 ? argvPort : parsed.data.PORT)

export const env = { ...parsed.data, PORT: port }
