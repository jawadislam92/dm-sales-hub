import { describe, it, expect } from 'vitest'
import { buildBK, series, statusMix } from '../src/engine/metrics'

const tab = (rows: unknown[][]) => ({
  name: 'Bookings',
  cols: ['Booking Date', 'Scheduled Call Date (PST)', 'Lead Owner',
    'Attributed Setter Full Name', 'Lead Status',
    'Total Cash Collected', 'Total Cash Collected after Fees'],
  data: rows,
})
const rec = (cs: string, owner: string, status: string, cash: unknown) =>
  ['', cs, owner, '', status, cash, cash]

describe('series', () => {
  it('daily buckets when span <= 92 days; cash/book land on the right day; range inclusive', () => {
    const s = series(buildBK(tab([
      rec('2026-06-01', 'A', 'Closed', 100),
      rec('2026-06-01', 'A', 'Closed', 50),
      rec('2026-06-03', 'A', 'Closed', 10),
    ])), 'closer', null, '2026-06-01', '2026-06-03', 'call')
    expect(s.daily).toBe(true)
    expect(s.keys).toEqual(['2026-06-01', '2026-06-02', '2026-06-03'])
    expect(s.cash).toEqual([150, 0, 10])
    expect(s.book).toEqual([2, 0, 1])
  })

  it('monthly buckets when span > 92 days', () => {
    const s = series(buildBK(tab([
      rec('2026-01-15', 'A', 'Closed', 100),
      rec('2026-03-10', 'A', 'Closed', 5),
    ])), 'closer', null, '2026-01-01', '2026-06-30', 'call')
    expect(s.daily).toBe(false)
    expect(s.keys).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'])
    expect(s.cash).toEqual([100, 0, 5, 0, 0, 0])
  })

  it('filters to a single person when a name is given', () => {
    const s = series(buildBK(tab([
      rec('2026-06-01', 'A', 'Closed', 100),
      rec('2026-06-01', 'B', 'Closed', 9),
    ])), 'closer', 'A', '2026-06-01', '2026-06-02', 'call')
    expect(s.cash).toEqual([100, 0])
  })
})

describe('statusMix', () => {
  it('counts a persons statuses, top 6 by count desc, other people excluded', () => {
    const rows: unknown[][] = []
    for (let i = 0; i < 3; i++) rows.push(rec('2026-06-01', 'A', 'Closed', 1))
    rows.push(rec('2026-06-01', 'A', 'No-Show', 0))
    rows.push(rec('2026-06-01', 'B', 'Closed', 1))
    const mix = statusMix(buildBK(tab(rows)), 'closer', 'A', '2026-06-01', '2026-06-30', 'call')
    expect(mix[0]).toEqual(['Closed', 3])
    expect(mix[1]).toEqual(['No-Show', 1])
  })
})
