import type { FastifyInstance } from 'fastify'
import type { PGlite } from '@electric-sql/pglite'
import type { DataSource } from '../data/source'
import { requireAdmin } from '../auth/routes'

// Normalize names so accent/case/whitespace variants merge (Noël≡Noel, Tj≡TJ).
const canon = (name: string): string =>
  (name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

// Confirmed same-person aliases (Close placeholder surname -> real sheet name).
const ALIAS: Record<string, string> = {
  'richard daily mentor': 'richard lee',
  'emilia daily mentor': 'emilia de azcuenaga',
}
const keyOf = (name: string): string => ALIAS[canon(name)] ?? canon(name)

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

    // merge accent/case/whitespace name variants across both systems
    const merged: Record<string, { closer: string; closeWon: number; sheetClosed: number }> = {}
    const add = (name: string, field: 'closeWon' | 'sheetClosed', n: number): void => {
      const k = canon(name)
      if (!merged[k]) merged[k] = { closer: name, closeWon: 0, sheetClosed: 0 }
      merged[k][field] += n
    }
    Object.entries(wonByCloser).forEach(([n, c]) => add(n, 'closeWon', c))
    Object.entries(closesByCloser).forEach(([n, c]) => add(n, 'sheetClosed', c))
    const byCloser = Object.values(merged).sort((a, b) => b.closeWon - a.closeWon)

    return {
      close: { opportunitiesTotal: rows.length, wonTotal, wonValue: Math.round(wonValue), wonProgram },
      sheet: { closesTotal },
      byCloser,
    }
  })

  // Reconcile the replicated close_bookings vs the sheet, month by month, within
  // whatever date range Close actually covers.
  app.get('/admin/api/reconcile/bookings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return
    const cb = (await db.query<{ scheduled_date: string; status: string }>(
      'SELECT scheduled_date, status FROM close_bookings')).rows
    const byMonth: Record<string, number> = {}
    const byStatus: Record<string, number> = {}
    let min = '9999', max = '0000'
    for (const r of cb) {
      const m = (r.scheduled_date || '').slice(0, 7)
      if (m) byMonth[m] = (byMonth[m] || 0) + 1
      const st = r.status || '(blank)'
      byStatus[st] = (byStatus[st] || 0) + 1
      if (r.scheduled_date && r.scheduled_date < min) min = r.scheduled_date
      if (r.scheduled_date && r.scheduled_date > max) max = r.scheduled_date
    }
    const BK = await source.getBK()
    const sheetByMonth: Record<string, number> = {}
    for (const b of BK) {
      if (b.cs >= min && b.cs <= max) {
        const m = b.cs.slice(0, 7)
        sheetByMonth[m] = (sheetByMonth[m] || 0) + 1
      }
    }
    return { closeBookings: { total: cb.length, range: [min, max], byMonth, byStatus }, sheetInRange: { byMonth: sheetByMonth } }
  })
}
