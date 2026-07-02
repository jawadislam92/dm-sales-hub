import { describe, it, expect, beforeAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { PGlite } from '@electric-sql/pglite'
import { runMigrations } from '../src/db/pglite'
import { bootstrapAdmins } from '../src/auth/allowlist'
import { registerAuth } from '../src/auth/routes'

describe('auth — email allow-list + magic link (env-gated)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    process.env.AUTH_ENABLED = '1'
    process.env.AUTH_DEV = '1'
    process.env.SESSION_SECRET = 'test-secret'
    const db = await PGlite.create()
    await runMigrations(db)
    await bootstrapAdmins(db, ['boss@dailymentor.co'])
    app = Fastify()
    await app.register(cookie)
    registerAuth(app, db)
    app.get('/api/ping', async () => ({ pong: true }))
    await app.ready()
  })

  it('blocks /api without a session (401)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/ping' })
    expect(r.statusCode).toBe(401)
  })

  it('an allow-listed email gets a magic link; verifying it grants a working session', async () => {
    const req = await app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'boss@dailymentor.co' } })
    const link = JSON.parse(req.body).devLink as string
    expect(link).toContain('/auth/verify')

    const ver = await app.inject({ method: 'GET', url: link })
    expect(ver.statusCode).toBe(302)
    const setCookie = ver.headers['set-cookie']
    const cookieHeader = (Array.isArray(setCookie) ? setCookie[0] : setCookie) as string
    expect(cookieHeader).toContain('dm_session=')

    const ping = await app.inject({ method: 'GET', url: '/api/ping', headers: { cookie: cookieHeader.split(';')[0] } })
    expect(ping.statusCode).toBe(200)
    expect(JSON.parse(ping.body).pong).toBe(true)
  })

  it('an unknown email is never told it is not on the list (no enumeration)', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'nobody@example.com' } })
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body).ok).toBe(true)
    expect(JSON.parse(r.body).devLink).toBeUndefined()
  })
})
