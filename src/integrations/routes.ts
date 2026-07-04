import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PGlite } from '@electric-sql/pglite'
import { requireAdmin } from '../auth/routes'
import type { PollConfig } from './connectors'
import {
  listIntegrations, createIntegration, updateIntegration, deleteIntegration, runIntegration,
  type NewIntegration,
} from './service'

const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>
const idOf = (req: FastifyRequest) => Number((req.params as { id: string }).id)

export function registerIntegrations(app: FastifyInstance, db: PGlite): void {
  app.get('/admin/integrations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return reply.type('text/html').send(PAGE)
  })

  app.get('/admin/api/integrations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    return listIntegrations(db)
  })

  app.post('/admin/api/integrations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const b = body(req)
    if (!b.name || !b.kind || !b.source_key) {
      return reply.code(400).send({ error: 'name, kind, source_key required' })
    }
    return createIntegration(db, b as unknown as NewIntegration)
  })

  app.patch('/admin/api/integrations/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    await updateIntegration(db, idOf(req), body(req))
    return { ok: true }
  })

  app.delete('/admin/api/integrations/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    await deleteIntegration(db, idOf(req))
    return { ok: true }
  })

  app.post('/admin/api/integrations/:id/run', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    try {
      return await runIntegration(db, idOf(req))
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // Dev/build helper: hit one path on the integration's API using its stored key
  // (server-side; the key is never returned) to inspect real record shapes.
  app.get('/admin/api/integrations/:id/probe', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const row = (await db.query<Record<string, unknown>>('SELECT * FROM integrations WHERE id=$1', [idOf(req)])).rows[0]
    if (!row) return reply.code(404).send({ error: 'not found' })
    const cfg = (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as PollConfig
    const token = cfg.auth?.token || String(row.secret || '')
    const path = String((req.query as Record<string, unknown>).path || '/lead/?_limit=1')
    const url = String(cfg.base_url).replace(/\/$/, '') + path
    const res = await fetch(url, {
      headers: { accept: 'application/json', authorization: 'Basic ' + Buffer.from(token + ':').toString('base64') },
    })
    return { status: res.status, body: await res.json() }
  })
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Integrations — Daily Mentor</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7fb;color:#101828;margin:0;padding:24px}
h1{font-size:18px}h2{font-size:14px;margin:20px 0 8px}.card{background:#fff;border:1px solid #e8ebf2;border-radius:12px;padding:16px 18px;max-width:900px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #f1f3f8;vertical-align:top}
label{display:block;font-size:11px;color:#667085;margin:8px 0 3px;font-weight:600}
input,select{width:100%;padding:7px 9px;border:1px solid #e8ebf2;border-radius:8px;font-size:13px;box-sizing:border-box}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{padding:7px 12px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-size:13px;cursor:pointer;margin-top:10px}
.b2{background:#eef2ff;color:#4f46e5}.x{background:#fdecea;color:#b42318}a{color:#4f46e5}.mut{color:#98a2b3}code{background:#f2f4f8;padding:1px 6px;border-radius:5px;font-size:12px}
.ok{color:#067647}.err{color:#b42318}</style>
<h1>Integrations · <a href="/admin">← admin</a> · <a href="/">dashboard</a></h1>
<p class="mut">Connect a data source two ways: <b>Webhook</b> (the tool/Zapier pushes to us) or <b>API</b> (we pull on a schedule — enter the base URL, key and how often).</p>

<div class="card"><h2>Add an integration</h2>
<div class="row">
  <div><label>Name</label><input id="name" placeholder="Close.com opportunities"></div>
  <div><label>Source key (groups the data)</label><input id="src" placeholder="close_opps"></div>
</div>
<label>Type</label>
<select id="kind" onchange="toggle()"><option value="api_poll">API — pull on a schedule</option><option value="webhook">Webhook — the tool pushes to us</option></select>
<div id="apiFields">
  <div class="row">
    <div><label>API base URL</label><input id="base" placeholder="https://api.close.com/api/v1"></div>
    <div><label>Path</label><input id="path" placeholder="/opportunity/"></div>
  </div>
  <div class="row">
    <div><label>Auth</label><select id="auth"><option value="bearer">Bearer token</option><option value="basic">Basic (API key as username — Close.com)</option><option value="header">Custom header</option><option value="none">None</option></select></div>
    <div><label>API key / token</label><input id="token" placeholder="paste key"></div>
  </div>
  <div class="row">
    <div><label>Array path in response</label><input id="rpath" placeholder="data"></div>
    <div><label>Every (seconds)</label><input id="interval" type="number" value="300"></div>
  </div>
</div>
<button onclick="add()">Add integration</button>
<div id="msg" style="margin-top:10px"></div>
</div>

<div class="card"><h2>Connected</h2><table id="list"></table></div>
<script>
const esc=s=>(''+s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
const $=id=>document.getElementById(id);
function toggle(){$('apiFields').style.display=$('kind').value==='api_poll'?'block':'none';}
async function j(u,o){const r=await fetch(u,o);return {s:r.status,d:await r.json().catch(()=>({}))};}
async function add(){
  const kind=$('kind').value;
  const payload={name:$('name').value,source_key:$('src').value,kind,enabled:true};
  if(kind==='api_poll'){payload.interval_seconds=+$('interval').value||300;payload.config={base_url:$('base').value,path:$('path').value,result_path:$('rpath').value,auth:{type:$('auth').value,token:$('token').value}};}
  const {s,d}=await j('/admin/api/integrations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  if(s>=400){$('msg').innerHTML='<span class=err>'+esc(d.error||'error')+'</span>';return;}
  if(kind==='webhook'){const url=location.origin+'/ingest';$('msg').innerHTML='<b>Webhook ready.</b> Point the tool/Zapier here:<br>URL <code>'+url+'</code><br>Header <code>X-Webhook-Secret: '+esc(d.secret)+'</code>';}
  else{$('msg').innerHTML='<span class=ok>Added. It will pull automatically; use “Run now” to test immediately.</span>';}
  load();
}
async function setEnabled(id,en){await fetch('/admin/api/integrations/'+id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:en})});load();}
async function run(id){const {d}=await j('/admin/api/integrations/'+id+'/run',{method:'POST'});alert(d.error?('Error: '+d.error):('Fetched '+d.fetched+', new '+d.stored));load();}
async function del(id){if(confirm('Remove this integration?')){await fetch('/admin/api/integrations/'+id,{method:'DELETE'});load();}}
async function load(){
  const {d}=await j('/admin/api/integrations');
  $('list').innerHTML='<tr><th>Name</th><th>Type</th><th>Source</th><th>On</th><th>Last run</th><th></th></tr>'+
   ((d&&d.length)?d.map(i=>'<tr><td>'+esc(i.name)+'</td><td>'+esc(i.kind)+'</td><td><code>'+esc(i.source_key)+'</code></td>'+
    '<td><input type=checkbox '+(i.enabled?'checked':'')+' onchange="setEnabled('+i.id+',this.checked)"></td>'+
    '<td>'+(i.last_status?('<span class="'+(i.last_error?'err':'ok')+'">'+esc(i.last_status)+'</span>'):'<span class=mut>never</span>')+'</td>'+
    '<td>'+(i.kind==='api_poll'?'<button class=b2 onclick="run('+i.id+')">Run now</button> ':'')+'<button class=x onclick="del('+i.id+')">remove</button></td></tr>').join(''):'<tr><td colspan=6 class=mut>None yet.</td></tr>');
}
toggle();load();
</script>`
