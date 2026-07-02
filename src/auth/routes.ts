import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { PGlite } from '@electric-sql/pglite'
import { sign, verify } from './tokens'
import { findUser } from './allowlist'

export interface Session { email: string; role: string }
const COOKIE = 'dm_session'

export const authEnabled = (): boolean => process.env.AUTH_ENABLED === '1'

// Admin routes 404 for non-admins (no hint the route exists). Open in dev (auth off).
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!authEnabled()) return true
  const s = (req as { session?: Session }).session
  if (!s || s.role !== 'admin') { reply.code(404).send({ error: 'not found' }); return false }
  return true
}

export function registerAuth(app: FastifyInstance, db: PGlite): void {
  // Global guard: when enabled, every request needs a valid session except health,
  // the webhook (its own secret) and the /auth/* flow itself.
  app.addHook('onRequest', async (req, reply) => {
    if (!authEnabled()) return
    const path = req.url.split('?')[0]
    if (path === '/healthz' || path === '/ingest' || path.startsWith('/auth')) return
    const raw = req.cookies?.[COOKIE]
    const sess = raw ? verify<Session>(raw) : null
    if (!sess) {
      if (path.startsWith('/api')) return reply.code(401).send({ error: 'login required' })
      return reply.redirect('/auth')
    }
    ;(req as { session?: Session }).session = sess
  })

  app.get('/auth', async (_req, reply) => reply.type('text/html').send(LOGIN_HTML))

  app.post('/auth/request', async (req, reply) => {
    const email = String((req.body as { email?: unknown })?.email ?? '').trim().toLowerCase()
    const user = email ? await findUser(db, email) : null
    let devLink: string | undefined
    if (user) {
      const token = sign({ email: user.email, role: user.role, kind: 'magic' }, 15 * 60)
      const link = `/auth/verify?token=${encodeURIComponent(token)}`
      app.log.info({ email }, `magic login link: ${link}`)
      if (process.env.AUTH_DEV === '1') devLink = link
      // prod: deliver `link` to `email` via SMTP (nodemailer) when SMTP_URL is set.
    }
    // Generic response either way — never reveal whether an email is on the list.
    return reply.send({ ok: true, ...(devLink ? { devLink } : {}) })
  })

  app.get('/auth/verify', async (req, reply) => {
    const token = String((req.query as { token?: unknown })?.token ?? '')
    const p = verify<Session & { kind?: string }>(token)
    if (!p || p.kind !== 'magic') return reply.code(400).type('text/html').send('Invalid or expired link.')
    const session = sign({ email: p.email, role: p.role }, 7 * 24 * 3600)
    reply.setCookie(COOKIE, session, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 3600 })
    return reply.redirect('/')
  })

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' })
    return reply.send({ ok: true })
  })
}

const LOGIN_HTML = `<!doctype html><meta charset="utf-8"><title>Sign in — Daily Mentor</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7fb;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#fff;border:1px solid #e8ebf2;border-radius:14px;padding:28px 30px;width:320px;box-shadow:0 1px 3px rgba(16,24,40,.06)}
h1{font-size:17px;margin:0 0 4px}p{color:#667085;font-size:13px;margin:0 0 16px}
input{width:100%;padding:9px 11px;border:1px solid #e8ebf2;border-radius:9px;font-size:14px;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:9px;border:0;border-radius:9px;background:#4f46e5;color:#fff;font-size:14px;cursor:pointer}
.msg{margin-top:12px;font-size:13px;color:#067647;min-height:18px}</style>
<div class="card"><h1>Daily Mentor</h1><p>Sign in to the Sales Workspace</p>
<input id="e" type="email" placeholder="you@dailymentor.co" autofocus>
<button onclick="go()">Email me a sign-in link</button><div class="msg" id="m"></div></div>
<script>async function go(){const e=document.getElementById('e').value;const r=await fetch('/auth/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:e})});const d=await r.json();document.getElementById('m').textContent=d.devLink?'Dev link ready — redirecting…':'Check your email for a sign-in link.';if(d.devLink)location.href=d.devLink;}</script>`
