import type { FastifyInstance } from 'fastify'
import type { PGlite } from '@electric-sql/pglite'
import type { DataSource } from '../data/source'
import { requireAdmin } from '../auth/routes'

// Reconciliation: does the LIVE Close data agree with the sheet? Compares Close
// won opportunities (by closer) against the sheet's closes (Lead Status "Closed",
// by Lead Owner). If the two line up, the API-direct pipe is trustworthy.
export function registerReconcile(app: FastifyInstance, db: PGlite, source: DataSource): void {
  app.get('/admin/api/reconcile/close', async (req, reply) => {
    if (!requireAdmin(req, reply)) return

    const rows = (await db.query<{ payload: unknown }>(
      "SELECT payload FROM raw_events WHERE source = 'close_opps'")).rows

    const wonByCloser: Record<string, number> = {}
    const wonProgram: Record<string, number> = {}
    let wonTotal = 0
    let wonValue = 0
    for (const r of rows) {
      const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>
      if (p.status_type !== 'won') continue
      wonTotal++
      wonValue += (Number(p.value) || 0) / 100
      const closer = String(p.user_name || '(unassigned)')
      wonByCloser[closer] = (wonByCloser[closer] || 0) + 1
      const prog = String(p.status_label || '(none)')
      wonProgram[prog] = (wonProgram[prog] || 0) + 1
    }

    const BK = await source.getBK()
    const closesByCloser: Record<string, number> = {}
    let closesTotal = 0
    for (const b of BK) {
      if (b.st === 'Closed') {
        closesTotal++
        closesByCloser[b.o] = (closesByCloser[b.o] || 0) + 1
      }
    }

    // side-by-side per closer (union of both name sets)
    const names = [...new Set([...Object.keys(wonByCloser), ...Object.keys(closesByCloser)])]
    const byCloser = names
      .map((n) => ({ closer: n, closeWon: wonByCloser[n] || 0, sheetClosed: closesByCloser[n] || 0 }))
      .sort((a, b) => b.closeWon - a.closeWon)

    return {
      close: { opportunitiesTotal: rows.length, wonTotal, wonValue: Math.round(wonValue), wonProgram },
      sheet: { closesTotal },
      byCloser,
    }
  })
}
