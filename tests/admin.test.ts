import { describe, it, expect, beforeAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { runMigrations } from '../src/db/pglite'
import { registerAdmin } from '../src/admin/routes'

// AUTH off => requireAdmin is dev-open, so we exercise the CRUD directly.
describe('admin surface (users, sources, mappings, raw events)', () => {
  let app: FastifyInstance
  let db: PGlite
  beforeAll(async () => {
    delete process.env.AUTH_ENABLED
    db = await PGlite.create()
    await runMigrations(db)
    app = Fastify()
    registerAdmin(app, db)
    await app.ready()
  })

  it('adds and lists allow-list users', async () => {
    const add = await app.inject({ method: 'POST', url: '/admin/api/users', payload: { email: 'Rep@dailymentor.co', role: 'viewer' } })
    expect(add.statusCode).toBe(200)
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/admin/api/users' })).body)
    expect(list.map((u: { email: string }) => u.email)).toContain('rep@dailymentor.co')
  })

  it('registers a source + field mapping', async () => {
    await app.inject({ method: 'POST', url: '/admin/api/sources', payload: { key: 'close_booking', label: 'Close bookings' } })
    await app.inject({ method: 'POST', url: '/admin/api/mappings', payload: { source_key: 'close_booking', incoming_field: 'Total Cash Collected', target_column: 'cash' } })
    const maps = JSON.parse((await app.inject({ method: 'GET', url: '/admin/api/mappings?source=close_booking' })).body)
    expect(maps).toHaveLength(1)
    expect(maps[0].target_column).toBe('cash')
  })

  it('browses the raw-events log', async () => {
    await db.query(`INSERT INTO raw_events(source,event_type,payload) VALUES ('s','create','{}')`)
    const ev = JSON.parse((await app.inject({ method: 'GET', url: '/admin/api/raw-events' })).body)
    expect(ev.length).toBeGreaterThanOrEqual(1)
    expect(ev[0].source).toBe('s')
  })
})
