import Fastify from 'fastify'
import { env } from './config/env'
import { createSnapshotSource } from './data/snapshotSource'
import { registerApi } from './api/routes'

const app = Fastify({ logger: true })
const source = createSnapshotSource(env.DATA_DIR)
registerApi(app, source)

app.listen({ port: env.PORT, host: env.HOST })
  .catch((err) => { app.log.error(err); process.exit(1) })
