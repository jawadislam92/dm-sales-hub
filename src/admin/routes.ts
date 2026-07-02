import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PGlite } from '@electric-sql/pglite'
import { requireAdmin } from '../auth/routes'

const q = (req: FastifyRequest) => req.query as Record<string, unknown>
const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>
const str = (v: unknown) => String(v ?? '').trim()

// Admin API + page. Every route is admin-only (404 for everyone else). Lets a
// non-dev manage the allow-list, register a new Zap source + field mapping, and
// browse the append-only ingest log — all without a deploy.
export function registerAdmin(app: FastifyInstance, db: PGlite): void {
  app.get('/admin', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return reply.type('text/html').send(ADMIN_HTML)
  })

  app.get('/admin/api/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return (await db.query('SELECT email, role, created_at FROM users ORDER BY email')).rows
  })
  app.post('/admin/api/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const email = str(body(req).email).toLowerCase()
    const role = body(req).role === 'admin' ? 'admin' : 'viewer'
    if (!email) return reply.code(400).send({ error: 'email required' })
    await db.query('INSERT INTO users(email,role) VALUES ($1,$2) ON CONFLICT (email) DO UPDATE SET role=$2', [email, role])
    return { ok: true, email, role }
  })
  app.delete('/admin/api/users/:email', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    await db.query('DELETE FROM users WHERE email = $1', [str((req.params as { email: string }).email).toLowerCase()])
    return { ok: true }
  })

  app.get('/admin/api/sources', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return (await db.query('SELECT id,key,label,natural_key_field FROM sources ORDER BY key')).rows
  })
  app.post('/admin/api/sources', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const key = str(body(req).key)
    if (!key) return reply.code(400).send({ error: 'key required' })
    await db.query(
      'INSERT INTO sources(key,label,natural_key_field) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET label=$2,natural_key_field=$3',
      [key, str(body(req).label) || null, str(body(req).natural_key_field) || null])
    return { ok: true, key }
  })

  app.get('/admin/api/mappings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const src = str(q(req).source)
    return src
      ? (await db.query('SELECT * FROM source_field_mappings WHERE source_key=$1 ORDER BY id', [src])).rows
      : (await db.query('SELECT * FROM source_field_mappings ORDER BY id')).rows
  })
  app.post('/admin/api/mappings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const b = body(req)
    if (!str(b.source_key) || !str(b.incoming_field) || !str(b.target_column)) {
      return reply.code(400).send({ error: 'source_key, incoming_field, target_column required' })
    }
    await db.query(
      'INSERT INTO source_field_mappings(source_key,incoming_field,target_column,coercer) VALUES ($1,$2,$3,$4)',
      [str(b.source_key), str(b.incoming_field), str(b.target_column), str(b.coercer) || null])
    return { ok: true }
  })

  app.get('/admin/api/raw-events', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const limit = Math.min(200, Math.max(1, parseInt(str(q(req).limit) || '50', 10) || 50))
    return (await db.query(
      'SELECT id,source,external_id,event_type,received_at,process_state FROM raw_events ORDER BY id DESC LIMIT $1',
      [limit])).rows
  })
}

const ADMIN_HTML = `<!doctype html><meta charset="utf-8"><title>Admin — Daily Mentor</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7fb;color:#101828;margin:0;padding:24px}
h1{font-size:18px}h2{font-size:14px;margin:22px 0 8px}.card{background:#fff;border:1px solid #e8ebf2;border-radius:12px;padding:16px 18px;max-width:820px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #f1f3f8}
input,select{padding:7px 9px;border:1px solid #e8ebf2;border-radius:8px;font-size:13px;margin-right:6px}
button{padding:7px 12px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-size:13px;cursor:pointer}
.x{background:#fdecea;color:#b42318;padding:2px 8px;border-radius:6px;cursor:pointer;font-size:12px;border:0}a{color:#4f46e5}</style>
<h1>Admin · <a href="/">← back to dashboard</a></h1>
<div class="card"><h2>Team access (who can log in)</h2>
<div><input id="ue" type="email" placeholder="email"><select id="ur"><option value="viewer">viewer</option><option value="admin">admin</option></select><button onclick="addUser()">Add / update</button></div>
<table id="users"></table></div>
<div class="card"><h2>Recent inbound events (append-only log)</h2><table id="events"></table></div>
<script>
const esc=s=>(''+s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
async function j(u,o){const r=await fetch(u,o);return r.json();}
async function loadUsers(){const u=await j('/admin/api/users');document.getElementById('users').innerHTML='<tr><th>Email</th><th>Role</th><th></th></tr>'+u.map(x=>'<tr><td>'+esc(x.email)+'</td><td>'+esc(x.role)+'</td><td><button class=x onclick="delUser(\\''+esc(x.email)+'\\')">remove</button></td></tr>').join('');}
async function addUser(){const email=document.getElementById('ue').value,role=document.getElementById('ur').value;await j('/admin/api/users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,role})});document.getElementById('ue').value='';loadUsers();}
async function delUser(e){await fetch('/admin/api/users/'+encodeURIComponent(e),{method:'DELETE'});loadUsers();}
async function loadEvents(){const e=await j('/admin/api/raw-events?limit=50');document.getElementById('events').innerHTML='<tr><th>#</th><th>Source</th><th>Type</th><th>Received</th><th>State</th></tr>'+(e.length?e.map(x=>'<tr><td>'+x.id+'</td><td>'+esc(x.source)+'</td><td>'+esc(x.event_type)+'</td><td>'+esc(x.received_at)+'</td><td>'+esc(x.process_state)+'</td></tr>').join(''):'<tr><td colspan=5 style="color:#98a2b3">No events yet — this fills once Zapier starts posting.</td></tr>');}
loadUsers();loadEvents();
</script>`
