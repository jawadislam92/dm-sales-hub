import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { runMigrations } from '../src/db/pglite'
import { createIntegration, runIntegration, listIntegrations } from '../src/integrations/service'

describe('integrations backend (API poll + webhook)', () => {
  let db: PGlite
  let fake: FastifyInstance
  let base: string

  beforeAll(async () => {
    db = await PGlite.create()
    await runMigrations(db)
    fake = Fastify()
    fake.get('/opportunities', async () => ({ data: [{ id: 'a', cash: 1 }, { id: 'b', cash: 2 }] }))
    await fake.listen({ port: 0, host: '127.0.0.1' })
    const addr = fake.server.address()
    base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
  })
  afterAll(async () => { await fake.close() })

  it('polls an API endpoint and stores events, idempotently', async () => {
    const { id } = await createIntegration(db, {
      name: 'Fake Close', kind: 'api_poll', source_key: 'close_opps', enabled: true, interval_seconds: 60,
      config: { base_url: base, path: '/opportunities', result_path: 'data', auth: { type: 'none' } },
    })
    const r1 = await runIntegration(db, id)
    expect(r1.fetched).toBe(2)
    expect(r1.stored).toBe(2)

    const r2 = await runIntegration(db, id) // same data again -> deduped
    expect(r2.stored).toBe(0)

    const n = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM raw_events')).rows[0].n
    expect(n).toBe(2)
  })

  it('never exposes stored credentials in the list', async () => {
    await createIntegration(db, {
      name: 'Secret', kind: 'api_poll', source_key: 'x',
      config: { base_url: 'http://x', auth: { type: 'bearer', token: 'super-secret-token' } },
    })
    const dump = JSON.stringify(await listIntegrations(db))
    expect(dump).not.toContain('super-secret-token')
  })

  it('a webhook integration returns a generated secret to hand to the tool', async () => {
    const res = await createIntegration(db, { name: 'Zap hook', kind: 'webhook', source_key: 'zap1' })
    expect(typeof res.secret).toBe('string')
    expect((res.secret as string).length).toBeGreaterThan(10)
  })
})
