import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'

// One-time (idempotent) load of the "Sales | Master" snapshot into the database.
// - All 12 tabs land verbatim in tab_rows/tab_catalog (for the raw grids).
// - Bookings is projected into the typed `bookings` table INSERT 1:1 by row position
//   (no dedup/merge), with no-date rows quarantined (metric-ineligible, all $0).
// The DB-backed HUB assertion (tests/backfill.hub.test.ts) is the gate that this
// projection stayed faithful: June closer cash must still equal $455,674.90.

const slice10 = (v: unknown): string => ('' + (v ?? '')).slice(0, 10)
const hasDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}/.test(s)
const num = (v: unknown): number => { const n = +(v as number); return Number.isFinite(n) ? n : 0 }

interface SnapTab { name: string; n: number; cols: string[]; types: string[]; data: unknown[][] }

async function insertChunked(
  db: PGlite, build: (placeholders: string) => string, rows: unknown[][], perRow: number, chunk = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    const ph = slice
      .map((_, r) => '(' + Array.from({ length: perRow }, (_, c) => '$' + (r * perRow + c + 1)).join(',') + ')')
      .join(',')
    await db.query(build(ph), slice.flat())
  }
}

export async function backfill(
  db: PGlite, dataDir: string,
): Promise<{ tabs: number; bookings: number; quarantined: number }> {
  const site = JSON.parse(readFileSync(join(dataDir, 'site_data.json'), 'utf-8')) as { tabs: SnapTab[] }
  const dash = JSON.parse(readFileSync(join(dataDir, 'dash.json'), 'utf-8')) as {
    overview?: { new_returning?: unknown; lead_sources?: unknown }
  }

  await db.exec('DELETE FROM tab_rows; DELETE FROM tab_catalog; DELETE FROM bookings; DELETE FROM overview_extra;')

  for (const t of site.tabs) {
    await db.query('INSERT INTO tab_catalog(name,cols,types,n) VALUES ($1,$2,$3,$4)',
      [t.name, JSON.stringify(t.cols), JSON.stringify(t.types), t.n])
    const rows = t.data.map((cells, idx) => [t.name, idx, JSON.stringify(cells)])
    await insertChunked(db, (ph) => `INSERT INTO tab_rows(tab,row_index,cells) VALUES ${ph}`, rows, 3)
  }

  const B = site.tabs.find((t) => t.name === 'Bookings')
  if (!B) throw new Error('Bookings tab missing from snapshot')
  const idx: Record<string, number> = {}
  B.cols.forEach((c, i) => { idx[String(c).trim().toLowerCase()] = i })
  const CS = idx['scheduled call date (pst)'], BD = idx['booking date'], OW = idx['lead owner'],
    SE = idx['attributed setter full name'], ST = idx['lead status'],
    CA = idx['total cash collected'], FE = idx['total cash collected after fees']

  let quarantined = 0
  const brows: unknown[][] = B.data.map((r, i) => {
    const cs = slice10(r[CS]), bd = slice10(r[BD])
    const q = !(hasDate(cs) || hasDate(bd))
    if (q) quarantined++
    return [i, cs, bd, ('' + (r[OW] || '')).trim(), ('' + (r[SE] || '')).trim(), (r[ST] || ''), num(r[CA]), num(r[FE]), q]
  })
  await insertChunked(db, (ph) =>
    `INSERT INTO bookings(source_row_index,scheduled_call_date,booking_date,lead_owner,attributed_setter,lead_status,cash,fees,is_quarantined) VALUES ${ph}`,
    brows, 9)

  await db.query('INSERT INTO overview_extra(id,new_returning,lead_sources) VALUES (1,$1,$2)',
    [JSON.stringify(dash.overview?.new_returning ?? {}), JSON.stringify(dash.overview?.lead_sources ?? [])])

  const bc = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM bookings WHERE is_quarantined=false')).rows[0].n
  return { tabs: site.tabs.length, bookings: bc, quarantined }
}
