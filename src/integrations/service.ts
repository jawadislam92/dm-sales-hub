import type { PGlite } from '@electric-sql/pglite'
import { createHash, randomBytes } from 'node:crypto'
import { httpPoll, type PollConfig } from './connectors'

export interface Integration {
  id: number
  name: string
  kind: string
  source_key: string
  enabled: boolean
  config: Record<string, unknown>
  interval_seconds: number | null
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
}

export interface NewIntegration {
  name: string
  kind: string
  source_key: string
  enabled?: boolean
  config?: Record<string, unknown>
  secret?: string | null
  interval_seconds?: number | null
}

const asObj = (v: unknown): Record<string, unknown> =>
  (typeof v === 'string' ? JSON.parse(v) : (v ?? {})) as Record<string, unknown>

// Never expose stored credentials over the API.
function redact(row: Record<string, unknown>): Integration {
  const config = asObj(row.config)
  const auth = config.auth as { token?: string } | undefined
  if (auth?.token) config.auth = { ...auth, token: '••••••' }
  const { secret: _secret, ...rest } = row
  return { ...(rest as unknown as Integration), config }
}

export async function listIntegrations(db: PGlite): Promise<Integration[]> {
  const rows = (await db.query<Record<string, unknown>>('SELECT * FROM integrations ORDER BY id')).rows
  return rows.map(redact)
}

export async function createIntegration(db: PGlite, i: NewIntegration): Promise<{ id: number; secret?: string }> {
  const secret = i.kind === 'webhook' ? randomBytes(18).toString('base64url') : (i.secret ?? null)
  const row = (await db.query<{ id: number }>(
    `INSERT INTO integrations(name,kind,source_key,enabled,config,secret,interval_seconds)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [i.name, i.kind, i.source_key, !!i.enabled, JSON.stringify(i.config ?? {}), secret, i.interval_seconds ?? null],
  )).rows[0]
  return { id: row.id, secret: i.kind === 'webhook' ? (secret as string) : undefined }
}

export async function updateIntegration(db: PGlite, id: number, patch: Record<string, unknown>): Promise<void> {
  const fields: string[] = []
  const vals: unknown[] = []
  let n = 1
  for (const k of ['name', 'enabled', 'config', 'interval_seconds', 'source_key'] as const) {
    if (patch[k] !== undefined) {
      fields.push(`${k}=$${n++}`)
      vals.push(k === 'config' ? JSON.stringify(patch[k]) : patch[k])
    }
  }
  if (!fields.length) return
  vals.push(id)
  await db.query(`UPDATE integrations SET ${fields.join(',')} WHERE id=$${n}`, vals)
}

export async function deleteIntegration(db: PGlite, id: number): Promise<void> {
  await db.query('DELETE FROM integrations WHERE id=$1', [id])
}

// Poll one api_poll integration and append new events to raw_events (idempotent by
// content hash, so re-polling unchanged records never duplicates).
export async function runIntegration(db: PGlite, id: number): Promise<{ fetched: number; stored: number }> {
  const row = (await db.query<Record<string, unknown>>('SELECT * FROM integrations WHERE id=$1', [id])).rows[0]
  if (!row) throw new Error('integration not found')
  if (row.kind !== 'api_poll') return { fetched: 0, stored: 0 }

  const cfg = asObj(row.config) as unknown as PollConfig
  if (row.secret) {
    cfg.auth = { type: cfg.auth?.type ?? 'bearer', header: cfg.auth?.header, token: String(row.secret) }
  }
  const source = String(row.source_key)
  let events: unknown[] = []
  let stored = 0
  try {
    events = await httpPoll(cfg)
    for (const ev of events) {
      const dedupe = createHash('sha256').update(JSON.stringify({ s: source, p: ev })).digest('hex')
      if ((await db.query('SELECT 1 FROM raw_events WHERE dedupe_hash=$1', [dedupe])).rows[0]) continue
      await db.query(
        `INSERT INTO raw_events(source,event_type,dedupe_hash,payload,process_state)
         VALUES ($1,'poll',$2,$3,'pending')`, [source, dedupe, JSON.stringify(ev)])
      stored++
    }
    await db.query('UPDATE integrations SET last_run_at=now(), last_status=$2, last_error=NULL WHERE id=$1',
      [id, `ok — ${events.length} fetched, ${stored} new`])
  } catch (e) {
    await db.query('UPDATE integrations SET last_run_at=now(), last_status=$2, last_error=$3 WHERE id=$1',
      [id, 'error', e instanceof Error ? e.message : String(e)])
    throw e
  }
  return { fetched: events.length, stored }
}
