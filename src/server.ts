import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { env } from './config/env'
import { createSnapshotSource } from './data/snapshotSource'
import { createPgSource } from './data/pgSource'
import { getDb } from './db/pglite'
import cookie from '@fastify/cookie'
import { registerApi } from './api/routes'
import { registerIngest } from './ingest/route'
import { registerAuth } from './auth/routes'
import { registerAdmin } from './admin/routes'
import { registerIntegrations } from './integrations/routes'
import { registerReconcile } from './reconcile/closeRecon'
import { startScheduler } from './integrations/scheduler'
import { bootstrapAdmins } from './auth/allowlist'
import type { DataSource } from './data/source'

const app = Fastify({ logger: true })

// DATA_BACKEND=pg reads from the database (run the backfill first). Default is the
// snapshot, which works with zero setup — that's what the launcher uses.
// The DB is always open (for /ingest, users, admin), independent of which backend
// the read side uses.
const db = await getDb(env.PGDATA_DIR)

// Login (email allow-list + magic link). Off unless AUTH_ENABLED=1, so local review
// needs no login; when enabled the guard (registered here, before the routes) gates
// everything except health, the webhook and /auth/*.
await app.register(cookie)
if (env.ALLOWLIST_BOOTSTRAP) await bootstrapAdmins(db, env.ALLOWLIST_BOOTSTRAP.split(','))
registerAuth(app, db)

const backend = env.DATA_BACKEND
let source: DataSource
if (backend === 'pg') {
  source = await createPgSource(db)
  app.log.info('data backend: postgres (pglite)')
} else {
  source = createSnapshotSource(env.DATA_DIR)
  app.log.info('data backend: snapshot')
}

registerApi(app, source)
registerIngest(app, db)
registerAdmin(app, db)
registerIntegrations(app, db)
registerReconcile(app, db, source)
// Serve the ported prototype UI (src/web/index.html) at the root.
app.register(fastifyStatic, { root: join(dirname(fileURLToPath(import.meta.url)), 'web'), prefix: '/' })

// Pull scheduled API integrations on their interval.
startScheduler(db, 30, (m) => app.log.info(m))

await app.listen({ port: env.PORT, host: env.HOST })
