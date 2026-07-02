// *** VERBATIM PORT of the metric engine from dashboard.template.html ***
// buildBK (L193-196), QSET/SHOWN (L157-158), aggregate (L252-257), rate (L259).
// Logic is character-faithful to the prototype; the only change is dependency
// injection (BK and the source tab are passed in rather than read from globals)
// so the engine is a pure, host-agnostic unit. The HUB parity test is the proof
// this port did not drift: June 2026 closer cash must equal $455,674.90.

import { addDays, daysBetween, parseD, isoD } from './dateEngine'

// Frozen status sets — exact case, exact spacing. Membership is tested on the
// UNTRIMMED status string, so "Closed " (trailing space) must NOT match.
export const QSET = new Set<string>([
  'Qualified Showed Call', 'Closed', 'Call Completed - Deposit',
  'Call Completed - 1 Week Trial', 'Closed Within 30 Days',
])
export const SHOWN = new Set<string>([
  'Qualified Showed Call', 'Closed', 'Call Completed - Deposit',
  'Call Completed - 1 Week Trial', 'Closed Within 30 Days',
  'Call Completed - Disqualified',
])

export interface Tab { cols: any[]; data: any[][] }

// The record shape buildBK flattens each Bookings row into.
export interface Rec {
  cs: string   // scheduled call date (pst), 10-char prefix
  bd: string   // booking date, 10-char prefix
  o: string    // lead owner (closer), trimmed
  s: string    // attributed setter, trimmed
  st: string   // lead status, NOT trimmed
  cash: number
  fees: number
}

export interface Person {
  name: string
  bookings: number
  shown: number
  qual: number
  closed: number
  cash: number
  fees: number
}

export interface Agg {
  map: Record<string, Person>
  names: string[]
  tot: Person
}

export function buildBK(t: Tab): Rec[] {
  const I = (n: string): number => t.cols.findIndex(c => ('' + c).trim().toLowerCase() === n)
  const cs = I('scheduled call date (pst)'), bd = I('booking date'), ow = I('lead owner'),
    se = I('attributed setter full name'), st = I('lead status'),
    ca = I('total cash collected'), fe = I('total cash collected after fees')
  return t.data.map(r => ({
    cs: ('' + (r[cs] || '')).slice(0, 10),
    bd: ('' + (r[bd] || '')).slice(0, 10),
    o: ('' + (r[ow] || '')).trim(),
    s: ('' + (r[se] || '')).trim(),
    st: (r[st] || '') as string,
    cash: +r[ca] || 0,
    fees: +r[fe] || 0,
  }))
}

export const rate = (a: number, b: number): number => (b ? (a / b) * 100 : 0)

export function aggregate(
  BK: Rec[], kind: 'closer' | 'setter', from: string, to: string, basis: 'call' | 'book',
): Agg {
  const map: Record<string, Person> = {}
  for (const b of BK) {
    const dk = basis === 'book' ? b.bd : b.cs
    if (!dk || dk < from || dk > to) continue
    const name = kind === 'setter' ? b.s : b.o
    if (!name) continue
    let m = map[name]
    if (!m) m = map[name] = { name, bookings: 0, shown: 0, qual: 0, closed: 0, cash: 0, fees: 0 }
    m.bookings++
    if (b.cash > 0) m.closed++
    m.cash += b.cash
    m.fees += b.fees
    if (SHOWN.has(b.st)) m.shown++
    if (QSET.has(b.st)) m.qual++
  }
  const names = Object.keys(map).sort(
    (a, b) => map[b].cash - map[a].cash || map[b].bookings - map[a].bookings,
  )
  const tot: Person = { name: 'Team', bookings: 0, shown: 0, qual: 0, closed: 0, cash: 0, fees: 0 }
  const keys = ['bookings', 'shown', 'qual', 'closed', 'cash', 'fees'] as const
  names.forEach(n => { for (const k of keys) tot[k] += map[n][k] })
  return { map, names, tot }
}

export interface Series { keys: string[]; cash: number[]; book: number[]; daily: boolean }

// VERBATIM PORT of series (L260-267). Returns raw bucket KEYS ('YYYY-MM-DD' when
// daily, 'YYYY-MM' when monthly); label formatting (fmtDay/fmtMo) stays in the
// frontend. daily = span <= 92 days, exactly as the prototype.
export function series(
  BK: Rec[], kind: 'closer' | 'setter', name: string | null,
  from: string, to: string, basis: 'call' | 'book',
): Series {
  const span = daysBetween(from, to) + 1, daily = span <= 92
  const order: string[] = [], idx: Record<string, number> = {}
  if (daily) {
    for (let s = from; s <= to; s = addDays(s, 1)) { idx[s] = order.length; order.push(s) }
  } else {
    let s = from.slice(0, 7)
    const e = to.slice(0, 7)
    let guard = 0
    while (s <= e && guard++ < 200) {
      idx[s] = order.length; order.push(s)
      const d = parseD(s + '-01'); d.setUTCMonth(d.getUTCMonth() + 1); s = isoD(d).slice(0, 7)
    }
  }
  const cash = new Array(order.length).fill(0), book = new Array(order.length).fill(0)
  for (const b of BK) {
    const dk = basis === 'book' ? b.bd : b.cs
    if (!dk || dk < from || dk > to) continue
    const nm = kind === 'setter' ? b.s : b.o
    if (name && nm !== name) continue
    if (!nm) continue
    const key = daily ? dk : dk.slice(0, 7)
    const i = idx[key]
    if (i == null) continue
    cash[i] += b.cash; book[i]++
  }
  return { keys: order, cash, book, daily }
}

// VERBATIM PORT of statusMix (L268-271). Returns the person's top-6 lead-status
// counts, descending; the PALETTE colour assignment stays in the frontend.
export function statusMix(
  BK: Rec[], kind: 'closer' | 'setter', name: string,
  from: string, to: string, basis: 'call' | 'book',
): Array<[string, number]> {
  const cnt: Record<string, number> = {}
  for (const b of BK) {
    const dk = basis === 'book' ? b.bd : b.cs
    if (!dk || dk < from || dk > to) continue
    const nm = kind === 'setter' ? b.s : b.o
    if (nm !== name) continue
    const s = b.st || '(blank)'
    cnt[s] = (cnt[s] || 0) + 1
  }
  return Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 6)
}
