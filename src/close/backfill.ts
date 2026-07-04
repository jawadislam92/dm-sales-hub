import type { FastifyInstance } from 'fastify'
import type { PGlite } from '@electric-sql/pglite'
import { requireAdmin } from '../auth/routes'
import { normalizeLead } from './normalize'

interface CloseAuth { baseUrl: string; token: string }

const headers = (token: string): Record<string, string> =>
  ({ accept: 'application/json', authorization: 'Basic ' + Buffer.from(token + ':').toString('base64') })

// Reuse whichever integration points at close.com for its base URL + key.
async function closeAuth(db: PGlite): Promise<CloseAuth | null> {
  const rows = (await db.query<{ config: unknown }>('SELECT config FROM integrations')).rows
  for (const r of rows) {
    const cfg = (typeof r.config === 'string' ? JSON.parse(r.config) : r.config) as {
      base_url?: string; auth?: { token?: string }
    }
    if (cfg?.base_url && /close\.com/i.test(cfg.base_url) && cfg.auth?.token) {
      return { baseUrl: cfg.base_url.replace(/\/$/, ''), token: cfg.auth.token }
    }
  }
  return null
}

async function fetchUserMap(a: CloseAuth): Promise<Record<string, string>> {
  const res = await fetch(`${a.baseUrl}/user/?_limit=200`, { headers: headers(a.token) })
  const body = (await res.json()) as { data?: Array<Record<string, string>> }
  const map: Record<string, string> = {}
  for (const u of body.data || []) {
    map[u.id] = (u.display_name || `${u.first_name || ''} ${u.last_name || ''}`).trim()
  }
  return map
}

async function setJob(db: PGlite, state: string, cursor: number, processed: number, kept: number, message: string): Promise<void> {
  await db.query(
    `INSERT INTO jobs(name,state,cursor,processed,kept,message,updated_at)
     VALUES ('close_leads',$1,$2,$3,$4,$5,now())
     ON CONFLICT (name) DO UPDATE SET state=$1,cursor=$2,processed=$3,kept=$4,message=$5,updated_at=now()`,
    [state, cursor, processed, kept, message])
}

let RUNNING = false

// Pages through every Close lead, keeps the ones that booked a call, upserts them
// into close_bookings. Resumable via the stored cursor; upsert makes re-runs safe.
export async function runBackfill(db: PGlite): Promise<void> {
  if (RUNNING) return
  RUNNING = true
  try {
    const a = await closeAuth(db)
    if (!a) { await setJob(db, 'error', 0, 0, 0, 'no Close integration found'); return }
    const userMap = await fetchUserMap(a)
    const j = (await db.query<{ cursor: number; processed: number; kept: number }>(
      "SELECT cursor,processed,kept FROM jobs WHERE name='close_leads'")).rows[0]
    let cursor = j?.cursor ?? 0
    let processed = j?.processed ?? 0
    let kept = j?.kept ?? 0
    const fields = encodeURIComponent('id,status_label,display_name,date_created,custom')
    for (let page = 0; page < 800; page++) {
      const res = await fetch(`${a.baseUrl}/lead/?_limit=100&_skip=${cursor}&_fields=${fields}`, { headers: headers(a.token) })
      if (!res.ok) { await setJob(db, 'error', cursor, processed, kept, `HTTP ${res.status}`); return }
      const body = (await res.json()) as { data?: Array<Record<string, unknown>>; has_more?: boolean }
      const leads = body.data || []
      for (const lead of leads) {
        processed++
        const b = normalizeLead(lead, userMap)
        if (!b) continue
        kept++
        await db.query(
          `INSERT INTO close_bookings(lead_id,status,program,scheduled_date,closer,prospect,country,date_created)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (lead_id) DO UPDATE SET
             status=$2,program=$3,scheduled_date=$4,closer=$5,prospect=$6,country=$7,date_created=$8,updated_at=now()`,
          [b.lead_id, b.status, b.program, b.scheduled_date, b.closer, b.prospect, b.country, b.date_created])
      }
      cursor += leads.length
      await setJob(db, 'running', cursor, processed, kept, `page ${page}`)
      if (!body.has_more || leads.length === 0) { await setJob(db, 'done', cursor, processed, kept, 'complete'); return }
    }
    await setJob(db, 'done', cursor, processed, kept, 'stopped at page cap')
  } catch (e) {
    await setJob(db, 'error', 0, 0, 0, e instanceof Error ? e.message : String(e))
  } finally {
    RUNNING = false
  }
}

export function registerClose(app: FastifyInstance, db: PGlite): void {
  app.post('/admin/api/close/backfill/start', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    void runBackfill(db) // fire-and-forget; poll status
    return { ok: true, started: true }
  })
  app.get('/admin/api/close/backfill/status', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const job = (await db.query('SELECT * FROM jobs WHERE name=\'close_leads\'')).rows[0] ?? { state: 'idle' }
    const n = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM close_bookings')).rows[0].n
    return { job, bookingsStored: n }
  })
}
