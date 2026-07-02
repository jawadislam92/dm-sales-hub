import { describe, it, expect, beforeAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { runMigrations } from '../src/db/pglite'
import { registerIngest } from '../src/ingest/route'

describe('/ingest — the Phase-2 inbox (append-only, idempotent)', () => {
  let app: FastifyInstance
  let db: PGlite
  beforeAll(async () => {
    db = await PGlite.create()
    await runMigrations(db)
    app = Fastify()
    registerIngest(app, db)
    await app.ready()
  })

  it('accepts a well-formed event (202) and appends it to raw_events', async () => {
    const r = await app.inject({
      method: 'POST', url: '/ingest',
      payload: { source: 'close_booking', external_id: 'opp_1', event_type: 'create', payload: { lead_status: 'Closed', cash: 5000 } },
    })
    expect(r.statusCode).toBe(202)
    expect(JSON.parse(r.body).ok).toBe(true)
    const n = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM raw_events')).rows[0].n
    expect(n).toBe(1)
  })

  it('is idempotent — the same event twice does not double-store', async () => {
    const ev = { source: 's', external_id: 'x', event_type: 'create', payload: { a: 1 } }
    const a = await app.inject({ method: 'POST', url: '/ingest', payload: ev })
    const b = await app.inject({ method: 'POST', url: '/ingest', payload: ev })
    expect(a.statusCode).toBe(202)
    expect(JSON.parse(a.body).duplicate ?? false).toBe(false)
    expect(JSON.parse(b.body).duplicate).toBe(true)
  })

  it('rejects a malformed event (400)', async () => {
    const r = await app.inject({ method: 'POST', url: '/ingest', payload: { source: 's' } })
    expect(r.statusCode).toBe(400)
  })
})
