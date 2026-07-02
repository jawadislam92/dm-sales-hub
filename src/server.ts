import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { env } from './config/env'
import { createSnapshotSource } from './data/snapshotSource'
import { createPgSource } from './data/pgSource'
import { getDb } from './db/pglite'
import { registerApi } from './api/routes'
import type { DataSource } from './data/source'

const app = Fastify({ logger: true })

// DATA_BACKEND=pg reads from the database (run the backfill first). Default is the
// snapshot, which works with zero setup — that's what the launcher uses.
const backend = process.env.DATA_BACKEND ?? 'snapshot'
let source: DataSource
if (backend === 'pg') {
  source = await createPgSource(await getDb(process.env.PGDATA_DIR ?? './.pgdata'))
  app.log.info('data backend: postgres (pglite)')
} else {
  source = createSnapshotSource(env.DATA_DIR)
  app.log.info('data backend: snapshot')
}

registerApi(app, source)
// Serve the ported prototype UI (src/web/index.html) at the root.
app.register(fastifyStatic, { root: join(dirname(fileURLToPath(import.meta.url)), 'web'), prefix: '/' })

await app.listen({ port: env.PORT, host: env.HOST })
