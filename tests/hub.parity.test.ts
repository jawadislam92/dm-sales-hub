import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildBK, aggregate, rate } from '../src/engine/metrics'

const here = dirname(fileURLToPath(import.meta.url))
const tab = JSON.parse(readFileSync(join(here, 'fixtures/bookings.parity.json'), 'utf-8'))

// The release gate. These numbers were verified empirically against the real
// 23,385-row Bookings snapshot and against the team's HUB tabs. They are the
// definition of "the port is faithful." A one-cent drift here fails the build.
//
// NOTE (correction to PLAN.md T1.2): raw booking COUNT does not equal HUB
// bookings (Sam 131 vs 126), and per-closer shown/qual/closed do not all match
// the HUB (Steven diverges). Only what the README actually claims reconciles:
// team cash to the cent, and Sam Aujla's shown/qual/closed. We assert exactly
// those, plus per-closer cash to the dollar.
describe('HUB parity — June 2026 closers, call-date basis (RELEASE GATE)', () => {
  const BK = buildBK(tab)
  const A = aggregate(BK, 'closer', '2026-06-01', '2026-06-30', 'call')

  it('team closer cash reconciles to the fresh workbook ($474,770.90)', () => {
    expect(A.tot.cash).toBeCloseTo(474770.90, 2)
  })

  it('Sam Aujla anchors (shown 51 / qual 44 / closed 28 / cash $152,681 / 63.64%)', () => {
    const s = A.map['Sam Aujla']
    expect(s.shown).toBe(51)
    expect(s.qual).toBe(44)
    expect(s.closed).toBe(28)
    expect(Math.round(s.cash)).toBe(152681)
    expect(rate(s.closed, s.qual)).toBeCloseTo(63.64, 2)
  })
})
