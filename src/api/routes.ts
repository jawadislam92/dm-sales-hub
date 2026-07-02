import type { FastifyInstance } from 'fastify'
import type { DataSource } from '../data/source'
import { aggregate, series, statusMix } from '../engine/metrics'

type Kind = 'closer' | 'setter'
type Basis = 'call' | 'book'
const asKind = (v: unknown): Kind => (v === 'setter' ? 'setter' : 'closer')
const asBasis = (v: unknown): Basis => (v === 'book' ? 'book' : 'call')

// Read-only API. All dashboard numbers are computed server-side by the ported,
// HUB-guarded engine over the DataSource — one engine, one source of truth.
export function registerApi(app: FastifyInstance, source: DataSource): void {
  app.get('/healthz', async () => ({ ok: true, bookings: source.getBK().length }))

  app.get('/api/aggregate', async (req) => {
    const q = req.query as Record<string, string>
    return aggregate(source.getBK(), asKind(q.kind), q.from, q.to, asBasis(q.basis))
  })

  app.get('/api/series', async (req) => {
    const q = req.query as Record<string, string>
    return series(source.getBK(), asKind(q.kind), q.name || null, q.from, q.to, asBasis(q.basis))
  })

  app.get('/api/statusmix', async (req) => {
    const q = req.query as Record<string, string>
    return statusMix(source.getBK(), asKind(q.kind), q.name, q.from, q.to, asBasis(q.basis))
  })

  app.get('/api/overview', async () => source.overviewExtra())

  // Raw flattened Bookings records — the frontend runs the (identical) engine
  // over these so the hosted dashboards render exactly like the prototype.
  app.get('/api/bk', async () => source.getBK())

  app.get('/api/tabs', async () => source.listTabs())

  app.get('/api/tabs/:name', async (req, reply) => {
    const { name } = req.params as { name: string }
    const q = req.query as Record<string, string>
    const offset = Math.max(0, parseInt(q.offset ?? '0', 10) || 0)
    const limit = Math.min(100000, Math.max(1, parseInt(q.limit ?? '100', 10) || 100))
    const page = source.tabPage(name, offset, limit)
    if (!page) return reply.code(404).send({ error: 'unknown tab: ' + name })
    return page
  })
}
