import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBK } from '../engine/metrics'
import type { DataSource, OverviewExtra, TabInfo, TabPage } from './source'

interface SnapTab { name: string; n: number; cols: string[]; types: string[]; data: unknown[][] }
interface Snapshot { tabs: SnapTab[] }

// Interim DataSource: loads the prototype's "Sales | Master" snapshot from disk at
// boot. Exactly the data the HUB parity test reconciles, so it reproduces the HUB
// numbers out of the box with zero setup. The default backend.
export function createSnapshotSource(dataDir: string): DataSource {
  const site = JSON.parse(readFileSync(join(dataDir, 'site_data.json'), 'utf-8')) as Snapshot
  const dash = JSON.parse(readFileSync(join(dataDir, 'dash.json'), 'utf-8')) as {
    overview?: { new_returning?: Record<string, number>; lead_sources?: Array<[string, number]> }
  }
  const tabs = new Map<string, SnapTab>(site.tabs.map((t) => [t.name, t]))
  const bookings = tabs.get('Bookings')
  if (!bookings) throw new Error('Bookings tab missing from snapshot at ' + dataDir)
  const BK = buildBK(bookings)

  return {
    getBK: async () => BK,
    overviewExtra: async (): Promise<OverviewExtra> => ({
      new_returning: dash.overview?.new_returning ?? {},
      lead_sources: dash.overview?.lead_sources ?? [],
    }),
    listTabs: async (): Promise<TabInfo[]> => site.tabs.map((t) => ({ name: t.name, n: t.n })),
    tabPage: async (name, offset, limit): Promise<TabPage | null> => {
      const t = tabs.get(name)
      if (!t) return null
      return { name, cols: t.cols, types: t.types, rows: t.data.slice(offset, offset + limit), total: t.n, offset, limit }
    },
  }
}
