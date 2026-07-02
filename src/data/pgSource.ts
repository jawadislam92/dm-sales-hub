import type { PGlite } from '@electric-sql/pglite'
import type { Rec } from '../engine/metrics'
import type { DataSource, OverviewExtra, TabInfo, TabPage } from './source'

const asJson = <T>(v: unknown, fallback: T): T =>
  (typeof v === 'string' ? JSON.parse(v) : (v ?? fallback)) as T

// DB-backed source. BK + overview + tab list are cached at init (BK is hit on every
// dashboard request); raw-tab pages are queried on demand (true DB pagination).
export async function createPgSource(db: PGlite): Promise<DataSource> {
  const bk = (await db.query<Record<string, unknown>>(
    `SELECT scheduled_call_date AS cs, booking_date AS bd, lead_owner AS o,
            attributed_setter AS s, lead_status AS st, cash, fees
     FROM bookings WHERE is_quarantined = false ORDER BY id`,
  )).rows
  const BK: Rec[] = bk.map((r) => ({
    cs: (r.cs as string) || '', bd: (r.bd as string) || '', o: (r.o as string) || '',
    s: (r.s as string) || '', st: (r.st as string) || '', cash: +(r.cash as number) || 0, fees: +(r.fees as number) || 0,
  }))

  const ovRow = (await db.query<Record<string, unknown>>(
    'SELECT new_returning, lead_sources FROM overview_extra WHERE id = 1')).rows[0]
  const overview: OverviewExtra = {
    new_returning: asJson(ovRow?.new_returning, {} as Record<string, number>),
    lead_sources: asJson(ovRow?.lead_sources, [] as Array<[string, number]>),
  }

  const tabList = (await db.query<Record<string, unknown>>('SELECT name, n FROM tab_catalog')).rows
    .map((r) => ({ name: r.name as string, n: r.n as number })) as TabInfo[]

  return {
    getBK: async () => BK,
    overviewExtra: async () => overview,
    listTabs: async () => tabList,
    tabPage: async (name, offset, limit): Promise<TabPage | null> => {
      const cat = (await db.query<Record<string, unknown>>(
        'SELECT cols, types, n FROM tab_catalog WHERE name = $1', [name])).rows[0]
      if (!cat) return null
      const rows = (await db.query<{ cells: unknown }>(
        'SELECT cells FROM tab_rows WHERE tab = $1 ORDER BY row_index OFFSET $2 LIMIT $3', [name, offset, limit],
      )).rows.map((r) => asJson<unknown[]>(r.cells, []))
      return {
        name,
        cols: asJson<string[]>(cat.cols, []),
        types: asJson<string[]>(cat.types, []),
        rows,
        total: cat.n as number,
        offset,
        limit,
      }
    },
  }
}
