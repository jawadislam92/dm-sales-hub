import type { Rec } from '../engine/metrics'

export interface OverviewExtra {
  new_returning: Record<string, number>
  lead_sources: Array<[string, number]>
}

export interface TabInfo { name: string; n: number }

export interface TabPage {
  name: string
  cols: string[]
  types: string[]
  rows: unknown[][]
  total: number
  offset: number
  limit: number
}

// Async so a DB-backed source can query on demand; the snapshot source resolves
// immediately. The server, API and engine never change when the store is swapped.
export interface DataSource {
  getBK(): Promise<Rec[]>
  overviewExtra(): Promise<OverviewExtra>
  listTabs(): Promise<TabInfo[]>
  tabPage(name: string, offset: number, limit: number): Promise<TabPage | null>
}
