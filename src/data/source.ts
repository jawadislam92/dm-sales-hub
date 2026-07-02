import type { Rec } from '../engine/metrics'

// The read side of the app depends only on this interface. The interim
// snapshot source and the future Postgres source both implement it, so the
// server, API and (client) engine never change when we swap the backing store.

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

export interface DataSource {
  /** Bookings flattened into the engine's record shape. */
  getBK(): Rec[]
  /** All-time overview context the dashboards show (from precomputed aggregates). */
  overviewExtra(): OverviewExtra
  /** The raw tabs available in the explorer. */
  listTabs(): TabInfo[]
  /** A page of a raw tab, or null if the tab is unknown. */
  tabPage(name: string, offset: number, limit: number): TabPage | null
}
