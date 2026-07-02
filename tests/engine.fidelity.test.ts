import { describe, it, expect } from 'vitest'
import { buildBK, aggregate, QSET, SHOWN } from '../src/engine/metrics'
import { daysBetween, addDays } from '../src/engine/dateEngine'

// Each test below pins one "drift trap" from the metric-port fidelity review.
// If the port breaks any of these, the numbers silently diverge from the HUB.

const tab = (rows: unknown[][]) => ({
  name: 'Bookings',
  cols: ['Booking Date', 'Scheduled Call Date (PST)', 'Lead Owner',
    'Attributed Setter Full Name', 'Lead Status',
    'Total Cash Collected', 'Total Cash Collected after Fees'],
  data: rows,
})
// row: booking date, scheduled call date, owner, setter, status, cash, fees
const rec = (cs: string, owner: string, status: string, cash: unknown) =>
  ['', cs, owner, '', status, cash, cash]

describe('date engine', () => {
  it('92-day span is the daily/monthly boundary (daysBetween 91 => span 92)', () => {
    expect(daysBetween('2026-01-01', '2026-04-02')).toBe(91)
    expect(daysBetween('2026-01-01', '2026-04-03')).toBe(92)
  })
  it('addDays crosses a month by UTC calendar', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
  })
})

describe('aggregate fidelity guards', () => {
  it('closed = cash > 0 strictly — zero and negative are not closes', () => {
    const A = aggregate(buildBK(tab([
      rec('2026-06-10', 'A', 'Closed', 0),
      rec('2026-06-10', 'A', 'Closed', -500),
      rec('2026-06-10', 'A', 'Closed', 1),
    ])), 'closer', '2026-06-01', '2026-06-30', 'call')
    expect(A.map['A'].closed).toBe(1)
  })

  it('range end date is inclusive (string compare, not Date <= to)', () => {
    const A = aggregate(buildBK(tab([rec('2026-06-30', 'A', 'Closed', 100)])),
      'closer', '2026-06-01', '2026-06-30', 'call')
    expect(A.map['A'].cash).toBe(100)
  })

  it('person key is trim-only — internal whitespace is NOT collapsed', () => {
    const A = aggregate(buildBK(tab([
      rec('2026-06-10', 'Pavan Dhesi', 'Closed', 10),
      rec('2026-06-10', 'Pavan  Dhesi', 'Closed', 20),
    ])), 'closer', '2026-06-01', '2026-06-30', 'call')
    expect(A.map['Pavan Dhesi'].cash).toBe(10)
    expect(A.map['Pavan  Dhesi'].cash).toBe(20)
  })

  it('status membership is exact — trailing space / wrong set breaks the match', () => {
    expect(QSET.has('Closed')).toBe(true)
    expect(QSET.has('Closed ')).toBe(false)
    expect(SHOWN.has('Call Completed - Disqualified')).toBe(true)
    expect(QSET.has('Call Completed - Disqualified')).toBe(false)
  })

  it('cash coercion: bare number parses; currency string and blank are 0', () => {
    const A = aggregate(buildBK(tab([
      rec('2026-06-10', 'A', 'Closed', '1790'),
      rec('2026-06-10', 'B', 'Closed', '$1,790'),
      rec('2026-06-10', 'C', 'Closed', ''),
    ])), 'closer', '2026-06-01', '2026-06-30', 'call')
    expect(A.map['A'].cash).toBe(1790)
    expect(A.map['B'].cash).toBe(0)
    expect(A.map['C'].cash).toBe(0)
  })
})
