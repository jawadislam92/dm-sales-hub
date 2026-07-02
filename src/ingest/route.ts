import type { FastifyInstance } from 'fastify'
import type { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'

interface IngestBody {
  source?: unknown
  external_id?: unknown
  event_type?: unknown
  occurred_at?: unknown
  payload?: unknown
}

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)

// POST /ingest — the generic seam every Zap posts to (Phase 2). Every accepted call
// is appended to raw_events VERBATIM before any mapping, so a field we didn't map
// today can be re-mapped and replayed tomorrow. Keyed upsert into typed tables is a
// later step gated on the Zap export (BLK-1); v1 is append + reconcile.
export function registerIngest(app: FastifyInstance, db: PGlite): void {
  app.post('/ingest', async (req, reply) => {
    // Per-source shared secret (a static header on the Zapier POST action), NOT the
    // user session. Enforced only when a secret is configured.
    const secret = process.env.WEBHOOK_SHARED_SECRET
    if (secret && req.headers['x-webhook-secret'] !== secret) {
      return reply.code(401).send({ error: 'bad or missing webhook secret' })
    }

    const body = (req.body ?? {}) as IngestBody
    if (typeof body.source !== 'string' || typeof body.event_type !== 'string' || body.payload === undefined) {
      return reply.code(400).send({ error: 'source (string), event_type (string) and payload are required' })
    }

    const externalId = typeof body.external_id === 'string' ? body.external_id : null
    const occurredAt = isDate(body.occurred_at) ? body.occurred_at : null
    const dedupe = createHash('sha256')
      .update(JSON.stringify({ s: body.source, e: externalId, t: body.event_type, p: body.payload }))
      .digest('hex')

    const seen = (await db.query<{ id: number }>(
      'SELECT id FROM raw_events WHERE dedupe_hash = $1', [dedupe])).rows[0]
    if (seen) return reply.code(202).send({ ok: true, duplicate: true, id: seen.id })

    const row = (await db.query<{ id: number }>(
      `INSERT INTO raw_events(source, external_id, event_type, occurred_at, dedupe_hash, payload, process_state)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id`,
      [body.source, externalId, body.event_type, occurredAt, dedupe, JSON.stringify(body.payload)],
    )).rows[0]
    return reply.code(202).send({ ok: true, id: row.id })
  })
}
