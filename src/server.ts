import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { env } from './config/env'
import { createSnapshotSource } from './data/snapshotSource'
import { registerApi } from './api/routes'

const app = Fastify({ logger: true })
const source = createSnapshotSource(env.DATA_DIR)
registerApi(app, source)
// Serve the ported prototype UI (src/web/index.html) at the root.
app.register(fastifyStatic, { root: join(dirname(fileURLToPath(import.meta.url)), 'web'), prefix: '/' })

app.listen({ port: env.PORT, host: env.HOST })
  .catch((err) => { app.log.error(err); process.exit(1) })
